/**
 * Generation milestone: page-ir.json -> standalone static Astro homepage.
 *
 * Policy: strict hybrid (n=3), no auto-approved component candidates.
 * Explicit structural exceptions: Header.astro and Footer.astro.
 * Other sections remain native markup in index.astro.
 *
 * Run after compiling with tsconfig.build.json:
 *   node dist/generator.js "output/<extraction-folder>"
 *   node dist/generator.js "output/<extraction-folder>" "generated/my-site"
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { canonicalPageUrl, rewriteInternalHref, isTransactionalLink } from "./routes.js";

type Snapshot = {
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  visible: boolean;
};
type IRNode = {
  id: number;
  tag: string;
  attributes: Record<string, string>;
  text: string;
  content?: Array<{ type: "text"; value: string } | { type: "element"; id: number }>;
  desktop: Snapshot;
  mobile?: Snapshot;
  children: IRNode[];
};
type IRSection = { kind: string; label: string; root: IRNode };
type Asset = { url: string; file: string; publicPath: string; contentType: string };
type PageIR = {
  schemaVersion: number;
  sourceUrl: string;
  metadata: { title: string; description: string; language: string };
  sections: IRSection[];
  theme?: { bodyClass: string; css: string };
  assets: Asset[];
  modularization: {
    policy: { mode: string; minimumOccurrences: number; autoApprove: boolean };
    candidates: Array<{ status: string; signature?: string }>;
  };
};

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
const OMIT_TAGS = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed"]);
const IGNORE_ATTR = new Set(["srcdoc", "integrity", "nonce"]);
const SAFE_ATTR = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;
const CSS_EXTENSION = /\.css(?:\?|$)/i;
const IMAGE_OR_FONT = /^(image\/|font\/|application\/font)/i;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAstroText(s: string): string {
  // Astro interprets braces as template expressions even in text.
  return escapeHtml(s).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}
function attrValue(s: string): string {
  return escapeHtml(s).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}
function resolveUrl(raw: string, base: string): string | undefined {
  try { return new URL(raw, base).href; } catch { return undefined; }
}
function safeRelativeAsset(a: Asset): boolean {
  const normalized = path.posix.normalize(a.file.replaceAll("\\", "/"));
  return normalized.startsWith("assets/") && !normalized.includes("../") &&
    a.publicPath === "/" + normalized && !path.posix.isAbsolute(normalized);
}
function mapAsset(raw: string, base: string, assetMap: Map<string, string>): string {
  const url = resolveUrl(raw, base);
  return (url && assetMap.get(url)) || raw;
}
function replaceUrls(css: string, base: string, assetMap: Map<string, string>): string {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote: string, raw: string) => {
    const trimmed = raw.trim();
    if (/^(data:|#|blob:)/i.test(trimmed)) return _match;
    const mapped = mapAsset(trimmed, base, assetMap);
    const original = resolveUrl(trimmed, base);
    // If asset was not downloaded, preserve a valid *absolute* URL rather than
    // leave a relative CSS path broken when moved to public/assets/stylesheet.
    return `url("${(mapped === trimmed && original) ? original : mapped}")`;
  });
}
function rewriteStyle(value: string, base: string, assetMap: Map<string, string>): string {
  return replaceUrls(value, base, assetMap);
}
function rewriteSrcset(value: string, base: string, assetMap: Map<string, string>): string {
  return value.split(",").map((part) => {
    const match = part.trim().match(/^(\S+)(\s+.*)?$/);
    return match ? `${mapAsset(match[1], base, assetMap)}${match[2] || ""}` : part;
  }).join(", ");
}
function safeLink(value: string): boolean {
  return !/^\s*(javascript:|vbscript:|data:)/i.test(value);
}

function renderNode(node: IRNode, level: number, base: string,
                    assetMap: Map<string, string>, warnings: string[], routes: ReadonlyMap<string, string> = new Map()): string {
  const tag = node.tag.toLowerCase();
  if (OMIT_TAGS.has(tag) || !/^[a-z][a-z0-9-]*$/.test(tag)) return "";
  if (tag === "input" && node.attributes.type?.toLowerCase() === "hidden") return "";
  // Keep form semantics and CSS selector compatibility; submissions are blocked.
  const resultTag = tag;
  const attributes: string[] = [`data-ir-id="${node.id}"`];
  const transactional = tag === "a" && (isTransactionalLink(node.attributes.href ?? "", node.text) || /\b(?:online shop|shop online)\b/i.test(node.text)) &&
    !rewriteInternalHref(node.attributes.href ?? "", base, routes);
  const unmigratedInternal = tag === "a" && Boolean(node.attributes.href) &&
    (() => { try {
      const target = new URL(node.attributes.href, base);
      return target.origin === new URL(base).origin && !rewriteInternalHref(node.attributes.href, base, routes) &&
        !node.attributes.href.startsWith('#') && !['mailto:', 'tel:'].includes(target.protocol);
    } catch { return false; } })() && routes.size > 0;
  const submit = tag === "button" && (node.attributes.type === "submit" ||
    /(?:submit|buy|purchase|checkout|cart|order)/i.test(`${node.attributes.id ?? ""} ${node.attributes.class ?? ""} ${node.text}`));
  for (const [keyRaw, original] of Object.entries(node.attributes)) {
    const key = keyRaw.toLowerCase();
    if (!SAFE_ATTR.test(keyRaw) || IGNORE_ATTR.has(key) || key.startsWith("on") ||
        key === "data-ir-id" || key === "srcset" && tag !== "img" ||
        (tag === "form" && ["action", "method", "enctype", "target"].includes(key))) continue;
    if (tag === "input" && (key === "name" || key === "value" && node.attributes.type === "hidden")) continue;
    if (key === "href" && (!safeLink(original) || transactional || unmigratedInternal)) continue;
    if (tag === "button" && submit && (key === "type" || key === "formaction" || key === "formmethod")) continue;
    if (key === "formaction" || key === "formmethod") continue;
    if (key === "src" && !safeLink(original)) continue;
    if (key === "href") {
      attributes.push(`href="${attrValue(rewriteInternalHref(original, base, routes) ?? original)}"`);
    } else if (key === "style") {
      attributes.push(`style="${attrValue(rewriteStyle(original, base, assetMap))}"`);
    } else if (key === "src" || key === "poster") {
      attributes.push(`${key}="${attrValue(mapAsset(original, base, assetMap))}"`);
    } else if (key === "srcset") {
      attributes.push(`srcset="${attrValue(rewriteSrcset(original, base, assetMap))}"`);
    } else if (key === "class") {
      attributes.push(`class="${attrValue(original)}"`);
    } else if (original === "" && ["disabled", "required", "checked", "selected", "multiple", "readonly", "autofocus", "novalidate", "itemscope"].includes(key)) {
      attributes.push(key);
    } else {
      attributes.push(`${keyRaw}="${attrValue(original)}"`);
    }
  }
  if (tag === "form") attributes.push('data-static-newsletter="true"', 'data-static-form="true"');
  if (transactional || unmigratedInternal) attributes.push('aria-disabled="true"', 'data-static-action="true"');
  if (unmigratedInternal && !transactional) warnings.push(`Unmigrated internal link on ${base}: ${node.attributes.href}`);
  if (submit) attributes.push('type="button"', 'aria-disabled="true"', 'data-static-submit="true"');
  if (tag === "button" && node.attributes.id?.startsWith("gform_submit_")) {
    if (!submit) attributes.push('type="button"', 'aria-disabled="true"', 'data-static-submit="true"');
    warnings.push("Newsletter submit button is visual-only; no backend is connected.");
  }
  const pad = "  ".repeat(level);
  const open = `${pad}<${resultTag}${attributes.length ? " " + attributes.join(" ") : ""}`;
  if (VOID_ELEMENTS.has(resultTag)) return `${open} />`;
  if (node.content) {
    const children = new Map(node.children.map(child => [child.id, child]));
    // Compact rendering avoids inserting formatting whitespace between inline nodes.
    const ordered = node.content.map(item => item.type === "text"
      ? escapeAstroText(item.value)
      : (children.has(item.id) ? renderNode(children.get(item.id)!, 0, base, assetMap, warnings, routes) : ""));
    return `${open}>${ordered.join("")}</${resultTag}>`;
  }
  // Older capture/IR format: retain its previous rendering behavior.
  const body: string[] = [];
  if (node.text) body.push(`${"  ".repeat(level + 1)}${escapeAstroText(node.text)}`);
  for (const child of node.children) {
    const rendered = renderNode(child, level + 1, base, assetMap, warnings, routes);
    if (rendered) body.push(rendered);
  }
  return body.length ? `${open}>\n${body.join("\n")}\n${pad}</${resultTag}>` : `${open}></${resultTag}>`;
}

function shouldSkipSection(section: IRSection): boolean {
  const root = section.root;
  const invisible = !root.desktop.visible && (!root.mobile || !root.mobile.visible);
  const intentionallyHidden = root.desktop.styles.visibility === "hidden" ||
    (root.desktop.styles.opacity === "0" && root.desktop.box.y < 0);
  return invisible && intentionallyHidden && section.kind === "other";
}

function pageTemplate(ir: PageIR, sections: string, hasHeader: boolean, hasFooter: boolean,
                      stylesheets: string[], hasMobileNavigation: boolean, hasThemeCss: boolean,
                       componentImports = "../components", styleImport = "../styles/generated.css",
                       headerName = "Header", footerName = "Footer", themePath = "/source-theme.css"): string {
  const imports = [
    ...(hasHeader ? [`import Header from "${componentImports}/${headerName}.astro";`] : []),
    ...(hasFooter ? [`import Footer from "${componentImports}/${footerName}.astro";`] : []),
    `import "${styleImport}";`,
  ];
  const title = escapeAstroText(ir.metadata.title || "Converted homepage");
  const description = ir.metadata.description
    ? `\n    <meta name="description" content="${attrValue(ir.metadata.description)}" />` : "";
  const bodyClass = attrValue(ir.theme?.bodyClass || "");
  return `---\n${imports.join("\n")}\n---\n<!doctype html>\n<html lang="${attrValue(ir.metadata.language || "en")}">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${title}</title>${description}\n${stylesheets.map((href) => `    <link rel="stylesheet" href="${attrValue(href)}" />`).join("\n")}${hasThemeCss ? '\n    <link rel="stylesheet" href="' + themePath + '" />' : ""}\n  </head>\n  <body${bodyClass ? ` class="${bodyClass}"` : ""}>\n${hasHeader ? "    <Header />\n" : ""}    <main id="generated-main">\n${sections}\n    </main>\n${hasFooter ? "    <Footer />\n" : ""}${hasMobileNavigation ? '\n    <script>\n      const nav = document.getElementById("mobile-nav");\n      const overlay = document.querySelector<HTMLElement>(".mobile-nav-overlay");\n      const toggle = document.querySelector<HTMLButtonElement>(".mobile-menu-button");\n      const close = nav?.querySelector<HTMLButtonElement>(".mobile-menu-close");\n      function setMenu(open: boolean) {\n        nav?.classList.toggle("is-open", open);\n        overlay?.classList.toggle("is-open", open);\n        toggle?.setAttribute("aria-expanded", String(open));\n      }\n      toggle?.setAttribute("aria-expanded", "false");\n      toggle?.addEventListener("click", () => setMenu(true));\n      close?.addEventListener("click", () => setMenu(false));\n      overlay?.addEventListener("click", () => setMenu(false));\n      document.addEventListener("keydown", (event) => { if (event.key === "Escape") setMenu(false); });\n    </script>\n' : ""}    <script>
      // Forms are visual replicas only. Prevent Enter-key and scripted submit events.
      document.addEventListener("submit", (event) => {
        if (event.target instanceof HTMLFormElement && event.target.matches('[data-static-form="true"]')) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    </script>
  </body>\n</html>\n`;
}

function generatedCss(hasMobileNavigation: boolean): string {
  return `/* Generated compatibility layer; original theme stylesheets are loaded in index.astro. */
