// Tests for the health-strip data model: computeHealth (pure). Imports the
// SAME module main.ts bundles (model.mjs). Run: node healthModel.test.mjs
import assert from "node:assert";
import { computeHealth, HEALTH_TILE_PROMPTS } from "./model.mjs";

const THRESH = { intakeWarnDays: 7, inProgressStaleDays: 7, openStaleDays: 45 };
const emptyInput = () => ({
  intakeFiles: [],
  journalFiles: [],
  tasks: [],
  projectSlugs: [],
  unresolvedLinks: [],
  linkCheckExcludes: [],
  thresholds: THRESH,
});

// --- all-healthy: no tiles at all ---
assert.deepEqual(computeHealth(emptyInput()), [], "empty input -> no tiles (calm when healthy)");

// --- intake backlog ---
{
  const input = emptyInput();
  input.intakeFiles = [
    { path: "Intake/README.md", name: "README.md", ageDays: 999 },
    { path: "Intake/.DS_Store", name: ".DS_Store", ageDays: 999 },
    { path: "Intake/note-a.md", name: "note-a.md", ageDays: 3 },
    { path: "Intake/note-b.md", name: "note-b.md", ageDays: 10 },
  ];
  const tiles = computeHealth(input);
  const tile = tiles.find((t) => t.key === "intake");
  assert.ok(tile, "intake tile present");
  assert.equal(tile.count, 2, "README and dotfile excluded");
  assert.equal(tile.warn, true, "oldest (10d) > warn threshold (7d)");
  assert.equal(tile.items[0].label, "note-b.md", "sorted oldest first");
}
{
  const input = emptyInput();
  input.intakeFiles = [{ path: "Intake/note.md", name: "note.md", ageDays: 2 }];
  const tile = computeHealth(input).find((t) => t.key === "intake");
  assert.equal(tile.warn, false, "under threshold -> no warn");
}

// --- stale in-progress / stale open ---
{
  const input = emptyInput();
  input.tasks = [
    { path: "t1", title: "fresh wip", status: "in-progress", declaredStatus: null, project: null, ageDays: 2 },
    { path: "t2", title: "stale wip", status: "in-progress", declaredStatus: null, project: null, ageDays: 8 },
    { path: "t3", title: "fresh open", status: "open", declaredStatus: null, project: null, ageDays: 10 },
    { path: "t4", title: "stale open", status: "open", declaredStatus: null, project: null, ageDays: 50 },
  ];
  const tiles = computeHealth(input);
  const wip = tiles.find((t) => t.key === "stale-in-progress");
  const open = tiles.find((t) => t.key === "stale-open");
  assert.equal(wip.count, 1, "only the stale wip task counted");
  assert.equal(wip.items[0].label, "stale wip", "correct item surfaced");
  assert.equal(open.count, 1, "only the stale open task counted");
  assert.equal(open.items[0].label, "stale open", "correct item surfaced");
}

// --- un-mined journal ---
{
  const input = emptyInput();
  input.journalFiles = [
    { path: "Wiki/Journal/INDEX.md", name: "INDEX.md", ingested: false },
    { path: "Wiki/Journal/2026-07-01.md", name: "2026-07-01.md", ingested: false },
    { path: "Wiki/Journal/2026-07-02.md", name: "2026-07-02.md", ingested: true },
  ];
  const tile = computeHealth(input).find((t) => t.key === "journal-unmined");
  assert.ok(tile, "unmined tile present");
  assert.equal(tile.count, 1, "INDEX.md excluded, ingested:true excluded");
  assert.equal(tile.items[0].label, "2026-07-01.md", "correct file surfaced");
}

// --- orphan tasks ---
{
  const input = emptyInput();
  input.projectSlugs = ["known-proj"];
  input.tasks = [
    { path: "t1", title: "ok", status: "open", declaredStatus: null, project: "known-proj", ageDays: 1 },
    { path: "t2", title: "orphan", status: "open", declaredStatus: null, project: "ghost-proj", ageDays: 1 },
    { path: "t3", title: "standalone", status: "open", declaredStatus: null, project: null, ageDays: 1 },
  ];
  const tile = computeHealth(input).find((t) => t.key === "orphan-tasks");
  assert.ok(tile, "orphan tile present");
  assert.equal(tile.count, 1, "only the ghost-project task counted");
  assert.equal(tile.items[0].detail, "project: ghost-proj", "detail names the unknown project");
}

