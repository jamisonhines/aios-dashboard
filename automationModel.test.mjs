// Tests for the Automations strip view model (build 2.6 m2): prefix
// stripping, relative time, per-job Dispatch prompt, red-first tile ordering,
// and the counts-by-state summary milestone 3 consumes. Imports the SAME
// module main.ts bundles (model.mjs). Run: node automationModel.test.mjs
import assert from "node:assert";
import {
  AUTOMATION_STATE_ORDER,
  AUTOMATION_STATE_LABELS,
  stripAutomationPrefix,
  formatRelativeAgo,
  formatRelativeUntil,
  automationFixPrompt,
  automationSummaryCounts,
  computeAutomationView,
} from "./model.mjs";

const NOW = new Date("2026-07-11T12:00:00Z");

// --- state order + labels ---
assert.deepEqual(AUTOMATION_STATE_ORDER, ["unknown", "error", "overdue", "running", "ok"]);
assert.equal(AUTOMATION_STATE_LABELS.unknown, "not loaded", "unknown surfaces as 'not loaded'");

// --- stripAutomationPrefix ---
assert.equal(stripAutomationPrefix("com.jaymo.morning-brief"), "morning-brief");
assert.equal(stripAutomationPrefix("com.aios.meeting-sync"), "meeting-sync");
assert.equal(stripAutomationPrefix("ge.vagabondadventures.triage"), "triage");
assert.equal(
  stripAutomationPrefix("com.jaymo.tgclaude.evening"),
  "tgclaude.evening",
  "only the registered prefix is stripped"
);
assert.equal(stripAutomationPrefix("org.unknown.job"), "org.unknown.job", "unknown prefix passes through");

// --- formatRelativeAgo ---
assert.equal(formatRelativeAgo(null, NOW), "no activity");
assert.equal(formatRelativeAgo("not-a-date", NOW), "no activity");
assert.equal(formatRelativeAgo("2026-07-11T11:59:40Z", NOW), "just now");
assert.equal(formatRelativeAgo("2026-07-11T11:15:00Z", NOW), "45m ago");
assert.equal(formatRelativeAgo("2026-07-11T09:00:00Z", NOW), "3h ago");
assert.equal(formatRelativeAgo("2026-07-09T11:00:00Z", NOW), "2d ago");
assert.equal(formatRelativeAgo("2026-07-11T13:00:00Z", NOW), "just now", "future clamps to just now");

// --- formatRelativeUntil ---
assert.equal(formatRelativeUntil(null, NOW), null);
assert.equal(formatRelativeUntil("2026-07-11T11:00:00Z", NOW), "now", "past -> now");
assert.equal(formatRelativeUntil("2026-07-11T12:30:00Z", NOW), "in 30m");
assert.equal(formatRelativeUntil("2026-07-11T15:00:00Z", NOW), "in 3h");
assert.equal(formatRelativeUntil("2026-07-13T12:00:00Z", NOW), "in 2d");

// --- automationFixPrompt ---
{
  const prompt = automationFixPrompt({
    label: "com.jaymo.morning-brief",
    state: "error",
    lastExitStatus: 127,
    logPath: "/Users/jaymo/Library/Logs/morning-brief.log",
  });
  assert.equal(
    prompt,
    "The launchd job com.jaymo.morning-brief is in state error (last exit 127, " +
      "log /Users/jaymo/Library/Logs/morning-brief.log). Diagnose why and propose a fix; " +
      "do not restart anything without confirming the root cause first."
  );
}
{
  const prompt = automationFixPrompt({ label: "x", state: "unknown", lastExitStatus: null, logPath: null });
  assert.ok(prompt.includes("state not loaded"), "unknown state reads as 'not loaded'");
  assert.ok(prompt.includes("last exit unknown"), "null exit reads as unknown");
  assert.ok(prompt.includes("log none"), "null log reads as none");
}

