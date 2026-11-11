
import { chromium, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type AssetRecord = {
  url: string;
  file: string;
  contentType: string;
  bytes: number;
};

type PageRecord = {
  viewport: string;
  title: string;
  finalUrl: string;
  elementCount: number;
  htmlPath: string;
  screenshotPath: string;
  dataPath: string;
};

type ExtractionResult = {
  sourceUrl: string;
  outputDirectory: string;
  reportPath: string;
  pages: PageRecord[];
  assetsSaved: number;
  warnings: string[];
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_ELEMENTS = 15000;

function safeName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80);
}

function assetExtension(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();

  const extensions: Record<string, string> = {
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/font-woff": ".woff",
    "video/mp4": ".mp4",
  };

  return extensions[type] || ".bin";
}

async function loadLazyContent(page: Page) {
  // Scroll down gradually to trigger common lazy-loaded content.
  await page.evaluate(async () => {
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const step = Math.max(window.innerHeight * 0.8, 400);
    const maxSteps = 100;

    for (let i = 0; i < maxSteps; i++) {
      const bottom =
        document.documentElement.scrollHeight -
        window.innerHeight;

      if (window.scrollY >= bottom) break;

      window.scrollBy(0, step);
      await delay(120);
    }

    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(700);

  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function extractPageData(page: Page) {
  //captures style rather than css declarations to support cascading rules
  return page.evaluate((maxElements) => {
    const cssProperties = [
      "display",
      "position",
      "visibility",
      "opacity",
      "width",
      "height",
      "max-width",
      "min-height",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "color",
      "background-color",
      "background-image",
      "background-size",
      "background-position",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "line-height",
      "letter-spacing",
      "text-align",
      "text-transform",
      "border",
      "border-radius",
      "box-shadow",
      "object-fit",
      "object-position",
      "transform",
      "transition",
      "animation",
      "z-index",
      "flex-direction",
      "justify-content",
      "align-items",
      "grid-template-columns",
    ];
    // Max is 15000 elements but there is no algorithm to determine whats important
    // so its first come first serve
    const elements = Array.from(
      document.querySelectorAll("*")
    ).slice(0, maxElements);

    const elementData = elements.map((element, index) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      const computedStyles: Record<string, string> = {};

      for (const property of cssProperties) {
        computedStyles[property] =
          style.getPropertyValue(property);
      }

      const attributes: Record<string, string> = {};

      for (const attribute of Array.from(element.attributes)) {
        attributes[attribute.name] = attribute.value;
      }

      // An element's direct text, excluding child element text.
      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .trim();

      const parentIndex = element.parentElement
        ? elements.indexOf(element.parentElement)
        : -1;

      return {
        id: index,
        parentIndex,
        tag: element.tagName.toLowerCase(),
        attributes,
        text: directText,
        rectangle: {
          x: rect.x,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        },
        computedStyles,
        pseudoElements: {
          before: {
            content: getComputedStyle(element, "::before").content,
          },
          after: {
            content: getComputedStyle(element, "::after").content,
          },
        },
      };
    });

    const images = Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src,
      alt: img.alt,
      width: img.naturalWidth,
      height: img.naturalHeight,
      loaded: img.complete && img.naturalWidth > 0,
      srcset: img.srcset,
      sizes: img.sizes,
    }));

    const links = Array.from(document.querySelectorAll("a")).map(
      (link) => ({
        text: link.textContent?.trim() || "",
        href: link.href,
      })
    );

    const headings = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6")
    ).map((heading) => ({
      level: heading.tagName.toLowerCase(),
      text: heading.textContent?.trim() || "",
    }));

    const stylesheets = Array.from(
      document.querySelectorAll<HTMLLinkElement>(
        'link[rel~="stylesheet"]'
      )
    ).map((link) => link.href);

    const inlineStyles = Array.from(
      document.querySelectorAll("style")
    ).map((style) => style.textContent || "");

    const fonts = Array.from(
      new Set(
        elements.map((element) =>
          getComputedStyle(element).fontFamily
        )
      )
    );

    const backgroundImages = elements
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.getAttribute("class"),
        backgroundImage:
          getComputedStyle(element).backgroundImage,
      }))
      .filter(
        (item) => item.backgroundImage !== "none"
      );

    return {
      url: location.href,
      title: document.title,
      description:
        document.querySelector<HTMLMetaElement>(
          'meta[name="description"]'
        )?.content || "",
      language: document.documentElement.lang,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
      },
      totalElementCount:
        document.querySelectorAll("*").length,
      extractedElementCount: elementData.length,
      elements: elementData,
      images,
      links,
      headings,
      stylesheets,
      inlineStyles,
      fonts,
      backgroundImages,
    };
  }, MAX_ELEMENTS);
}