// --- status/folder mismatch ---
{
  const input = emptyInput();
  input.tasks = [
    {
      path: "Operations/tasks/open/tsk-1.md",
      title: "matches",
      status: "open",
      declaredStatus: "open",
      project: null,
      ageDays: 1,
    },
    {
      path: "Operations/tasks/open/tsk-2.md",
      title: "mismatched",
      status: "open",
      declaredStatus: "done",
      project: null,
      ageDays: 1,
    },
    {
      path: "Operations/tasks/open/tsk-3.md",
      title: "no declared status",
      status: "open",
      declaredStatus: null,
      project: null,
      ageDays: 1,
    },
  ];
  const tile = computeHealth(input).find((t) => t.key === "status-mismatch");
  assert.ok(tile, "mismatch tile present");
  assert.equal(tile.count, 1, "only the mismatched task counted");
  assert.equal(tile.items[0].label, "mismatched", "correct item surfaced");
}

// --- broken links ---
{
  const input = emptyInput();
  input.linkCheckExcludes = ["Wiki/daily"];
  input.unresolvedLinks = [
    { source: "Wiki/notes/a.md", target: "Missing Page", count: 2 },
    { source: "Wiki/notes/a.md", target: "Another Missing", count: 1 },
    { source: "Wiki/daily/2026-07-01.md", target: "Missing", count: 5 },
    { source: "Wiki/daily/sub/2026-07-02.md", target: "Missing", count: 3 },
  ];
  const tile = computeHealth(input).find((t) => t.key === "broken-links");
  assert.ok(tile, "broken-links tile present");
  assert.equal(tile.count, 3, "excludes Wiki/daily and its subpaths, sums counts for the rest");
  assert.equal(tile.items[0].path, "Wiki/notes/a.md", "grouped by source");
  assert.equal(tile.items[0].detail, "3 broken links", "counts summed per source");
}
{
  const input = emptyInput();
  input.unresolvedLinks = [{ source: "Wiki/daily/x.md", target: "y", count: 1 }];
  input.linkCheckExcludes = ["Wiki/daily"];
  assert.equal(
    computeHealth(input).find((t) => t.key === "broken-links"),
    undefined,
    "fully excluded sources produce no tile"
  );
}

// --- canned prompts: every tile carries its Dispatch prompt, and shared tiles
//     (the two stale-task tiles, the two consistency tiles) share the exact
//     same wording ---
{
  const input = emptyInput();
  input.intakeFiles = [{ path: "Intake/note.md", name: "note.md", ageDays: 10 }];
  input.journalFiles = [{ path: "Wiki/Journal/x.md", name: "x.md", ingested: false }];
  input.projectSlugs = ["known-proj"];
  input.tasks = [
    { path: "t1", title: "wip", status: "in-progress", declaredStatus: null, project: null, ageDays: 8 },
    { path: "t2", title: "open", status: "open", declaredStatus: null, project: null, ageDays: 50 },
    { path: "t3", title: "orphan", status: "open", declaredStatus: null, project: "ghost", ageDays: 1 },
    {
      path: "Operations/tasks/open/tsk-4.md",
      title: "mismatched",
      status: "open",
      declaredStatus: "done",
      project: null,
      ageDays: 1,
    },
  ];
  input.unresolvedLinks = [{ source: "Wiki/notes/a.md", target: "Missing", count: 1 }];
  const tiles = computeHealth(input);
  const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.equal(byKey["intake"].prompt, HEALTH_TILE_PROMPTS["intake"], "intake tile carries its canned prompt");
  assert.equal(
    byKey["journal-unmined"].prompt,
    HEALTH_TILE_PROMPTS["journal-unmined"],
    "journal-unmined tile carries its canned prompt"
  );
  assert.equal(
    byKey["stale-in-progress"].prompt,
    byKey["stale-open"].prompt,
    "the two stale-task tiles share the same reconcile prompt"
  );
  assert.equal(
    byKey["orphan-tasks"].prompt,
    byKey["status-mismatch"].prompt,
    "the two consistency tiles share the same fix prompt"
  );
  assert.equal(
    byKey["broken-links"].prompt,
    HEALTH_TILE_PROMPTS["broken-links"],
    "broken-links tile carries its canned prompt"
  );
  for (const tile of tiles) {
    assert.ok(typeof tile.prompt === "string" && tile.prompt.length > 0, `${tile.key} tile has a non-empty prompt`);
  }
}

console.log("healthModel: all assertions passed");