// --- automationSummaryCounts ---
assert.deepEqual(
  automationSummaryCounts([]),
  { unknown: 0, error: 0, overdue: 0, running: 0, ok: 0 },
  "empty list -> all zero, every key present"
);
assert.deepEqual(
  automationSummaryCounts([
    { state: "error" },
    { state: "error" },
    { state: "ok" },
    { state: "running" },
    { state: "overdue" },
    { state: "unknown" },
    { state: "bogus" },
  ]),
  { unknown: 1, error: 2, overdue: 1, running: 1, ok: 1 },
  "counts by state; unrecognized states ignored"
);

// --- computeAutomationView ---
{
  const health = {
    generatedAt: "2026-07-11T11:00:00Z",
    jobs: [
      {
        label: "com.jaymo.supabase-keepalive",
        schedule: "Mon 09:00 / Thu 09:00",
        lastActivity: "2026-07-09T09:00:00Z",
        lastExitStatus: 0,
        pid: null,
        nextExpected: "2026-07-13T09:00:00Z",
        state: "ok",
        logPath: "/Users/jaymo/Library/Logs/supabase-keepalive.err",
      },
      {
        label: "com.jaymo.morning-brief",
        schedule: "daily 07:00",
        lastActivity: "2026-07-11T07:00:00Z",
        lastExitStatus: 127,
        pid: null,
        nextExpected: "2026-07-12T07:00:00Z",
        state: "error",
        logPath: "/Users/jaymo/Library/Logs/morning-brief.log",
      },
      {
        label: "com.jaymo.dispatch-bot",
        schedule: "at load",
        lastActivity: "2026-07-11T11:59:00Z",
        lastExitStatus: 0,
        pid: 2172,
        nextExpected: null,
        state: "running",
        logPath: "/Users/jaymo/.aios/bridge/logs/bot.out",
      },
      {
        label: "com.jaymo.ghost-job",
        schedule: "daily 03:00",
        lastActivity: null,
        lastExitStatus: null,
        pid: null,
        nextExpected: "2026-07-12T03:00:00Z",
        state: "unknown",
        logPath: null,
      },
    ],
  };
  const view = computeAutomationView(health, NOW);
  assert.deepEqual(
    view.tiles.map((t) => t.label),
    [
      "com.jaymo.ghost-job",
      "com.jaymo.morning-brief",
      "com.jaymo.dispatch-bot",
      "com.jaymo.supabase-keepalive",
    ],
    "tiles sorted red-first: unknown, error, running, ok"
  );
  const brief = view.tiles.find((t) => t.label === "com.jaymo.morning-brief");
  assert.equal(brief.shortLabel, "morning-brief");
  assert.equal(brief.state, "error");
  assert.equal(brief.stateLabel, "error");
  assert.equal(brief.relativeLastActivity, "5h ago");
  assert.equal(brief.lastExitStatus, 127);
  assert.equal(brief.nextExpectedRelative, "in 19h");
  assert.ok(brief.prompt.includes("com.jaymo.morning-brief"), "prompt carries the full label");
  const ghost = view.tiles.find((t) => t.label === "com.jaymo.ghost-job");
  assert.equal(ghost.stateLabel, "not loaded");
  assert.equal(ghost.relativeLastActivity, "no activity");
  assert.deepEqual(view.counts, { unknown: 1, error: 1, overdue: 0, running: 1, ok: 1 });
}
{
  // Defensive: null payload, malformed jobs, unrecognized state.
  assert.deepEqual(computeAutomationView(null, NOW).tiles, [], "null payload -> no tiles");
  assert.deepEqual(computeAutomationView({}, NOW).tiles, [], "missing jobs -> no tiles");
  const view = computeAutomationView(
    { jobs: [{ label: "com.jaymo.x", state: "weird" }, { nope: true }, null] },
    NOW
  );
  assert.equal(view.tiles.length, 1, "label-less entries dropped");
  assert.equal(view.tiles[0].state, "unknown", "unrecognized state coerced to unknown");
}

console.log("automationModel.test.mjs: all assertions passed");
