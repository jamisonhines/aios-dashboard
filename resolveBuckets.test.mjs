import "./testFileTimeout.mjs";
// Minimal test: resolveBuckets falls back when frontmatter is absent/invalid,
// and uses declared buckets when present. Imports the SAME module main.ts
// bundles (model.mjs). Run with: node resolveBuckets.test.mjs
import assert from "node:assert";
import { DEFAULT_BUCKETS, resolveBuckets } from "./model.mjs";

assert.equal(resolveBuckets(undefined)[0].slug, "identity", "undefined -> default");
assert.equal(resolveBuckets({})[0].slug, "identity", "empty fm -> default");
assert.equal(resolveBuckets({ dashboard_buckets: [] })[0].slug, "identity", "empty array -> default");
// REQ-C3: the default life areas are the neutral examples AGENTS.md uses; an owner's own list goes in the Dashboard note.
assert.deepEqual(
  DEFAULT_BUCKETS.map((b) => b.slug),
  ["identity", "work", "family", "health", "growth", "money", "learning", "home"],
  "neutral default life areas"
);
assert.deepEqual(DEFAULT_BUCKETS.map((b) => b.label), ["Identity", "Work", "Family", "Health", "Growth", "Money", "Learning", "Home"]);
const r = resolveBuckets({ dashboard_buckets: [{ slug: "garden", label: "Garden" }, { slug: "music", label: "Music" }] });
assert.equal(r.length, 2, "declared -> 2");
assert.equal(r[0].slug, "garden", "declared -> garden first");
console.log("resolveBuckets: all assertions passed");
