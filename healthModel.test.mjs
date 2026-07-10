// Tests for the health-strip data model: computeHealth (pure). Mirror of the
// function under test (kept in sync with main.ts). Run: node healthModel.test.mjs
import assert from "node:assert";

function healthInferStatusFromPath(path) {
  if (path.includes("/done/")) return "done";
  if (path.includes("/cancelled/")) return "cancelled";
  if (path.includes("/in-progress/")) return "in-progress";
  return "open";
}

function excludedBySource(source, excludes) {
  return excludes.some((ex) => source === ex || source.startsWith(ex + "/"));
}

const HEALTH_TILE_PROMPTS = {
  intake:
    "Process the Intake inbox: route each item per AGENTS.md (Capture for personal, SOP-ingest-source for external content).",
  "journal-unmined":
    "List journal entries with ingested: false and ingest the ones worth mining per GL-007: create derived area notes linking back, then flip ingested to true.",
  "stale-in-progress":
    "Run a task reconcile pass per Dispatch's reconcile protocol: flip shipped tasks to done with evidence, cancel overtaken ones, list uncertain ones.",
  "stale-open":
    "Run a task reconcile pass per Dispatch's reconcile protocol: flip shipped tasks to done with evidence, cancel overtaken ones, list uncertain ones.",
  "orphan-tasks":
    "Fix task-layer consistency: repoint or fix tasks whose project slug matches no hub and tasks whose status disagrees with their folder.",
  "status-mismatch":
    "Fix task-layer consistency: repoint or fix tasks whose project slug matches no hub and tasks whose status disagrees with their folder.",
  "broken-links":
    "Fix broken wikilinks per GL-001: repoint renamed targets, convert out-of-vault targets to backtick paths, strip dead ones.",
};

function computeHealth(input) {
  const tiles = [];

  // 1. Intake backlog.
  const intake = input.intakeFiles.filter((f) => f.name !== "README.md" && !f.name.startsWith("."));
  if (intake.length > 0) {
    const sorted = intake.slice().sort((a, b) => b.ageDays - a.ageDays);
    const oldest = sorted[0].ageDays;
    tiles.push({
      key: "intake",
      label: "Intake backlog",
      count: intake.length,
      summary: `${intake.length} · oldest ${oldest}d`,
      warn: oldest > input.thresholds.intakeWarnDays,
      items: sorted.map((f) => ({ path: f.path, label: f.name, detail: `${f.ageDays}d old` })),
      prompt: HEALTH_TILE_PROMPTS["intake"],
    });
  }

  // 2. Stale in-progress.
  const staleInProgress = input.tasks.filter(
    (t) => t.status === "in-progress" && t.ageDays > input.thresholds.inProgressStaleDays
  );
  if (staleInProgress.length > 0) {
    tiles.push({
      key: "stale-in-progress",
      label: "Stale in-progress",
      count: staleInProgress.length,
      summary: `${staleInProgress.length}`,
      warn: true,
      items: staleInProgress
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((t) => ({ path: t.path, label: t.title, detail: `${t.ageDays}d since update` })),
      prompt: HEALTH_TILE_PROMPTS["stale-in-progress"],
    });
  }

  // 3. Stale open.
  const staleOpen = input.tasks.filter(
    (t) => t.status === "open" && t.ageDays > input.thresholds.openStaleDays
  );
  if (staleOpen.length > 0) {
    tiles.push({
      key: "stale-open",
      label: "Stale open",
      count: staleOpen.length,
      summary: `${staleOpen.length}`,
      warn: true,
      items: staleOpen
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((t) => ({ path: t.path, label: t.title, detail: `${t.ageDays}d since update` })),
      prompt: HEALTH_TILE_PROMPTS["stale-open"],
    });
  }

  // 4. Un-mined journal.
  const unmined = input.journalFiles.filter((f) => f.name !== "INDEX.md" && !f.ingested);
  if (unmined.length > 0) {
    tiles.push({
      key: "journal-unmined",
      label: "journal not mined",
      count: unmined.length,
      summary: `${unmined.length}`,
      warn: false,
      items: unmined.map((f) => ({ path: f.path, label: f.name, detail: "not ingested" })),
      prompt: HEALTH_TILE_PROMPTS["journal-unmined"],
    });
  }

  // 5. Orphan tasks.
  const knownSlugs = new Set(input.projectSlugs);
  const orphans = input.tasks.filter((t) => t.project != null && !knownSlugs.has(t.project));
  if (orphans.length > 0) {
    tiles.push({
      key: "orphan-tasks",
      label: "Orphan tasks",
      count: orphans.length,
      summary: `${orphans.length}`,
      warn: true,
      items: orphans.map((t) => ({ path: t.path, label: t.title, detail: `project: ${t.project}` })),
      prompt: HEALTH_TILE_PROMPTS["orphan-tasks"],
    });
  }

  // 6. Status/folder mismatch.
  const mismatches = input.tasks.filter(
    (t) => t.declaredStatus != null && t.declaredStatus !== healthInferStatusFromPath(t.path)
  );
  if (mismatches.length > 0) {
    tiles.push({
      key: "status-mismatch",
      label: "Status/folder mismatch",
      count: mismatches.length,
      summary: `${mismatches.length}`,
      warn: true,
      items: mismatches.map((t) => ({
        path: t.path,
        label: t.title,
        detail: `status: ${t.declaredStatus}, folder: ${healthInferStatusFromPath(t.path)}`,
      })),
      prompt: HEALTH_TILE_PROMPTS["status-mismatch"],
    });
  }

  // 7. Broken links.
  const links = input.unresolvedLinks.filter((l) => !excludedBySource(l.source, input.linkCheckExcludes));
  const brokenTotal = links.reduce((sum, l) => sum + l.count, 0);
  if (brokenTotal > 0) {
    const bySource = new Map();
    for (const l of links) bySource.set(l.source, (bySource.get(l.source) || 0) + l.count);
    const items = Array.from(bySource.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({
        path: source,
        label: source,
        detail: `${count} broken link${count === 1 ? "" : "s"}`,
      }));
    tiles.push({
      key: "broken-links",
      label: "Broken links",
      count: brokenTotal,
      summary: `${brokenTotal}`,
      warn: true,
      items,
      prompt: HEALTH_TILE_PROMPTS["broken-links"],
    });
  }

  return tiles;
}

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
