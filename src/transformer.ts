/**
 * Transformation milestone: extractor JSON -> neutral, inspectable page IR.
 * No changes to extraction and no Astro code generation in this module.
 *
 * Usage (after compiling with your existing TypeScript build):
 *   node dist/transformer.js "output/<extraction-folder>"
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Box = { x: number; y: number; width: number; height: number };
type RawElement = {
  id: number;
  parentIndex: number;
  tag: string;
  attributes: Record<string, string>;
  text: string;
  rectangle: Box;
  computedStyles: Record<string, string>;
  pseudoElements?: { before?: { content: string }; after?: { content: string } };
};
type Capture = {
  url: string;
  title: string;
  description: string;
  language: string;
  viewport: { width: number; height: number; documentWidth: number; documentHeight: number };
  totalElementCount: number;
  extractedElementCount: number;
  elements: RawElement[];
  images: Array<{ src: string; alt: string; width: number; height: number; loaded: boolean; srcset?: string; sizes?: string }>;
  headings: Array<{ level: string; text: string }>;
  links: Array<{ text: string; href: string }>;
  fonts: string[];
  inlineStyles?: string[];
};
type AssetRecord = { url: string; file: string; contentType: string; bytes: number };
type ExtractionReport = { assets?: AssetRecord[]; warnings?: string[] };

export type VisualSnapshot = { box: Box; styles: Record<string, string>; visible: boolean };
export type IRNode = {
  id: number;
  tag: string;
  attributes: Record<string, string>;
  text: string; // Direct text only; concatenate descendants when displaying a subtree.
  desktop: VisualSnapshot;
  mobile?: VisualSnapshot;
  children: IRNode[];
};
export type IRSection = {
  kind: "header" | "mobile-navigation" | "hero" | "content" | "footer" | "other";
  label: string;
  root: IRNode;
};
/**
 * Candidates are *not* approved components. They are evidence for human review.
 * The generator must not extract a component unless approved explicitly.
 */
export type ComponentCandidate = {
  signature: string;
  rootTag: string;
  occurrences: number;
  nodeIds: number[];
  sectionLabels: string[];
  reason: string;
  status: "pending-review";
};

export type ModularizationPolicy = {
  mode: "strict-hybrid";
  minimumOccurrences: 3;
  autoApprove: false;
  nativeTextElements: "use-css-not-components";
};

export type PageIR = {
  schemaVersion: 1;
  sourceUrl: string;
  metadata: { title: string; description: string; language: string };
  viewports: { desktop: Capture["viewport"]; mobile?: Capture["viewport"] };
  sections: IRSection[];
  theme: { bodyClass: string; css: string };
  modularization: { policy: ModularizationPolicy; candidates: ComponentCandidate[] };
  assets: Array<AssetRecord & { publicPath: string }>;
  references: { images: Capture["images"]; headings: Capture["headings"]; links: Capture["links"]; fonts: string[] };
  warnings: string[];
};

