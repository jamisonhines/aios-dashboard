// Tests for the project status-sectioning engine: resolveStatusSections (frontmatter
// override + fallback) and groupProjectsByStatus (fixed order, hide-empty, drift -> Other).
// Mirrors of the functions under test (kept in sync with main.ts). Run: node groupProjects.test.mjs
import assert from "node:assert";

const DEFAULT_STATUS_SECTIONS = [
  { slug: "active", label: "Active", open: true },
  { slug: "planning", label: "Planning", open: true },
  { slug: "paused", label: "Paused", open: true },
  { slug: "done", label: "Done", open: false },
  { slug: "archived", label: "Archived", open: false },
];

function resolveStatusSections(fm) {
  const raw = fm?.["dashboard_project_statuses"];
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw
      .filter((b) => b && typeof b.slug === "string" && typeof b.label === "string")
      .map((b) => ({ slug: b.slug, label: b.label, open: b.open !== false }));
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_STATUS_SECTIONS;
}

function groupProjectsByStatus(projects, sections) {
  const known = new Set(sections.map((s) => s.slug));
  const byName = (a, b) =>
    a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  const out = [];
  for (const sec of sections) {
    const inSec = projects.filter((p) => p.status === sec.slug).sort(byName);
    if (inSec.length > 0) {
      out.push({ slug: sec.slug, label: sec.label, open: sec.open, projects: inSec });
    }
  }
  const drift = projects.filter((p) => !known.has(p.status)).sort(byName);
  if (drift.length > 0) {
    out.push({ slug: "other", label: "Other", open: true, projects: drift });
  }
  return out;
}

// --- resolveStatusSections ---
assert.equal(resolveStatusSections(undefined).length, 5, "undefined -> 5 defaults");
assert.equal(resolveStatusSections({}).length, 5, "empty fm -> 5 defaults");
assert.equal(resolveStatusSections(undefined)[0].slug, "active", "default order: active first");
assert.equal(resolveStatusSections(undefined)[4].slug, "archived", "default order: archived last");
assert.equal(resolveStatusSections({ dashboard_project_statuses: [] }).length, 5, "empty array -> defaults");
const ov = resolveStatusSections({
  dashboard_project_statuses: [
    { slug: "live", label: "Live" },
    { slug: "cold", label: "Cold", open: false },
  ],
});
assert.equal(ov.length, 2, "override -> 2");
assert.equal(ov[0].slug, "live", "override first slug");
assert.equal(ov[0].open, true, "override open defaults true");
assert.equal(ov[1].open, false, "override open:false respected");

// --- groupProjectsByStatus ---
const P = (name, status) => ({
  name, status, slug: name, path: "", venture: null, keyElement: null, targetDate: null, phases: [],
});
const projects = [
  P("Zeta", "active"),
  P("Alpha", "active"),
  P("Bravo", "planning"),
  P("Charlie", "done"),
  P("Echo", "another-bad-status"),
  P("Delta", "weird-legacy-status"),
];

const groups = groupProjectsByStatus(projects, DEFAULT_STATUS_SECTIONS);
assert.deepEqual(
  groups.map((g) => g.slug),
  ["active", "planning", "done", "other"],
  "fixed order, empty sections hidden, drift -> other"
);
assert.equal(groups[0].projects.map((p) => p.name).join(","), "Alpha,Zeta", "active sorted by name");
assert.equal(groups[0].open, true, "active open by default");
assert.equal(groups[2].open, false, "done collapsed by default");
assert.equal(groups[3].label, "Other", "drift bucket labelled Other");
assert.equal(
  groups[3].projects.map((p) => p.name).join(","),
  "Delta,Echo",
  "multiple drift statuses collected into Other and sorted by name"
);
assert.equal(groupProjectsByStatus([], DEFAULT_STATUS_SECTIONS).length, 0, "no projects -> no groups");

console.log("groupProjects: all assertions passed");
