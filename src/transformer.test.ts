import assert from "node:assert/strict";
import test from "node:test";
import { findComponentCandidates, type IRNode, type IRSection } from "./transformer.js";

let nextId = 0;
function makeNode(tag: string, children: IRNode[] = []): IRNode {
  const id = nextId++;
  return {
    id, tag, children, text: "", attributes: {},
    desktop: {
      box: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
      styles: {
        display: "block", position: "static", visibility: "visible",
        opacity: "1", "flex-direction": "row", "grid-template-columns": "none",
      },
    },
  };
}
function card(): IRNode {
  return makeNode("article", [
    makeNode("div", [makeNode("h2"), makeNode("p")]),
    makeNode("img"),
  ]);
}
function sections(cards: number): IRSection[] {
  return [{ kind: "content", label: "test", root: makeNode("main", Array.from({ length: cards }, card)) }];
}

test("a pattern appearing only twice is not a component candidate", () => {
  nextId = 0;
  assert.deepEqual(findComponentCandidates(sections(2)), []);
});

test("three matching composite structures are flagged, never approved", () => {
  nextId = 0;
  const candidates = findComponentCandidates(sections(3));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].occurrences, 3);
  assert.equal(candidates[0].rootTag, "article");
  assert.equal(candidates[0].status, "pending-review");
});

test("a different root layout prevents grouping", () => {
  nextId = 0;
  const root = sections(3)[0];
  root.root.children[2].desktop.styles.display = "flex";
  assert.equal(findComponentCandidates([root]).length, 0);
});

test("individual paragraphs are not component candidates", () => {
  nextId = 0;
  const root = makeNode("main", Array.from({ length: 4 }, () => makeNode("p")));
  assert.deepEqual(findComponentCandidates([{ kind: "content", label: "test", root }]), []);
});

test("preserves body theme class and extracted inline theme CSS", async () => {
  const { transformCaptures } = await import("./transformer.js");
  const capture = {
    url: "https://example.com/", title: "Example", description: "", language: "en",
    viewport: { width: 1440, height: 900, documentWidth: 1440, documentHeight: 900 },
    totalElementCount: 1, extractedElementCount: 1,
    elements: [{ id: 0, parentIndex: -1, tag: "body", attributes: { class: "home cellar-theme" },
      text: "", rectangle: { x: 0, y: 0, width: 1440, height: 900 }, computedStyles: {} }],
    images: [], headings: [], links: [], fonts: [],
    inlineStyles: [".cellar-theme { --tertiary: #dca442; --background: #fff; }"],
  };
  const ir = transformCaptures(capture);
  assert.equal(ir.theme.bodyClass, "home cellar-theme");
  assert.match(ir.theme.css, /--tertiary: #dca442/);
});

test("preserves ordered text and element references in the IR", async () => {
  const { transformCaptures } = await import("./transformer.js");
  const snap = { x: 0, y: 0, width: 300, height: 40 };
  const raw = (id: number, parentIndex: number, tag: string, text: string, childNodes?: Array<{ type: "text"; value: string } | { type: "element"; id: number }>) =>
    ({ id, parentIndex, tag, text, attributes: {}, rectangle: snap, computedStyles: { display: "block", visibility: "visible", opacity: "1" }, ...(childNodes ? { childNodes } : {}) });
  const capture = {
    url: "https://example.com/contact/", title: "Contact", description: "", language: "en",
    viewport: { width: 1440, height: 900, documentWidth: 1440, documentHeight: 900 },
    totalElementCount: 4, extractedElementCount: 4,
    elements: [raw(0, -1, "html", ""), raw(1, 0, "body", ""),
      raw(2, 1, "p", "123", [{ type: "element", id: 3 }, { type: "text", value: " 123" }]),
      raw(3, 2, "strong", "Phone:", [{ type: "text", value: "Phone:" }])],
    images: [], headings: [], links: [], fonts: [], inlineStyles: []
  };
  const ir = transformCaptures(capture);
  const paragraph = ir.sections[0].root;
  assert.deepEqual(paragraph.content, [{ type: "element", id: 3 }, { type: "text", value: " 123" }]);
  assert.equal(paragraph.children[0].content?.[0]?.type, "text");
});
