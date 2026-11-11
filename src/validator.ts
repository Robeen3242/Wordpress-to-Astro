/**
 * WordPress-to-Astro visual validator.
 *
 * Usage (from converter repository root, while the Astro dev server is running):
 *   node dist/validator.js "output/<capture-folder>" http://localhost:4321
 *
 * Uses only Playwright, which the extractor already uses. It does not require
 * pixelmatch, pngjs, or other new npm packages.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";

export interface ViewportSpec {
  name: "desktop" | "mobile";
  width: number;
  height: number;
}

export interface VisualResult {
  viewport: ViewportSpec;
  reference: string;
  actual: string;
  difference: string;
  referenceSize: { width: number; height: number };
  actualSize: { width: number; height: number };
  comparedPixels: number;
  differentPixels: number;
  differentPercent: number;
  meanAbsoluteChannelError: number;
  heightDifference: number;
  warnings: string[];
}

export interface ValidationReport {
  schemaVersion: 1;
  targetUrl: string;
  extractionFolder: string;
  generatedAt: string;
  pixelThreshold: number;
  results: VisualResult[];
  notes: string[];
}

export const VIEWPORTS: readonly ViewportSpec[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Color-channel difference >= this amount (out of 255) marks a changed pixel. */
export const PIXEL_THRESHOLD = 20;

export function validateUrl(value: string): string {
  const parsed = new URL(value);
  if (!(["http:", "https:"].includes(parsed.protocol))) {
    throw new Error("Target must be an http:// or https:// URL");
  }
  return parsed.toString();
}

async function waitUntilReady(page: Page): Promise<void> {
  // Font availability is important for comparison (especially headline wrapping).
  await page.evaluate(async () => {
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  });
}

interface BrowserComparison {
  referenceWidth: number;
  referenceHeight: number;
  actualWidth: number;
  actualHeight: number;
  pixels: number;
  differentPixels: number;
  totalChannelDifference: number;
  diffBase64: string;
}

/**
 * Decode PNGs using the same Chromium version as Playwright and compare them
 * at native resolution. Missing canvas area is padded white; this ensures
 * changed page heights contribute to the reported difference.
 */
async function comparePngs(
  page: Page,
  referencePng: Buffer,
  actualPng: Buffer,
  threshold: number,
): Promise<BrowserComparison> {
  return page.evaluate(
    async ({ referenceBase64, actualBase64, threshold }: { referenceBase64: string; actualBase64: string; threshold: number }) => {
      const decode = async (base64: string): Promise<HTMLImageElement> => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        return image;
      };
      const [referenceImage, actualImage] = await Promise.all([
        decode(referenceBase64),
        decode(actualBase64),
      ]);
      const width = Math.max(referenceImage.naturalWidth, actualImage.naturalWidth);
      const height = Math.max(referenceImage.naturalHeight, actualImage.naturalHeight);

      const pixelsOf = (image: HTMLImageElement): Uint8ClampedArray => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas 2D context unavailable");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const ref = pixelsOf(referenceImage);
      const actual = pixelsOf(actualImage);
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = width;
      diffCanvas.height = height;
      const ctx = diffCanvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      const diffImage = ctx.createImageData(width, height);
      const out = diffImage.data;
      let differentPixels = 0;
      let totalChannelDifference = 0;

      // Compare RGB. Both images are flattened on white before reading pixels.
      for (let index = 0; index < ref.length; index += 4) {
        const r = Math.abs(ref[index]! - actual[index]!);
        const g = Math.abs(ref[index + 1]! - actual[index + 1]!);
        const b = Math.abs(ref[index + 2]! - actual[index + 2]!);
        totalChannelDifference += r + g + b;
        const changed = Math.max(r, g, b) >= threshold;
        if (changed) differentPixels++;
        if (changed) {
          out[index] = 255;
          out[index + 1] = 0;
          out[index + 2] = 160;
        } else {
          // Faint original provides location/context without hiding changes.
          out[index] = Math.round(ref[index]! * 0.22 + 255 * 0.78);
          out[index + 1] = Math.round(ref[index + 1]! * 0.22 + 255 * 0.78);
          out[index + 2] = Math.round(ref[index + 2]! * 0.22 + 255 * 0.78);
        }
        out[index + 3] = 255;
      }
      ctx.putImageData(diffImage, 0, 0);
      return {
        referenceWidth: referenceImage.naturalWidth,
        referenceHeight: referenceImage.naturalHeight,
        actualWidth: actualImage.naturalWidth,
        actualHeight: actualImage.naturalHeight,
        pixels: width * height,
        differentPixels,
        totalChannelDifference,
        diffBase64: diffCanvas.toDataURL("image/png").split(",")[1]!,
      };
    },
    {
      referenceBase64: referencePng.toString("base64"),
      actualBase64: actualPng.toString("base64"),
      threshold,
    },
  );
}