/* Original WordPress scripts are not included; mobile nav needs a minimal toggle. */
${hasMobileNavigation ? `@media (max-width: 1023px) {
  #mobile-nav { transform: translateX(100%); transition: transform 0.3s ease; }
  #mobile-nav.is-open { transform: translateX(0); }
  .mobile-nav-overlay { pointer-events: none; opacity: 0; transition: opacity 0.3s ease; }
  .mobile-nav-overlay.is-open { pointer-events: auto; opacity: 1; }
}
@media (min-width: 1024px) { #mobile-nav, .mobile-nav-overlay { display: none !important; } }
` : ""}
/* Newsletter appearance preserved, but submission intentionally disabled. */
[data-static-submit="true"] { cursor: not-allowed; }
`;
}

async function copyAssets(ir: PageIR, extractionDir: string, outputDir: string,
                          warnings: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const a of ir.assets) {
    if (!safeRelativeAsset(a)) throw new Error(`Unsafe asset path in IR: ${a.file}`);
    if (!IMAGE_OR_FONT.test(a.contentType) && !/text\/css/i.test(a.contentType)) continue;
    const source = path.join(extractionDir, ...a.file.replaceAll("\\", "/").split("/"));
    const dest = path.join(outputDir, "public", ...a.file.replaceAll("\\", "/").split("/"));
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(source, dest);
      map.set(a.url, a.publicPath);
    } catch (error) {
      warnings.push(`Missing asset ${a.file}: ${(error as Error).message}`);
    }
  }
  // Rewrite stylesheet-relative asset URLs to local public paths where available;
  // unresolved CSS URLs become absolute original URLs rather than broken paths.
  for (const a of ir.assets) {
    if (!/text\/css/i.test(a.contentType) || !map.has(a.url)) continue;
    const dest = path.join(outputDir, "public", ...a.file.replaceAll("\\", "/").split("/"));
    const css = await fs.readFile(dest, "utf8");
    await fs.writeFile(dest, replaceUrls(css, a.url, map), "utf8");
  }
  return map;
}

export async function generateAstro(extractionFolder: string, targetFolder?: string): Promise<{
  outputDir: string; sections: number; files: string[]; warnings: string[];
}> {
  const extractionDir = path.resolve(extractionFolder);
  const outputDir = path.resolve(targetFolder || path.join("generated", path.basename(extractionDir)));
  if (outputDir === extractionDir || outputDir.startsWith(extractionDir + path.sep)) {
    throw new Error("Generation output must be outside the extraction folder.");
  }
  if (await fs.access(path.join(extractionDir, "site-manifest.json")).then(() => true, () => false)) {
    return generateAstroSite(extractionDir, outputDir);
  }
  const ir = JSON.parse(await fs.readFile(path.join(extractionDir, "page-ir.json"), "utf8")) as PageIR;
  if (ir.schemaVersion !== 1 || !Array.isArray(ir.sections) || !Array.isArray(ir.assets) ||
      !ir.modularization || ir.modularization.policy?.mode !== "strict-hybrid" ||
      ir.modularization.policy.minimumOccurrences !== 3 || ir.modularization.policy.autoApprove !== false) {
    throw new Error("Unsupported IR or modularization policy. Expected strict-hybrid, n=3, autoApprove=false.");
  }
  if (ir.modularization.candidates.some((candidate) => candidate.status !== "pending-review")) {
    throw new Error("Unreviewed/approved component status requires explicit generator support.");
  }
  const warnings: string[] = [];
  await fs.mkdir(path.join(outputDir, "src", "pages"), { recursive: true });
  await fs.mkdir(path.join(outputDir, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(outputDir, "src", "styles"), { recursive: true });
  const assetMap = await copyAssets(ir, extractionDir, outputDir, warnings);
  const base = ir.sourceUrl;
  const included = ir.sections.filter((s) => !shouldSkipSection(s));
  const headerSections = included.filter((s) => s.kind === "header" || s.kind === "mobile-navigation");
  const footerSections = included.filter((s) => s.kind === "footer");
  const contentSections = included.filter((s) => !headerSections.includes(s) && !footerSections.includes(s));
  const hasHeader = headerSections.length > 0;
  const hasFooter = footerSections.length > 0;
  const hasMobileNavigation = headerSections.some((s) => s.label === "mobile-nav");
  const files: string[] = [];
  const write = async (relative: string, contents: string) => {
    await fs.writeFile(path.join(outputDir, relative), contents, "utf8");
    files.push(relative);
  };
  const render = (section: IRSection, indent: number) => renderNode(section.root, indent, base, assetMap, warnings);
  if (hasHeader) await write("src/components/Header.astro", `<!-- Explicit site-wide component exception to n=3 -->\n${headerSections.map((s) => render(s, 0)).join("\n")}\n`);
  if (hasFooter) await write("src/components/Footer.astro", `<!-- Explicit site-wide component exception to n=3 -->\n${footerSections.map((s) => render(s, 0)).join("\n")}\n`);
  const cssAssets = ir.assets.filter((a) => /text\/css/i.test(a.contentType) && assetMap.has(a.url) &&
    (/cellar_one\/assets\/build\/theme-/.test(a.url) || /gravityforms\/assets\/css\/dist\/basic/.test(a.url) || /swiper.*\.css/.test(a.url)));
  const stylesheets = cssAssets.map((a) => a.publicPath);
  if (!stylesheets.some((s) => /stylesheet/.test(s))) warnings.push("No source theme CSS was found. Visual accuracy will be limited.");
  const hasThemeCss = Boolean(ir.theme?.css.trim());
  if (hasThemeCss) {
    await fs.mkdir(path.join(outputDir, "public"), { recursive: true });
    await write("public/source-theme.css", ir.theme!.css + "\n");
  } else {
    warnings.push("No original inline theme CSS in IR; rerun the updated transformer to preserve WordPress theme colours.");
  }
  await write("src/pages/index.astro", pageTemplate(ir, contentSections.map((s) => render(s, 3)).join("\n"), hasHeader, hasFooter, stylesheets, hasMobileNavigation, hasThemeCss));
  await write("src/styles/generated.css", generatedCss(hasMobileNavigation));
  await write("astro.config.mjs", 'import { defineConfig } from "astro/config";\nexport default defineConfig({ output: "static" });\n');
  await write("package.json", JSON.stringify({
    name: "wordpress-to-astro-generated-homepage", private: true, type: "module",
    scripts: { dev: "astro dev", build: "astro build", preview: "astro preview" },
    dependencies: { astro: "^7.4.7" },
  }, null, 2) + "\n");
  warnings.push("Swiper/WordPress JavaScript is not reproduced; verify product-lineup appearance manually.");
  warnings.push("Open Sans font downloads previously failed; browser fallback may differ from source.");
  warnings.push("No automated screenshot comparison has been run on the generated Astro page.");
  await write("GENERATION_REPORT.json", JSON.stringify({
    source: extractionDir, generatedAt: new Date().toISOString(),
    modularization: { minimumOccurrences: 3, autoApprove: false, components: [
      ...(hasHeader ? ["Header.astro"] : []), ...(hasFooter ? ["Footer.astro"] : [])
    ], unapprovedCandidates: ir.modularization.candidates.length },
    emittedSections: included.map((s) => s.label), excludedSections: ir.sections.filter(shouldSkipSection).map((s) => s.label),
    copiedAssets: assetMap.size, stylesheets, warnings: [...new Set(warnings)],
  }, null, 2) + "\n");
  return { outputDir, sections: included.length, files, warnings: [...new Set(warnings)] };
}

type SiteEntry = { sourceUrl: string; finalUrl: string; folder: string; route: string };
type SiteInfo = { schemaVersion: number; sourceUrl: string; pages: SiteEntry[]; warnings?: string[] };

function validateIR(ir: PageIR): void {
  if (ir.schemaVersion !== 1 || !Array.isArray(ir.sections) || !Array.isArray(ir.assets) ||
      ir.modularization?.policy?.mode !== "strict-hybrid" || ir.modularization.policy.minimumOccurrences !== 3 ||
      ir.modularization.policy.autoApprove !== false ||
      ir.modularization.candidates.some(c => c.status !== "pending-review")) {
    throw new Error("Unsupported IR or modularization policy. Expected strict-hybrid, n=3, autoApprove=false.");
  }
}

async function generateAstroSite(extractionDir: string, outputDir: string): Promise<{
  outputDir: string; sections: number; files: string[]; warnings: string[];
}> {
  const manifest = JSON.parse(await fs.readFile(path.join(extractionDir, "site-manifest.json"), "utf8")) as SiteInfo;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages) || !manifest.pages.length) throw new Error("Empty/invalid site manifest");
  const pages: Array<{ entry: SiteEntry; ir: PageIR; dir: string }> = [];
  const routeMap = new Map<string, string>();
  const routeNames = new Set<string>();
  for (const entry of manifest.pages) {
    if (!/^pages\/\d{3}$/.test(entry.folder) || !entry.route.startsWith('/') ||
        !entry.route.endsWith('/') || entry.route.includes('..') || entry.route.includes('\\') || routeNames.has(entry.route)) {
      throw new Error(`Invalid or duplicate route entry: ${entry.route}`);
    }
    const dir = path.join(extractionDir, entry.folder);
    const ir = JSON.parse(await fs.readFile(path.join(dir, "page-ir.json"), "utf8")) as PageIR;
    validateIR(ir);
    pages.push({ entry, ir, dir });
    routeNames.add(entry.route);
    routeMap.set(canonicalPageUrl(entry.sourceUrl), entry.route);
    routeMap.set(canonicalPageUrl(entry.finalUrl), entry.route);
  }
  const warnings = [...(manifest.warnings ?? [])];
  const files: string[] = [];
  const write = async (relative: string, contents: string): Promise<void> => {
    const file = path.join(outputDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, 'utf8');
    files.push(relative);
  };
  // Only exactly equivalent rendered structure is shared. Different sections retain unique files.
  const componentCache = new Map<string, string>();
  const sharedComponent = async (kind: 'Header' | 'Footer', html: string): Promise<string> => {
    html = html.replace(/ data-ir-id="\d+"/g, "");
    const fingerprint = createHash('sha256').update(html).digest('hex').slice(0, 12);
    const name = `${kind}_${fingerprint}`;
    if (!componentCache.has(name)) {
      await write(`src/components/${name}.astro`, `<!-- Shared only when full rendered markup is identical -->\n${html}\n`);
      componentCache.set(name, name);
    }
    return name;
  };
  let sectionCount = 0;
  let anyMobileNav = false;
  const paths: Array<{ route: string; sourceUrl: string }> = [];
  for (const { entry, ir, dir } of pages) {
    const assetMap = await copyAssets(ir, dir, outputDir, warnings);
    const included = ir.sections.filter(s => !shouldSkipSection(s));
    sectionCount += included.length;
    const headers = included.filter(s => s.kind === 'header' || s.kind === 'mobile-navigation');
    const footers = included.filter(s => s.kind === 'footer');
    const content = included.filter(s => !headers.includes(s) && !footers.includes(s));
    const render = (s: IRSection, indent: number) => renderNode(s.root, indent, ir.sourceUrl, assetMap, warnings, routeMap);
    const hasNav = headers.some(s => s.label === 'mobile-nav');
    anyMobileNav ||= hasNav;
    const headerName = headers.length ? await sharedComponent('Header', headers.map(s => render(s, 0)).join('\n')) : 'Header';
    const footerName = footers.length ? await sharedComponent('Footer', footers.map(s => render(s, 0)).join('\n')) : 'Footer';
    const cssAssets = ir.assets.filter(a => /text\/css/i.test(a.contentType) && assetMap.has(a.url) &&
      (/cellar_one\/assets\/build\/theme-/.test(a.url) || /gravityforms\/assets\/css\/dist\/basic/.test(a.url) || /swiper.*\.css/.test(a.url)));
    const stylesheets = cssAssets.map(a => a.publicPath);
    const themeCss = Boolean(ir.theme?.css?.trim());
    const hash = createHash('sha256').update(ir.theme?.css || '').digest('hex').slice(0, 12);
    const themePath = `/source-theme-${hash}.css`;
    if (themeCss) await write(`public/source-theme-${hash}.css`, ir.theme!.css + '\n');
    const segments = entry.route.split('/').filter(Boolean);
    if (segments.some(segment => !/^[a-zA-Z0-9._~%\-]+$/.test(segment) || segment === '.' || segment === '..')) throw new Error('Unsafe generated route');
    const relative = `src/pages/${segments.length ? segments.join('/') + '/' : ''}index.astro`;
    const depth = segments.length + 1;
    const relativeRoot = '../'.repeat(depth);
    await write(relative, pageTemplate(ir, content.map(s => render(s, 3)).join('\n'), headers.length > 0, footers.length > 0,
      stylesheets, hasNav, themeCss, `${relativeRoot}components`, `${relativeRoot}styles/generated.css`, headerName, footerName, themePath));
    paths.push({ route: entry.route, sourceUrl: entry.sourceUrl });
  }
  await write('src/styles/generated.css', generatedCss(anyMobileNav) + '\n[data-static-action="true"] { cursor: not-allowed; }\n');
  await write('astro.config.mjs', 'import { defineConfig } from "astro/config";\nexport default defineConfig({ output: "static" });\n');
  await write('package.json', JSON.stringify({ name: 'wordpress-to-astro-generated-site', private: true, type: 'module',
    scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' }, dependencies: { astro: '^7.4.7' } }, null, 2) + '\n');
  warnings.push('Checkout, purchases and form submissions are intentionally disabled.');
  warnings.push('Compare each generated page against desktop and mobile screenshots before accepting visual fidelity.');
  await write('GENERATION_REPORT.json', JSON.stringify({ source: extractionDir, generatedAt: new Date().toISOString(),
    pages: paths, sharedComponents: [...componentCache.keys()], emittedSections: sectionCount, warnings: [...new Set(warnings)] }, null, 2) + '\n');
  return { outputDir, sections: sectionCount, files, warnings: [...new Set(warnings)] };
}

async function main() {
  const folder = process.argv[2];
  if (!folder) throw new Error('Usage: node dist/generator.js "output/<extraction-folder>" ["generated/<site>"]');
  const result = await generateAstro(folder, process.argv[3]);
  console.log(`Astro project: ${result.outputDir}`);
  console.log(`Sections: ${result.sections}; files: ${result.files.length}`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  console.log("Next: cd into generated project, npm install, npm run dev");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