const SKIPPED_TAGS = new Set(["script", "style", "noscript", "template"]);
const SKIPPED_CLASSES = ["a11y-speak-", "grecaptcha-badge"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCapture(value: unknown, filename: string): asserts value is Capture {
  if (!isRecord(value) || !Array.isArray(value.elements) ||
      typeof value.url !== "string" || typeof value.title !== "string" ||
      !isRecord(value.viewport)) {
    throw new Error(`Invalid capture: ${filename}`);
  }
  for (const [index, element] of value.elements.entries()) {
    if (!isRecord(element) || element.id !== index ||
        typeof element.parentIndex !== "number" ||
        element.parentIndex >= index || element.parentIndex < -1 ||
        typeof element.tag !== "string" || !isRecord(element.attributes) ||
        !isRecord(element.rectangle) || !isRecord(element.computedStyles) ||
        typeof element.text !== "string") {
      throw new Error(`Invalid or non-preorder element at index ${index} in ${filename}`);
    }
  }
  if (!Array.isArray(value.images) || !Array.isArray(value.headings) ||
      !Array.isArray(value.links) || !Array.isArray(value.fonts)) {
    throw new Error(`Missing reference arrays in ${filename}`);
  }
}

function visual(element: RawElement): VisualSnapshot {
  const s = element.computedStyles;
  const b = element.rectangle;
  return {
    box: b,
    styles: s,
    visible: s.display !== "none" && s.visibility !== "hidden" &&
      s.visibility !== "collapse" && s.opacity !== "0" && b.width > 0 && b.height > 0,
  };
}

function shouldSkip(element: RawElement): boolean {
  //currently skips a node and all its children
  if (SKIPPED_TAGS.has(element.tag)) return true;
  const className = element.attributes.class ?? "";
  const id = element.attributes.id ?? "";
  return SKIPPED_CLASSES.some((token) => className.includes(token) || id.includes(token));
}

function classify(element: RawElement): IRSection["kind"] {
  //prioritizes html tags over css class names
  const c = `${element.attributes.class ?? ""} ${element.attributes.id ?? ""}`.toLowerCase();
  if (element.tag === "header") return "header";
  if (element.tag === "footer") return "footer";
  if (c.includes("mobile-nav")) return "mobile-navigation";
  if (c.includes("hero")) return "hero";
  if (c.includes("content")) return "content";
  return "other";
}

function label(element: RawElement, kind: IRSection["kind"]): string {
  const distinctive = element.attributes.id ||
    element.attributes.class?.split(/\s+/).find((c) => c.startsWith("block-"));
  return distinctive || kind;
}

function sameStructure(desktop: Capture, mobile: Capture): boolean {
  return desktop.elements.length === mobile.elements.length &&
    desktop.elements.every((element, i) =>
      element.tag === mobile.elements[i].tag &&
      element.parentIndex === mobile.elements[i].parentIndex);
}

const NATIVE_TEXT_TAGS = new Set([
  "p", "span", "strong", "em", "b", "i", "small", "label", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "a",
]);
const REUSABLE_ROOT_TAGS = new Set([
  "article", "aside", "div", "figure", "li", "section", "ul", "ol",
]);
const MIN_OCCURRENCES = 3 as const;

/** A structural fingerprint deliberately excludes content, class names and colours. */
function structuralSignature(node: IRNode): string {
  return `${node.tag}(${node.children.map(structuralSignature).join(",")})`;
}

function sizeOfTree(node: IRNode): number {
  return 1 + node.children.reduce((total, child) => total + sizeOfTree(child), 0);
}

/** Reject different layout mechanisms, while preserving exact values for the generator. */
function layoutSignature(node: IRNode): string {
  const desktop = node.desktop.styles;
  const mobile = node.mobile?.styles;
  return [
    desktop.display, desktop.position, desktop["flex-direction"], desktop["grid-template-columns"] === "none" ? "no-grid" : "grid",
    mobile?.display ?? "unknown", mobile?.position ?? "unknown", mobile?.["flex-direction"] ?? "unknown",
    mobile?.["grid-template-columns"] === "none" ? "no-grid" : mobile ? "grid" : "unknown",
  ].join("|");
}

/**
 * Conservative pattern discovery. It reports candidate occurrences; it does not
 * rewrite trees or make an Astro decision. Similarity is heuristic, not proof.
 */
export function findComponentCandidates(sections: IRSection[]): ComponentCandidate[] {
  const grouped = new Map<string, Array<{ node: IRNode; sectionLabel: string }>>();
  const visit = (node: IRNode, sectionLabel: string) => {
    if (REUSABLE_ROOT_TAGS.has(node.tag) && !NATIVE_TEXT_TAGS.has(node.tag) &&
        sizeOfTree(node) >= 4 && node.children.length >= 2 &&
        node.desktop.visible) {
      const signature = structuralSignature(node);
      const key = `${signature}@@${layoutSignature(node)}`;
      const items = grouped.get(key) ?? [];
      items.push({ node, sectionLabel });
      grouped.set(key, items);
    }
    for (const child of node.children) visit(child, sectionLabel);
  };
  for (const section of sections) visit(section.root, section.label);

  return [...grouped.values()]
    .filter((items) => items.length >= MIN_OCCURRENCES)
    .map((items) => ({
      signature: structuralSignature(items[0].node),
      rootTag: items[0].node.tag,
      occurrences: items.length,
      nodeIds: items.map(({ node }) => node.id),
      sectionLabels: [...new Set(items.map(({ sectionLabel }) => sectionLabel))],
      reason: `At least ${MIN_OCCURRENCES} instances share the exact tag hierarchy and root desktop/mobile layout modes; semantic equivalence and detailed visual compatibility still require approval.`,
      status: "pending-review" as const,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.nodeIds[0] - b.nodeIds[0]);
}

export function transformCaptures(desktop: Capture, mobile?: Capture, report?: ExtractionReport): PageIR {
  validateCapture(desktop, "desktop-data.json");
  if (mobile) validateCapture(mobile, "mobile-data.json");

  const warnings: string[] = [];
  const alignedMobile = mobile && sameStructure(desktop, mobile) ? mobile : undefined;
  if (mobile && !alignedMobile) {
    warnings.push("Desktop and mobile DOM trees differ. Mobile element snapshots were not attached; review manually.");
  }
  if (desktop.totalElementCount > desktop.extractedElementCount) {
    warnings.push("Desktop DOM capture was truncated by the extractor's element limit.");
  }
  if (mobile && mobile.totalElementCount > mobile.extractedElementCount) {
    warnings.push("Mobile DOM capture was truncated by the extractor's element limit.");
  }

  const byId = new Map<number, IRNode>();
  const children = new Map<number, RawElement[]>();
  for (const raw of desktop.elements) {
    if (!children.has(raw.parentIndex)) children.set(raw.parentIndex, []);
    children.get(raw.parentIndex)!.push(raw);
  }

  const makeNode = (raw: RawElement): IRNode | undefined => {
    //recursive children creation


    if (shouldSkip(raw)) return undefined;
    const node: IRNode = {
      id: raw.id,
      tag: raw.tag,
      attributes: raw.attributes,
      text: raw.text,
      desktop: visual(raw),
      ...(alignedMobile ? { mobile: visual(alignedMobile.elements[raw.id]) } : {}),
      children: [],
    };
    byId.set(raw.id, node);
    for (const child of children.get(raw.id) || []) {
      const nested = makeNode(child);
      if (nested) node.children.push(nested);
    }
    return node;
  };

  const body = desktop.elements.find((element) => element.tag === "body");
  if (!body) throw new Error("Capture has no <body> element.");
  const sections: IRSection[] = [];
  const addSection = (raw: RawElement) => {
    const root = makeNode(raw);
    if (!root) return;
    const kind = classify(raw);
    sections.push({ kind, label: label(raw, kind), root });
  };

  for (const raw of children.get(body.id) || []) {
    if (raw.tag === "script" || shouldSkip(raw)) continue;
    // Content wrapper is structural, not a visual section. Split into its section children.
    if (raw.attributes.id === "content") {
      for (const contentChild of children.get(raw.id) || []) addSection(contentChild);
    } else {
      addSection(raw);
    }
  }

  const assets = (report?.assets || []).map((asset) => ({
    ...asset,
    // These are *proposed* Astro public paths. Generator will copy files later.
    publicPath: `/assets/${asset.file.replace(/^assets\//, "")}`,
  }));
  if (!report?.assets) warnings.push("No report asset manifest supplied; local asset mapping is incomplete.");
  if (!sections.some((section) => section.kind === "hero")) warnings.push("No hero section identified by the initial rules.");
  if (!sections.some((section) => section.kind === "footer")) warnings.push("No footer section identified.");

  return {
    schemaVersion: 1,
    sourceUrl: desktop.url,
    metadata: { title: desktop.title, description: desktop.description, language: desktop.language },
    viewports: { desktop: desktop.viewport, ...(mobile ? { mobile: mobile.viewport } : {}) },
    sections,
    // Original WP theme variables were declared in an inline stylesheet and
    // scoped to the body class. Preserve both for accurate generated CSS.
    theme: {
      bodyClass: body.attributes.class || "",
      css: (desktop.inlineStyles || []).filter((css) => /\.cellar-theme\s*\{/.test(css)).join("\n"),
    },
    modularization: {
      policy: {
        mode: "strict-hybrid",
        minimumOccurrences: MIN_OCCURRENCES,
        autoApprove: false,
        nativeTextElements: "use-css-not-components",
      },
      candidates: findComponentCandidates(sections),
    },
    assets,
    references: { images: desktop.images, headings: desktop.headings, links: desktop.links, fonts: desktop.fonts },
    warnings,
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

export async function transformExtractionFolder(folder: string): Promise<{ ir: PageIR; outputFile: string }> {
  const directory = path.resolve(folder);
  const desktop = await readJson(path.join(directory, "desktop-data.json"));
  const mobileFile = path.join(directory, "mobile-data.json");
  const reportFile = path.join(directory, "report.json");
  const mobile = await fs.access(mobileFile).then(() => readJson(mobileFile), () => undefined);
  const report = await fs.access(reportFile).then(() => readJson(reportFile), () => undefined);
  // Runtime shape checking happens in transformCaptures().
  const ir = transformCaptures(desktop as Capture, mobile as Capture | undefined, report as ExtractionReport | undefined);
  const outputFile = path.join(directory, "page-ir.json");
  await fs.writeFile(outputFile, JSON.stringify(ir, null, 2) + "\n", "utf8");
  return { ir, outputFile };
}

export async function transformSiteFolder(folder: string): Promise<{ pages: number; files: string[] }> {
  const directory = path.resolve(folder);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "site-manifest.json"), "utf8")) as {
    schemaVersion: number; pages: Array<{ folder: string }>;
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages)) throw new Error("Invalid site manifest");
  const files: string[] = [];
  for (const page of manifest.pages) {
    if (!/^pages\/\d{3}$/.test(page.folder)) throw new Error("Unsafe page folder in site manifest");
    const result = await transformExtractionFolder(path.join(directory, page.folder));
    files.push(result.outputFile);
  }
  return { pages: manifest.pages.length, files };
}

// Allows `node dist/transformer.js <folder>` without changing src/index.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: node dist/transformer.js <extraction-folder>");
    process.exitCode = 1;
  } else {
    fs.access(path.join(path.resolve(folder), "site-manifest.json"))
      .then(() => transformSiteFolder(folder).then(({ pages, files }) => console.log(`Transformed ${pages} pages: ${files.length} IR files`)),
        () => transformExtractionFolder(folder).then(({ ir, outputFile }) => {
          console.log(`Wrote: ${outputFile}`);
          console.log(`Sections: ${ir.sections.map((section) => section.label).join(", ")}`);
          console.log(`Assets mapped: ${ir.assets.length}`);
          console.log(`Component candidates (pending approval): ${ir.modularization.candidates.length}`);
          for (const warning of ir.warnings) console.warn(`WARNING: ${warning}`);
        }))
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