export async function validateAstro(
  extractionFolder: string,
  targetUrl = "http://localhost:4321/",
  outputFolder = path.join(extractionFolder, "validation"),
): Promise<ValidationReport> {
  const sourceDir = path.resolve(extractionFolder);
  if (await fs.access(path.join(sourceDir, "site-manifest.json")).then(() => true, () => false)) {
    throw new Error("For a site manifest, use validateSite() or the validator CLI, not validateAstro().");
  }
  const destination = path.resolve(outputFolder);
  const url = validateUrl(targetUrl);
  await fs.mkdir(destination, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results: VisualResult[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      const reference = path.join(sourceDir, `${viewport.name}.png`);
      const actual = path.join(destination, `${viewport.name}-astro.png`);
      const difference = path.join(destination, `${viewport.name}-diff.png`);
      let original: Buffer;
      try {
        original = await fs.readFile(reference);
      } catch {
        throw new Error(`Missing original screenshot: ${reference}. Run extraction first.`);
      }

      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        colorScheme: "light",
        locale: "en-US",
      });
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        await waitUntilReady(page);
        const actualPng = await page.screenshot({
          path: actual,
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          type: "png",
        });
        const comparison = await comparePngs(page, original, actualPng, PIXEL_THRESHOLD);
        await fs.writeFile(difference, Buffer.from(comparison.diffBase64, "base64"));
        const warnings: string[] = [];
        if (comparison.referenceWidth !== comparison.actualWidth) {
          warnings.push("Captured image widths differ. Check viewport/device scale.");
        }
        if (comparison.referenceHeight !== comparison.actualHeight) {
          warnings.push("Document heights differ; missing or added sections may be present.");
        }
        const percent = (comparison.differentPixels / comparison.pixels) * 100;
        results.push({
          viewport,
          reference,
          actual,
          difference,
          referenceSize: { width: comparison.referenceWidth, height: comparison.referenceHeight },
          actualSize: { width: comparison.actualWidth, height: comparison.actualHeight },
          comparedPixels: comparison.pixels,
          differentPixels: comparison.differentPixels,
          differentPercent: Number(percent.toFixed(2)),
          meanAbsoluteChannelError: Number(
            (comparison.totalChannelDifference / (comparison.pixels * 3)).toFixed(2),
          ),
          heightDifference: comparison.actualHeight - comparison.referenceHeight,
          warnings,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const report: ValidationReport = {
    schemaVersion: 1,
    targetUrl: url,
    extractionFolder: sourceDir,
    generatedAt: new Date().toISOString(),
    pixelThreshold: PIXEL_THRESHOLD,
    results,
    notes: [
      "Magenta in *-diff.png marks pixels whose maximum RGB channel difference is >= 20.",
      "Page-height differences are included by padding the shorter image with white.",
      "Metrics are raw screenshot differences, not a semantic/quality score.",
      "Font rendering, browser version, dynamic content, and animations affect results.",
      "This is a single top-of-page state comparison, not interactive/scroll-state validation.",
    ],
  };
  const reportPath = path.join(destination, "validation-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}

export async function validateSite(extractionFolder: string, targetUrl = "http://localhost:4321/"): Promise<{
  pages: Array<{ route: string; sourceUrl: string; report: ValidationReport }>;
  warnings: string[];
}> {
  const dir = path.resolve(extractionFolder);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "site-manifest.json"), "utf8")) as {
    schemaVersion: number; pages: Array<{ folder: string; route: string; sourceUrl: string }>;
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages)) throw new Error("Invalid site manifest");
  const output: { pages: Array<{ route: string; sourceUrl: string; report: ValidationReport }>; warnings: string[] } = {
    pages: [], warnings: [],
  };
  for (const page of manifest.pages) {
    if (!/^pages\/\d{3}$/.test(page.folder) || !page.route.startsWith('/') || page.route.includes('..'))
      throw new Error('Invalid site page path');
    const url = new URL(page.route, validateUrl(targetUrl)).toString();
    try {
      const report = await validateAstro(path.join(dir, page.folder), url);
      output.pages.push({ route: page.route, sourceUrl: page.sourceUrl, report });
    } catch (error) { output.warnings.push(`Could not validate ${page.route}: ${String(error)}`); }
  }
  await fs.writeFile(path.join(dir, 'site-validation-report.json'), JSON.stringify(output, null, 2) + '\n');
  return output;
}

function awaitableSite(folder: string): boolean {
  // Synchronous check only for choosing CLI mode; API callers use validateSite explicitly.
  return existsSync(path.join(path.resolve(folder), 'site-manifest.json'));
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  return !!script && import.meta.url === pathToFileURL(path.resolve(script)).href;
}

if (invokedDirectly()) {
  const [, , extractionFolder, targetUrl, outputFolder] = process.argv;
  if (!extractionFolder) {
    console.error(
      'Usage: node dist/validator.js "output/<extraction-folder>" [http://localhost:4321] [output-folder]',
    );
    process.exitCode = 1;
  } else {
    (awaitableSite(extractionFolder) ? validateSite(extractionFolder, targetUrl).then(report => {
      console.log(`Validated ${report.pages.length} pages; ${report.warnings.length} warnings.`);
      report.warnings.forEach(w => console.warn(w));
    }) : validateAstro(extractionFolder, targetUrl, outputFolder)
      .then((report) => {
        console.log(`Validation directory: ${path.resolve(outputFolder ?? path.join(extractionFolder, "validation"))}`);
        for (const item of report.results) {
          console.log(
            `${item.viewport.name}: ${item.differentPercent.toFixed(2)}% differing pixels; ` +
            `mean RGB error ${item.meanAbsoluteChannelError.toFixed(2)}/255; ` +
            `height difference ${item.heightDifference > 0 ? "+" : ""}${item.heightDifference}px`,
          );
          for (const warning of item.warnings) console.warn(`  Warning: ${warning}`);
        }
        console.log("Saved screenshots, diff images, and validation-report.json");
      }))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
