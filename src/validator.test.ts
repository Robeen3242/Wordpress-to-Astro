import assert from "node:assert/strict";
import { test } from "node:test";
import { PIXEL_THRESHOLD, VIEWPORTS, validateUrl } from "./validator.js";

test("uses the same viewports as the Rocky Creek extraction", () => {
  assert.deepEqual(VIEWPORTS, [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]);
});

test("pixel mismatch threshold is explicit and stable", () => {
  assert.equal(PIXEL_THRESHOLD, 20);
});

test("accepts local HTTP targets and rejects non-web protocols", () => {
  assert.equal(validateUrl("http://localhost:4321"), "http://localhost:4321/");
  assert.throws(() => validateUrl("file:///etc/passwd"), /http:\/\/ or https:\/\//);
});
