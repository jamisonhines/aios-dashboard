// Tests for the project status-sectioning engine: resolveStatusSections (frontmatter
// override + fallback) and groupProjectsByStatus (fixed order, hide-empty, drift -> Other).
// Imports the SAME module main.ts bundles (model.mjs). Run: node groupProjects.test.mjs
import assert from "node:assert";
import {
  DEFAULT_STATUS_SECTIONS,
  resolveStatusSections,
  groupProjectsByStatus,
} from "./model.mjs";

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
