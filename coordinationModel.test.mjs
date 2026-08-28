// Tests for the Coordination-panel data model: computeCoordinationView (pure).
// Imports the SAME module main.ts bundles (model.mjs). Mirrors the exact
// definitions in Operations/scripts/coordination-report.mjs: active = row
// status lowercased equals "active"; stale = active AND hoursSince(lastUpdate)
// > 24; merge queue size = parseLandingOrder items where landed is false.
// Run: node coordinationModel.test.mjs
import assert from "node:assert";
import { computeCoordinationView } from "./model.mjs";

const NOW = new Date("2026-08-29T09:30:00Z");

function ledger(rows, landingLines) {
  return [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "repo: ~/Projects/proj-a",
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Active sessions",
    "",
    "| Session | Branch | Worktree | Write-set | Started | Last update | Status |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Merge queue",
    "",
    "<!-- AUTO:BEGIN branch-inventory -->",
    "(none)",
    "<!-- AUTO:END -->",
    "",
    "### Landing order",
    "",
    ...landingLines,
    "",
  ].join("\n");
}

function questions(entries) {
  return [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "updated: 2026-08-28",
    "---",
    "",
    "# Questions for Jaymo",
    "",
    "## Open",
    "",
    ...entries,
    "## Answered",
    "",
    "(none)",
    "",
  ].join("\n");
}

// --- basic shape: active filtering, stale flagging, unlanded count, questions passthrough ---
{
  const LEDGER = ledger(
    [
      "| coder-build | feat/x | ~/Projects/proj-a | src/foo.ts | 2026-08-29T08:00:00Z | 2026-08-29T09:00:00Z | active |",
      "| old-session | feat/y | ~/Projects/proj-a | src/bar.ts | 2026-08-27T08:00:00Z | 2026-08-27T09:00:00Z | Active |",
      "| finished-session | feat/z | ~/Projects/proj-a | src/baz.ts | 2026-08-26T08:00:00Z | 2026-08-29T08:30:00Z | done |",
    ],
    ["1. feat/x - landed", "2. feat/y - ready", "3. feat/z - ready"]
  );
  const QUESTIONS = questions([
    "### Q-2026-08-28-01 Answered but unfiled question",
    "- Context: c",
    "- Asked by: s, 2026-08-28",
    "- Answer: yes go ahead",
    "",
    "### Q-2026-08-28-02 Still blank",
    "- Context: c",
    "- Asked by: s, 2026-08-28",
    "- Answer:",
    "",
  ]);

  const views = computeCoordinationView(
    [{ slug: "proj-a", ledgerContent: LEDGER, questionsContent: QUESTIONS }],
    NOW
  );
  assert.equal(views.length, 1, "one input project -> one view");
  const v = views[0];
  assert.equal(v.slug, "proj-a");

  assert.equal(v.activeSessions.length, 2, "'done' status row excluded; both 'active'/'Active' rows included");
  assert.deepEqual(
    v.activeSessions.map((s) => s.session),
    ["coder-build", "old-session"],
    "status match is case-insensitive, source order preserved"
  );
  assert.deepEqual(v.activeSessions[0], {
    session: "coder-build",
    branch: "feat/x",
    lastUpdate: "2026-08-29T09:00:00Z",
    stale: false,
  }, "0.5h since last update -> not stale");
  assert.deepEqual(v.activeSessions[1], {
    session: "old-session",
    branch: "feat/y",
    lastUpdate: "2026-08-27T09:00:00Z",
    stale: true,
  }, "48.5h since last update -> stale");

  assert.equal(v.unlanded, 2, "2 of 3 landing-order items are not landed (item 1 says 'landed')");

  assert.deepEqual(v.questions, [
    { id: "Q-2026-08-28-01", date: "2026-08-28", title: "Answered but unfiled question", answer: "yes go ahead" },
    { id: "Q-2026-08-28-02", date: "2026-08-28", title: "Still blank", answer: "" },
  ]);
}

// --- stale boundary: exactly 24h is NOT stale (matches coordination-report.mjs's strict `> 24`) ---
{
  const LEDGER = ledger(
    ["| s1 | feat/x | wt | file.ts | 2026-08-28T09:30:00Z | 2026-08-28T09:30:00Z | active |"],
    ["1. feat/x - ready"]
  );
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.equal(views[0].activeSessions[0].stale, false, "exactly 24h since last update is not > 24, so not stale");
}
{
  const LEDGER = ledger(
    ["| s1 | feat/x | wt | file.ts | 2026-08-28T09:29:59Z | 2026-08-28T09:29:59Z | active |"],
    ["1. feat/x - ready"]
  );
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.equal(views[0].activeSessions[0].stale, true, "24h and 1 second since last update IS stale");
}

// --- questionsContent missing or null -> empty questions, no throw ---
{
  const LEDGER = ledger([], ["1. feat/x - ready"]);
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.deepEqual(views[0].questions, [], "null questionsContent -> no questions, not an error");
  const views2 = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER }], NOW);
  assert.deepEqual(views2[0].questions, [], "missing questionsContent key -> no questions, not an error");
}

// --- no active sessions, no landing order -> zeroed, not throw ---
{
  const LEDGER = ledger([], []);
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.deepEqual(views[0].activeSessions, []);
  assert.equal(views[0].unlanded, 0);
}

// --- multiple projects: one view per input, in input order ---
{
  const LEDGER = ledger([], []);
  const views = computeCoordinationView(
    [
      { slug: "proj-b", ledgerContent: LEDGER, questionsContent: null },
      { slug: "proj-a", ledgerContent: LEDGER, questionsContent: null },
    ],
    NOW
  );
  assert.deepEqual(views.map((v) => v.slug), ["proj-b", "proj-a"], "input order is preserved, not re-sorted");
}

// --- empty inputs -> empty output ---
assert.deepEqual(computeCoordinationView([], NOW), [], "no participating projects -> no views");

console.log("coordinationModel.test.mjs: all assertions passed");
