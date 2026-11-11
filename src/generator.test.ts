import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateAstro } from "./generator.js";

test("produces a conservative Astro page, copies assets, and removes WP form submission", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "astro-generator-test-"));
  try {
    const extraction = path.join(temp, "capture");
    const output = path.join(temp, "site");
    await fs.mkdir(path.join(extraction, "assets", "image"), { recursive: true });
    await fs.mkdir(path.join(extraction, "assets", "stylesheet"), { recursive: true });
    await fs.writeFile(path.join(extraction, "assets", "image", "hero.jpg"), "fake image");
    await fs.writeFile(path.join(extraction, "assets", "stylesheet", "theme.css"), '.hero { background: url("https://example.com/hero.jpg"); }');
    const snap = { box: { x: 0, y: 0, width: 1200, height: 100 }, styles: { visibility: "visible", opacity: "1" }, visible: true };
    const node = (id: number, tag: string, attributes: Record<string,string>, text = "", children: unknown[] = []) =>
      ({ id, tag, attributes, text, desktop: snap, children });
    const ir = {
      schemaVersion: 1, sourceUrl: "https://example.com/", metadata: { title: "Example", description: "", language: "en" },
      modularization: { policy: { mode: "strict-hybrid", minimumOccurrences: 3, autoApprove: false }, candidates: [] },
      assets: [
        { url: "https://example.com/hero.jpg", file: "assets/image/hero.jpg", publicPath: "/assets/image/hero.jpg", contentType: "image/jpeg" },
        { url: "https://example.com/theme.css", file: "assets/stylesheet/theme.css", publicPath: "/assets/stylesheet/theme.css", contentType: "text/css" }
      ],
      theme: { bodyClass: "home cellar-theme", css: ".cellar-theme { --background: #ffffff; --tertiary: #dca442; }" },
      sections: [
        { kind: "header", label: "header", root: node(1, "header", {}, "header") },
        { kind: "hero", label: "hero", root: node(2, "section", { class: "hero", style: 'background-image: url("https://example.com/hero.jpg")' }, "Hello") },
        { kind: "footer", label: "footer", root: node(3, "footer", {}, "", [node(4, "form", { method: "post", action: "https://example.com/submit" }, "", [node(5, "button", { id: "gform_submit_button_2" }, "Submit")])]) }
      ]
    };
    await fs.writeFile(path.join(extraction, "page-ir.json"), JSON.stringify(ir));
    const result = await generateAstro(extraction, output);
    assert.equal(result.sections, 3);
    const page = await fs.readFile(path.join(output, "src", "pages", "index.astro"), "utf8");
    const footer = await fs.readFile(path.join(output, "src", "components", "Footer.astro"), "utf8");
    const css = await fs.readFile(path.join(output, "public", "assets", "stylesheet", "theme.css"), "utf8");
    assert.match(page, /<Header \/>/);
    assert.match(page, /<body class="home cellar-theme">/);
    assert.match(page, /\/source-theme\.css/);
    const themeCss = await fs.readFile(path.join(output, "public", "source-theme.css"), "utf8");
    assert.match(themeCss, /--tertiary: #dca442/);
    assert.match(page, /<Footer \/>/);
    assert.match(page, /\/assets\/image\/hero.jpg/);
    assert.match(css, /\/assets\/image\/hero.jpg/);
    assert.match(footer, /<form/);
    assert.doesNotMatch(footer, /method="post"|action=/);
    assert.match(footer, /data-static-submit="true"/);
    await fs.access(path.join(output, "public", "assets", "image", "hero.jpg"));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("rejects unapproved modularization policy", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "astro-generator-test-"));
  try {
    await fs.writeFile(path.join(temp, "page-ir.json"), JSON.stringify({
      schemaVersion: 1, sections: [], assets: [],
      modularization: { policy: { mode: "strict-hybrid", minimumOccurrences: 2, autoApprove: false }, candidates: [] }
    }));
    await assert.rejects(generateAstro(temp, temp + "-site"), /Unsupported IR/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("preserves form tags and original inline text order while disabling submission", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "astro-fidelity-test-"));
  try {
    const snap = { box: { x: 0, y: 0, width: 100, height: 30 }, styles: { visibility: "visible", opacity: "1" }, visible: true };
    const strong = { id: 3, tag: "strong", text: "Phone:", content: [{ type: "text", value: "Phone:" }], attributes: {}, desktop: snap, children: [] };
    const p = { id: 2, tag: "p", attributes: {}, text: "123", content: [{ type: "element", id: 3 }, { type: "text", value: " 123" }], desktop: snap, children: [strong] };
    const form = { id: 4, tag: "form", attributes: { id: "contact", action: "https://example.com/post", method: "post" }, text: "", desktop: snap, children: [
      { id: 5, tag: "button", attributes: { type: "submit" }, text: "Submit", desktop: snap, children: [] }
    ] };
    const ir = { schemaVersion: 1, sourceUrl: "https://example.com/", metadata: { title: "Example", description: "", language: "en" },
      sections: [{ kind: "content", label: "contact", root: { id: 1, tag: "section", attributes: {}, text: "", desktop: snap, children: [p, form] } }],
      assets: [], modularization: { policy: { mode: "strict-hybrid", minimumOccurrences: 3, autoApprove: false }, candidates: [] } };
    await fs.writeFile(path.join(temp, "page-ir.json"), JSON.stringify(ir));
    const result = await generateAstro(temp, path.join(temp, "..", path.basename(temp) + "-site"));
    const page = await fs.readFile(path.join(result.outputDir, "src/pages/index.astro"), "utf8");
    assert.match(page, /<strong data-ir-id="3">Phone:<\/strong> 123<\/p>/);
    assert.match(page, /<form[^>]+data-static-form="true"/);
    assert.doesNotMatch(page, /action="https:\/\/example.com\/post"|method="post"/);
    assert.match(page, /event\.preventDefault\(\)/);
    assert.match(page, /type="button" aria-disabled="true" data-static-submit="true"/);
    await fs.rm(result.outputDir, { recursive: true, force: true });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
