// Minimal test: resolveBuckets falls back when frontmatter is absent/invalid,
// and uses declared buckets when present. Run with: node resolveBuckets.test.mjs
import assert from "node:assert";

// Mirror of the function under test (kept in sync with main.ts).
function resolveBuckets(fm) {
  const raw = fm?.["dashboard_buckets"];
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw
      .filter((b) => b && typeof b.slug === "string" && typeof b.label === "string")
      .map((b) => ({ slug: b.slug, label: b.label }));
    if (parsed.length > 0) return parsed;
  }
  return [{ slug: "identity", label: "Identity" }]; // sentinel default
}

assert.equal(resolveBuckets(undefined)[0].slug, "identity", "undefined -> default");
assert.equal(resolveBuckets({})[0].slug, "identity", "empty fm -> default");
assert.equal(resolveBuckets({ dashboard_buckets: [] })[0].slug, "identity", "empty array -> default");
const r = resolveBuckets({ dashboard_buckets: [{ slug: "vga", label: "VGA" }, { slug: "vss", label: "VSS" }] });
assert.equal(r.length, 2, "declared -> 2");
assert.equal(r[0].slug, "vga", "declared -> vga first");
console.log("resolveBuckets: all assertions passed");
