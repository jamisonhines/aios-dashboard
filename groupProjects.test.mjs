// Tests for the project status-sectioning engine: resolveStatusSections (frontmatter
// override + fallback) and groupProjectsByStatus (fixed order, hide-empty, drift -> Other).
// Imports the SAME module main.ts bundles (model.mjs). Run: node groupProjects.test.mjs
import assert from "node:assert";
import {
  DEFAULT_STATUS_SECTIONS,
  resolveStatusSections,
  groupProjectsByStatus,
  orderProjects,
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

// --- orderProjects (owner feedback 2026-08-30: drag-to-reorder projects) ---
// alphabetical default order for this fixture is Alpha, Bravo, Charlie, Delta

const OP = ["Alpha", "Bravo", "Charlie", "Delta"].map((n) => P(n, "active"));

// Ordered-first rule: every slug in orderList appears first, in orderList's
// own sequence, regardless of the input array's own order.
assert.deepEqual(
  orderProjects(OP, ["Delta", "Alpha"]).map((p) => p.slug),
  ["Delta", "Alpha", "Bravo", "Charlie"],
  "ordered-first: listed slugs lead, in orderList's sequence"
);

// Unknown-slug append rule: an orderList slug with no matching item is
// silently skipped, never inserted as a gap or a throw.
assert.deepEqual(
  orderProjects(OP, ["Zulu", "Delta", "Echo", "Alpha"]).map((p) => p.slug),
  ["Delta", "Alpha", "Bravo", "Charlie"],
  "unknown-slug append: orderList entries with no matching item are skipped"
);

// Stable order for unlisted: projects NOT in orderList keep their own
// relative order from the input array (not re-sorted by this function).
assert.deepEqual(
  orderProjects(OP, ["Charlie"]).map((p) => p.slug),
  ["Charlie", "Alpha", "Bravo", "Delta"],
  "stable for unlisted: Alpha/Bravo/Delta keep their input-array relative order"
);

// Empty orderList -> input order preserved untouched (the "brand-new
// install, nothing dragged yet" case).
assert.deepEqual(
  orderProjects(OP, []).map((p) => p.slug),
  ["Alpha", "Bravo", "Charlie", "Delta"],
  "empty orderList -> every project falls through to the unlisted/stable path"
);

// Empty items -> empty output, no throw.
assert.deepEqual(orderProjects([], ["Alpha"]), [], "no projects -> no output, no throw");

// Duplicate slug in orderList -> deduped, first occurrence wins, no
// double-inclusion of the same project.
assert.deepEqual(
  orderProjects(OP, ["Bravo", "Bravo"]).map((p) => p.slug),
  ["Bravo", "Alpha", "Charlie", "Delta"],
  "duplicate orderList entry does not duplicate the project in the output"
);

// Pure: never mutates the inputs, and always returns a NEW array (even when
// orderList is empty and nothing conceptually "changed").
{
  const inputCopy = OP.slice();
  const orderListCopy = ["Delta"];
  const result = orderProjects(OP, orderListCopy);
  assert.deepEqual(OP, inputCopy, "items array is not mutated");
  assert.deepEqual(orderListCopy, ["Delta"], "orderList array is not mutated");
  assert.notEqual(result, OP, "returns a new array, not the same reference");
  const resultEmptyOrder = orderProjects(OP, []);
  assert.notEqual(resultEmptyOrder, OP, "empty orderList still returns a new array, not the same reference");
}

console.log("groupProjects: all assertions passed");