export async function extractWebsite(
  sourceUrl: string,
  specifiedOutputDirectory?: string
): Promise<ExtractionResult> {
  const source = new URL(sourceUrl);

  if (!["https:", "http:"].includes(source.protocol)) {
    throw new Error("Unsupported URL protocol.");
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const folderName =
    `${safeName(source.hostname)}-${timestamp}`;

  const outputDirectory = specifiedOutputDirectory ?? path.resolve(
    "output",
    folderName
  );

  const assetsDirectory = path.join(
    outputDirectory,
    "assets"
  );

  await fs.mkdir(assetsDirectory, { recursive: true });

  const warnings: string[] = [];
  const assets: AssetRecord[] = [];
  const pages: PageRecord[] = [];

  const downloadedUrls = new Set<string>();
  const pendingDownloads: Promise<void>[] = [];

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    for (const viewport of VIEWPORTS) {
      console.log(
        `Capturing ${viewport.name} (${viewport.width}px)`
      );

      const context = await browser.newContext({
        viewport: {
          width: viewport.width,
          height: viewport.height,
        },
        deviceScaleFactor: 1,
        serviceWorkers: "block",
      });

      const page = await context.newPage();

      // Record browser network failures.
      page.on("requestfailed", (request) => {
        warnings.push(
          `[${viewport.name}] Request failed: ` +
          `${request.url()} — ` +
          `${request.failure()?.errorText || "unknown"}`
        );
      });

      page.on("pageerror", (error) => {
        warnings.push(
          `[${viewport.name}] Page error: ${error.message}`
        );
      });

      // Capture resources loaded by the browser.
      page.on("response", (response) => {
        const task = (async () => {
          const request = response.request();
          const resourceType = request.resourceType();
          const url = response.url();

          if (![
            "image",
            "stylesheet",
            "font",
            "media",
          ].includes(resourceType)) {
            return;
          }

          if (downloadedUrls.has(url)) return;

          if (!response.ok()) {
            warnings.push(
              `HTTP ${response.status()}: ${url}`
            );
            return;
          }

          downloadedUrls.add(url);

          try {
            await response.finished();

            const body = await response.body();

            if (body.length > MAX_ASSET_BYTES) {
              warnings.push(
                `Asset too large, skipped: ${url}`
              );
              return;
            }

            const contentType =
              response.headers()["content-type"] ||
              "application/octet-stream";

            const hash = createHash("sha256")
              .update(url)
              .digest("hex")
              .slice(0, 20);

            const extension =
              assetExtension(contentType);

            const relativeFile =
              `assets/${resourceType}/${hash}${extension}`;

            const absoluteFile = path.join(
              outputDirectory,
              relativeFile
            );

            await fs.mkdir(
              path.dirname(absoluteFile),
              { recursive: true }
            );

            await fs.writeFile(absoluteFile, body);

            assets.push({
              url,
              file: relativeFile,
              contentType,
              bytes: body.length,
            });
          } catch (error) {
            warnings.push(
              `Could not save ${url}: ${String(error)}`
            );
          }
        })();

        pendingDownloads.push(task);
      });

      try {
        const response = await page.goto(sourceUrl, {
          waitUntil: "load",
          timeout: 45000,
        });

        if (!response || !response.ok()) {
          warnings.push(
            `Navigation issue at ${viewport.name}: ` +
            `${response?.status() ?? "no response"}`
          );
        }

        await loadLazyContent(page);

        // ISSUE: Waits for promises upon invoking, there may be additional invocations
        await Promise.all(pendingDownloads);

        const data = await extractPageData(page);
        const html = await page.content();

        const prefix = viewport.name;

        const htmlPath = path.join(
          outputDirectory,
          `${prefix}.html`
        );

        const screenshotPath = path.join(
          outputDirectory,
          `${prefix}.png`
        );

        const dataPath = path.join(
          outputDirectory,
          `${prefix}-data.json`
        );

        await fs.writeFile(
          htmlPath,
          html,
          "utf-8"
        );

        await fs.writeFile(
          dataPath,
          JSON.stringify(data, null, 2),
          "utf-8"
        );

        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
          animations: "disabled",
          timeout: 60000,
        });

        pages.push({
          viewport: prefix,
          title: data.title,
          finalUrl: page.url(),
          elementCount: data.extractedElementCount,
          htmlPath,
          screenshotPath,
          dataPath,
        });

        if (
          data.totalElementCount >
          data.extractedElementCount
        ) {
          warnings.push(
            `${prefix}: Element limit reached. ` +
            `${data.totalElementCount} total, ` +
            `${data.extractedElementCount} recorded.`
          );
        }

        for (const image of data.images) {
          if (!image.loaded) {
            warnings.push(
              `${prefix}: Image not loaded: ${image.src}`
            );
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  await Promise.all(pendingDownloads);

  const reportPath = path.join(
    outputDirectory,
    "report.json"
  );

  const report = {
    sourceUrl,
    extractedAt: new Date().toISOString(),
    pages,
    assets,
    assetsSaved: assets.length,
    warnings,
  };

  await fs.writeFile(
    reportPath,
    JSON.stringify(report, null, 2),
    "utf-8"
  );

  return {
    sourceUrl,
    outputDirectory,
    reportPath,
    pages,
    assetsSaved: assets.length,
    warnings,
  };
}
