// Tests for the System tab's Skills-section view-model (build 2026-08-04).
// Pure functions imported from model.mjs; no Obsidian deps.
// Run: node systemSkillsModel.test.mjs
import assert from "node:assert";
import {
  SYSTEM_SKILLS_SUITE_PREFIXES,
  systemSkillsSuiteFor,
  systemSkillUsedByRows,
  systemSkillRowFromNode,
  computeSystemSkillsView,
  systemSkillsGroupIsOpen,
} from "./model.mjs";

// --- systemSkillsSuiteFor: prefix match / standalone ---
{
  assert.equal(systemSkillsSuiteFor("blog-analyze"), "blog", "matches blog- prefix");
  assert.equal(systemSkillsSuiteFor("gsd-executor"), "gsd", "matches gsd- prefix");
  assert.equal(systemSkillsSuiteFor("printing-press-amend"), "printing-press", "matches multi-hyphen prefix");
  assert.equal(systemSkillsSuiteFor("vgb-email-router"), null, "standalone skill returns null");
  assert.equal(systemSkillsSuiteFor("blog"), null, "the suite entry point itself (no trailing dash) is standalone");
}
{
  const custom = ["foo-"];
  assert.equal(systemSkillsSuiteFor("foo-bar", custom), "foo", "custom prefix list is honored");
  assert.equal(systemSkillsSuiteFor("blog-analyze", custom), null, "default prefixes not applied when a custom list is passed");
}
assert.ok(SYSTEM_SKILLS_SUITE_PREFIXES.includes("blog-"), "default prefix list includes blog-");

// --- systemSkillUsedByRows: resolves ids against the node index ---
{
  const nodesById = new Map([
    ["capture", { id: "capture", type: "agent", label: "Capture", path: "Agents/Capture/AGENTS.md" }],
    ["gsd-executor", { id: "gsd-executor", type: "skill", label: "gsd-executor", path: "/skills/gsd-executor", external: true }],
  ]);
  const node = { id: "blog-write", usedBy: ["capture", "gsd-executor", "unknown-id"] };
  const rows = systemSkillUsedByRows(node, nodesById);
  assert.equal(rows.length, 3, "one row per usedBy id, including an unresolved id");
  assert.deepEqual(rows[0], { id: "capture", label: "Capture", path: "Agents/Capture/AGENTS.md" }, "internal node carries a path");
  assert.equal(rows[1].path, undefined, "external skill node carries no path");
  assert.equal(rows[2].label, "unknown-id", "an id absent from the node index falls back to the raw id as its label");
}
{
  const rows = systemSkillUsedByRows({ id: "solo-skill" }, new Map());
  assert.deepEqual(rows, [], "missing usedBy array yields no rows, not a throw");
}

// --- systemSkillRowFromNode: usage join by key, dash-worthy nulls when absent ---
{
  const nodesById = new Map();
  const usageByKey = new Map([["blog-write", { key: "blog-write", costUsd: 1.23, runs: 4, avgCostUsd: 0.3075 }]]);
  const node = {
    id: "blog-write",
    description: "Writes a blog post.",
    disableModelInvocation: true,
    path: "/skills/blog-write",
    external: true,
    usedBy: [],
  };
  const row = systemSkillRowFromNode(node, nodesById, usageByKey);
  assert.equal(row.costUsd, 1.23);
  assert.equal(row.runs, 4);
  assert.equal(row.avgCostUsd, 0.3075);
  assert.equal(row.disableModelInvocation, true);
}
{
  const node = { id: "unused-skill", usedBy: [] };
  const row = systemSkillRowFromNode(node, new Map(), new Map());
  assert.equal(row.costUsd, null, "no usage row -> null cost (dash is a render decision)");
  assert.equal(row.runs, null);
  assert.equal(row.avgCostUsd, null);
  assert.equal(row.description, "(no description)", "missing description falls back");
  assert.equal(row.disableModelInvocation, false, "defaults false when absent");
}

// --- systemSkillRowFromNode: origin (Reviewer M3, 2026-08-04) ---
{
  const node = { id: "superpowers:brainstorming", origin: "plugin", usedBy: [] };
  const row = systemSkillRowFromNode(node, new Map(), new Map());
  assert.equal(row.origin, "plugin");
}
{
  const node = { id: "close-session", origin: "command", usedBy: [] };
  const row = systemSkillRowFromNode(node, new Map(), new Map());
  assert.equal(row.origin, "command");
}
{
  const node = { id: "blog-write", usedBy: [] }; // pre-M3 node, no origin field
  const row = systemSkillRowFromNode(node, new Map(), new Map());
  assert.equal(row.origin, "skills-dir", "defaults to skills-dir for a node written before this field existed");
}

