// Minimal test: resolveBuckets falls back when frontmatter is absent/invalid,
// and uses declared buckets when present. Imports the SAME module main.ts
// bundles (model.mjs). Run with: node resolveBuckets.test.mjs
import assert from "node:assert";
import { resolveBuckets } from "./model.mjs";

assert.equal(resolveBuckets(undefined)[0].slug, "identity", "undefined -> default");
assert.equal(resolveBuckets({})[0].slug, "identity", "empty fm -> default");
assert.equal(resolveBuckets({ dashboard_buckets: [] })[0].slug, "identity", "empty array -> default");
const r = resolveBuckets({ dashboard_buckets: [{ slug: "vga", label: "VGA" }, { slug: "vss", label: "VSS" }] });
assert.equal(r.length, 2, "declared -> 2");
assert.equal(r[0].slug, "vga", "declared -> vga first");
console.log("resolveBuckets: all assertions passed");
