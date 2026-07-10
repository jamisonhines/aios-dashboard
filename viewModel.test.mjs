// Tests for the dashboard view-model helpers (pure): statusChipsFromGroups, splitProjectTasks,
// categoryChipsFromTasks, tagForTask, filterStandaloneByCategory. Mirrors kept in sync with
// main.ts. Run: node viewModel.test.mjs
import assert from "node:assert";

function statusChipsFromGroups(groups) {
  return groups.map((g) => ({ slug: g.slug, label: g.label, count: g.projects.length }));
}
function splitProjectTasks(tasks) {
  return {
    doing: tasks.filter((t) => t.status === "in-progress"),
    open: tasks.filter((t) => t.status === "open"),
    done: tasks.filter((t) => t.status === "done"),
  };
}
function categoryChipsFromTasks(standaloneTasks, buckets) {
  const out = [];
  for (const b of buckets) {
    const count = standaloneTasks.filter((t) => t.lifeAreas.includes(b.slug)).length;
    if (count > 0) out.push({ slug: b.slug, label: b.label, count });
  }
  const known = buckets.map((b) => b.slug);
  const inboxCount = standaloneTasks.filter((t) => !t.lifeAreas.some((a) => known.includes(a))).length;
  if (inboxCount > 0) out.push({ slug: "inbox", label: "Inbox", count: inboxCount });
  return out;
}
function tagForTask(task, buckets) {
  for (const b of buckets) {
    if (task.lifeAreas.includes(b.slug)) return { slug: b.slug, label: b.label };
  }
  return { slug: "inbox", label: "Inbox" };
}
function filterStandaloneByCategory(standaloneTasks, categorySlug, buckets) {
  if (categorySlug === "all") return standaloneTasks;
  if (categorySlug === "inbox") {
    const known = buckets.map((b) => b.slug);
    return standaloneTasks.filter((t) => !t.lifeAreas.some((a) => known.includes(a)));
  }
  return standaloneTasks.filter((t) => t.lifeAreas.includes(categorySlug));
}

const BUCKETS = [
  { slug: "work", label: "Work" },
  { slug: "health", label: "Health" },
  { slug: "georgian", label: "Georgian" },
];
const T = (status, lifeAreas) => ({
  path: "", id: "", title: "t", status, priority: null, project: null,
  phase: null, lifeAreas, due: null, updated: null,
});

// --- statusChipsFromGroups ---
const groups = [
  { slug: "active", label: "Active", open: true, projects: [{}, {}, {}] },
  { slug: "done", label: "Done", open: false, projects: [{}] },
  { slug: "other", label: "Other", open: true, projects: [{}, {}] },
];
const chips = statusChipsFromGroups(groups);
assert.deepEqual(chips.map((c) => c.slug), ["active", "done", "other"], "chip order preserved");
assert.equal(chips[0].count, 3, "active count");
assert.equal(chips[2].label, "Other", "other label preserved");
assert.deepEqual(statusChipsFromGroups([]), [], "no groups -> no chips");

// --- splitProjectTasks ---
const split = splitProjectTasks([
  T("open", []), T("in-progress", []), T("done", []), T("open", []),
]);
assert.equal(split.doing.length, 1, "1 in-progress");
assert.equal(split.open.length, 2, "2 open");
assert.equal(split.done.length, 1, "1 done");

// --- categoryChipsFromTasks ---
const standalone = [
  T("open", ["work"]), T("open", ["work"]), T("open", ["health"]), T("open", ["unknown"]), T("open", []),
];
const catChips = categoryChipsFromTasks(standalone, BUCKETS);
assert.deepEqual(catChips.map((c) => c.slug), ["work", "health", "inbox"], "only non-empty cats + inbox, in bucket order");
assert.equal(catChips[0].count, 2, "work count");
assert.equal(catChips[2].count, 2, "inbox = unknown + none");
assert.deepEqual(categoryChipsFromTasks([], BUCKETS), [], "no tasks -> no chips");

// --- tagForTask ---
assert.equal(tagForTask(T("open", ["health", "work"]), BUCKETS).slug, "work", "first in bucket order wins (work before health)");
assert.equal(tagForTask(T("open", ["zzz"]), BUCKETS).slug, "inbox", "unrecognized -> inbox");
assert.equal(tagForTask(T("open", []), BUCKETS).label, "Inbox", "none -> Inbox label");

// --- filterStandaloneByCategory ---
assert.equal(filterStandaloneByCategory(standalone, "all", BUCKETS).length, 5, "all passthrough");
assert.equal(filterStandaloneByCategory(standalone, "work", BUCKETS).length, 2, "work filter");
assert.equal(filterStandaloneByCategory(standalone, "inbox", BUCKETS).length, 2, "inbox filter");

// --- visiblePhaseTasks (MIRROR of main.ts; keep in sync) ---
function sortTasks(a, b) {
  const pa = a.priority ?? 5;
  const pb = b.priority ?? 5;
  if (pa !== pb) return pa - pb;
  const da = a.due || "9999";
  const db = b.due || "9999";
  if (da !== db) return da < db ? -1 : 1;
  return a.title.localeCompare(b.title);
}
function visiblePhaseTasks(phaseTasks, showOpen, showComplete) {
  return phaseTasks
    .filter(
      (t) => (t.status === "open" && showOpen) || (t.status === "done" && showComplete)
    )
    .sort(sortTasks);
}

const PT = (status, title, priority) => ({
  path: "", id: "", title, status, priority: priority ?? null,
  project: "p", phase: "Build", lifeAreas: [], due: null, updated: null,
});
const phaseSet = [
  PT("open", "b-open", 3),
  PT("done", "a-done", 3),
  PT("in-progress", "wip", 1),
  PT("cancelled", "dead", 3),
  PT("open", "a-open", 3),
];
// both toggles on: open + done only, sorted (priority then title): a-done, a-open, b-open
const both = visiblePhaseTasks(phaseSet, true, true);
assert.deepEqual(both.map((t) => t.title), ["a-done", "a-open", "b-open"], "both: open+done interleaved in sort order, no wip/cancelled");
// open only
const openOnly = visiblePhaseTasks(phaseSet, true, false);
assert.deepEqual(openOnly.map((t) => t.title), ["a-open", "b-open"], "open-only excludes done");
// complete only
const doneOnly = visiblePhaseTasks(phaseSet, false, true);
assert.deepEqual(doneOnly.map((t) => t.title), ["a-done"], "complete-only is just done");
// neither
assert.deepEqual(visiblePhaseTasks(phaseSet, false, false), [], "neither toggle -> empty");
// in-progress and cancelled are never returned regardless of toggles
assert.equal(visiblePhaseTasks(phaseSet, true, true).some((t) => t.status === "in-progress" || t.status === "cancelled"), false, "wip and cancelled never shown");

console.log("viewModel: all assertions passed");