// --- computeSystemSkillsView: filter, join, group ---
function makeOpsMap(skillIds) {
  return {
    nodes: skillIds.map((id) => ({ id, type: "skill", label: id, description: `Does ${id} things.`, path: `/skills/${id}`, external: true, usedBy: [] })),
    edges: [],
  };
}
{
  const opsMap = makeOpsMap(["blog-analyze", "blog-write", "gsd-executor", "vgb-email-router", "onlysky-cli"]);
  const view = computeSystemSkillsView(opsMap, { skills: [] }, "");
  assert.equal(view.totalCount, 5);
  assert.equal(view.filteredCount, 5);
  assert.equal(view.standalone.length, 2, "vgb-email-router + onlysky-cli are standalone");
  assert.equal(view.groups.length, 2, "blog + gsd groups formed");
  const blogGroup = view.groups.find((g) => g.suite === "blog");
  assert.equal(blogGroup.count, 2);
  assert.deepEqual(blogGroup.rows.map((r) => r.id), ["blog-analyze", "blog-write"], "group rows sorted alphabetically");
}
{
  const opsMap = makeOpsMap(["blog-analyze", "blog-write", "vgb-email-router"]);
  const view = computeSystemSkillsView(opsMap, { skills: [] }, "vgb");
  assert.equal(view.filteredCount, 1, "filter narrows to the matching skill only");
  assert.equal(view.standalone[0].id, "vgb-email-router");
  assert.equal(view.groups.length, 0, "no group survives the filter");
}
{
  const opsMap = { nodes: [], edges: [] };
  const view = computeSystemSkillsView(opsMap, null, "");
  assert.equal(view.totalCount, 0);
  assert.equal(view.standalone.length, 0);
  assert.equal(view.groups.length, 0, "empty ops map and missing usage stats do not throw");
}
{
  // Larger group sorts before a smaller one; tie breaks alphabetically.
  const opsMap = makeOpsMap(["seo-a", "seo-b", "seo-c", "gsd-a", "gsd-b"]);
  const view = computeSystemSkillsView(opsMap, { skills: [] }, "");
  assert.deepEqual(view.groups.map((g) => g.suite), ["seo", "gsd"], "3-member group sorts before 2-member group");
}

// --- computeSystemSkillsView: filterActive (Reviewer M6, 2026-08-04) ---
{
  const opsMap = makeOpsMap(["blog-analyze", "blog-write"]);
  assert.equal(computeSystemSkillsView(opsMap, { skills: [] }, "").filterActive, false, "empty filter text is not active");
  assert.equal(computeSystemSkillsView(opsMap, { skills: [] }, "   ").filterActive, false, "whitespace-only filter text is not active");
  assert.equal(computeSystemSkillsView(opsMap, { skills: [] }, "blog").filterActive, true, "non-empty filter text is active");
}

// --- systemSkillsGroupIsOpen (Reviewer M6, 2026-08-04): a filtered-in group
// auto-expands regardless of the user's manual state; a fresh view state
// (nothing manually expanded, no filter) stays collapsed; clearing the
// filter falls back to whatever the user had manually expanded, with no
// mutation performed by the filter itself. ---
{
  const expanded = new Set(); // fresh view state
  assert.equal(systemSkillsGroupIsOpen("gsd", expanded, false), false, "fresh state, no filter: collapsed");
  assert.equal(systemSkillsGroupIsOpen("gsd", expanded, true), true, "filter active: auto-expanded regardless of manual state");
  assert.equal(expanded.has("gsd"), false, "the filter never mutates the manual expand set");
}
{
  const expanded = new Set(["gsd"]); // user had manually expanded gsd
  assert.equal(systemSkillsGroupIsOpen("gsd", expanded, false), true, "manually expanded group stays open with no filter");
  assert.equal(systemSkillsGroupIsOpen("blog", expanded, false), false, "an untouched group stays collapsed");
  assert.equal(systemSkillsGroupIsOpen("gsd", expanded, true), true, "still open while filtering");
  // Filter clears: falls straight back to the untouched manual set.
  assert.equal(systemSkillsGroupIsOpen("gsd", expanded, false), true, "restored to manually-expanded after the filter clears");
  assert.equal(systemSkillsGroupIsOpen("blog", expanded, false), false, "restored to manually-collapsed after the filter clears");
}

console.log("systemSkillsModel: all assertions passed");
