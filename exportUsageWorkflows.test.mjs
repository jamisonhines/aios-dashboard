// Tests for the exporter's workflow classifier (build 2.5 m1). Imports the
// REAL functions from the repo-canonical exporter (vault-scripts/, deployed
// to the vault by deploy.sh). Importing the exporter never starts a scan
// (direct-execution guard). Run: node exportUsageWorkflows.test.mjs
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractTextContent,
  FIRST_COMMAND_RE,
  buildWorkflowRules,
  classifyWorkflow,
  createSkillSegmenter,
  isToolResultContent,
  LOCAL_COMMAND_STDOUT_RE,
  BUILTIN_COMMANDS,
  estimateCost,
  resolveSonnetRate,
  SONNET_INTRO_RATE,
  SONNET_STANDARD_RATE,
  SONNET_INTRO_CUTOFF_DAY,
  foldWorkflowEntry,
  parseTranscript,
  applyTranscriptToAggregates,
} from "./vault-scripts/export-usage-stats.mjs";

function baseCtx(overrides) {
  return {
    project: "AIOS",
    sessionId: "some-session-id",
    firstCommand: undefined,
    firstUserContent: "",
    ...overrides,
  };
}

// --- extractTextContent: string and array-of-blocks content ---
assert.equal(extractTextContent("plain string"), "plain string", "string content passes through");
assert.equal(
  extractTextContent([{ type: "text", text: "hello " }, { type: "text", text: "world" }]),
  "hello world",
  "array content blocks are joined by their text fields"
);
assert.equal(
  extractTextContent([{ type: "tool_use", input: {} }, { type: "text", text: "after tool" }]),
  "after tool",
  "blocks without a text field contribute nothing (not undefined/[object Object])"
);
assert.equal(extractTextContent(undefined), "", "missing content -> empty string");

// --- rule 1: bridge session id set ---
{
  const rules = buildWorkflowRules(new Set(["abc-123"]));
  const rule = classifyWorkflow(rules, baseCtx({ sessionId: "abc-123" }));
  assert.equal(rule.key, "telegram-bridge", "session id in bridge set -> telegram-bridge");
}

// --- rule 2: telegram ingest (WS-004), both trigger phrases ---
{
  const rules = buildWorkflowRules(new Set());
  const r1 = classifyWorkflow(rules, baseCtx({ firstUserContent: "Run WS-004 ingest please" }));
  assert.equal(r1.key, "telegram-ingest", "'Run WS-004' prefix -> telegram-ingest");
  const r2 = classifyWorkflow(rules, baseCtx({ firstUserContent: "kick off the ingest-and-upgrade flow" }));
  assert.equal(r2.key, "telegram-ingest", "'ingest-and-upgrade' substring -> telegram-ingest");
}

// --- rule 3-6: vgb-prefixed slash commands ---
{
  const rules = buildWorkflowRules(new Set());
  assert.equal(
    classifyWorkflow(rules, baseCtx({ firstCommand: "/vgb-email-router" })).key,
    "email-router",
    "/vgb-email-router -> email-router"
  );
  assert.equal(
    classifyWorkflow(rules, baseCtx({ firstCommand: "/vgb-draft-followup" })).key,
    "email-followups",
    "/vgb-draft-followup -> email-followups"
  );
  assert.equal(
    classifyWorkflow(rules, baseCtx({ firstCommand: "/vgb-draft-postmortem" })).key,
    "email-postmortem",
    "/vgb-draft-postmortem -> email-postmortem"
  );
  assert.equal(
    classifyWorkflow(rules, baseCtx({ firstCommand: "/vgb-archive-noise" })).key,
    "email-other",
    "other /vgb- command -> email-other (fallback within the vgb family)"
  );
}

// --- rule 7: learning-scan project folder ---
{
  const rules = buildWorkflowRules(new Set());
  const rule = classifyWorkflow(rules, baseCtx({ project: "AIOS-Operations-learning-scan" }));
  assert.equal(rule.key, "learning-scan", "project folder ending in Operations-learning-scan -> learning-scan");
}

// --- rule 8: fallback ---
{
  const rules = buildWorkflowRules(new Set());
  const rule = classifyWorkflow(rules, baseCtx({}));
  assert.equal(rule.key, "interactive", "no other rule matches -> interactive fallback");
}

// --- order matters: first match wins even if a later rule would also match ---
{
  const rules = buildWorkflowRules(new Set(["session-x"]));
  // This session id is in the bridge set AND its first command looks like an
  // email automation -- bridge (rule 1) must win because it is evaluated first.
  const rule = classifyWorkflow(
    rules,
    baseCtx({ sessionId: "session-x", firstCommand: "/vgb-email-router" })
  );
  assert.equal(rule.key, "telegram-bridge", "earlier rule wins over a later one that would also match");
}

// --- firstCommand extraction via regex, including array-content first message ---
{
  const raw = [
    { type: "text", text: "<command-name>/vgb-draft-followup</command-name>\nsome extra args" },
  ];
  const firstUserContent = extractTextContent(raw).slice(0, 500);
  const match = FIRST_COMMAND_RE.exec(firstUserContent);
  assert.ok(match, "regex finds the command-name tag inside array-joined content");
  assert.equal(match[1], "/vgb-draft-followup", "captured command includes the leading slash");
}

// --- skill segmenter (build 2.9): per-invocation attribution ---
const OPUS = { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const marker = (name) => `<command-name>/${name}</command-name>`;

// Baseline: a run opens at the marker, collects assistant usage, closes at the
// next human message. Work before the marker belongs to nobody.
{
  const seg = createSkillSegmenter();
  seg.boundary("just chatting");
  seg.usage("opus", OPUS); // pre-marker work is unattributed
  seg.boundary(marker("close-session"));
  seg.usage("opus", OPUS);
  seg.usage("opus", OPUS);
  seg.boundary("thanks, next topic");
  seg.usage("opus", OPUS); // post-run work is unattributed again
  const runs = seg.finish();
  assert.equal(runs.length, 1, "exactly one run recorded");
  assert.equal(runs[0].key, "close-session", "key is the command name without the slash");
  assert.equal(runs[0].messages, 2, "only assistant messages inside the run count");
  assert.equal(runs[0].outputTokens, 2_000_000, "output tokens sum across the run");
  assert.equal(runs[0].costUsd, 50, "cost uses the real estimateCost (opus out 25/Mtok x 2M)");
}

// The injected command body (a second user message right after the marker)
// must not close the run before it has recorded anything.
{
  const seg = createSkillSegmenter();
  seg.boundary(marker("close-session"));
  seg.boundary("<expanded command body injected by the harness>");
  seg.usage("opus", OPUS);
  const runs = seg.finish();
  assert.equal(runs.length, 1, "empty run is not emitted, and the marker survives the injection");
  assert.equal(runs[0].key, "close-session", "usage still lands on the skill");
}

// Back-to-back invocations, and a transcript ending mid-run.
{
  const seg = createSkillSegmenter();
  seg.boundary(marker("brief"));
  seg.usage("sonnet", OPUS);
  seg.boundary(marker("close-session"));
  seg.usage("sonnet", OPUS);
  const runs = seg.finish();
  assert.equal(runs.length, 2, "a new marker closes the previous run and opens the next");
  assert.deepEqual(runs.map((r) => r.key), ["brief", "close-session"], "runs keep transcript order");
}

// Builtin CLI commands (/model, /context) echo <local-command-stdout> and do
// no model work. The run must be DISCARDED so the real prompt that follows is
// not billed to the builtin.
{
  const seg = createSkillSegmenter();
  seg.boundary(marker("model"));
  seg.boundary("<local-command-stdout>Set model to claude-fable-5</local-command-stdout>");
  seg.boundary("continue"); // a genuine human prompt
  seg.usage("opus", OPUS); // ...and a lot of real work
  assert.deepEqual(seg.finish(), [], "builtin command absorbs none of the following work");
}

// A run absorbs at most ONE pre-work message, so a builtin that emits no
// stdout still cannot swallow the next real prompt indefinitely.
{
  const seg = createSkillSegmenter();
  seg.boundary(marker("some-builtin"));
  seg.boundary("injected body");
  seg.boundary("a real human prompt");
  seg.usage("opus", OPUS);
  assert.deepEqual(seg.finish(), [], "second non-marker message closes the empty run for good");
}

// Denylisted builtins never open a run at all, even without stdout.
{
  const seg = createSkillSegmenter();
  seg.boundary(marker("context"));
  seg.usage("opus", OPUS);
  assert.deepEqual(seg.finish(), [], "/context is a builtin, not a skill");
  assert.equal(BUILTIN_COMMANDS.has("close-session"), false, "real skills are not denylisted");
}

// Plugin-namespaced skills keep their colon.
{
  const seg = createSkillSegmenter();
  seg.boundary(marker("superpowers:brainstorming"));
  seg.usage("haiku", OPUS);
  assert.equal(seg.finish()[0].key, "superpowers:brainstorming", "colon-namespaced key preserved");
}

// tool_result user entries are harness plumbing, never run boundaries.
{
  assert.equal(isToolResultContent([{ type: "tool_result", content: "ok" }]), true, "tool_result detected");
  assert.equal(isToolResultContent([{ type: "text", text: "hi" }]), false, "plain text is not a tool result");
  assert.equal(isToolResultContent("plain string"), false, "string content is not a tool result");
  assert.equal(isToolResultContent(undefined), false, "missing content is not a tool result");
}

// --- Sonnet introductory rate (build 2.9 milestone A) ---
// $2 in / $10 out through 2026-08-31, $3 in / $15 out from 2026-09-01.
{
  assert.deepEqual(resolveSonnetRate("2026-08-30"), SONNET_INTRO_RATE, "day before cutoff -> intro rate");
  assert.deepEqual(resolveSonnetRate(SONNET_INTRO_CUTOFF_DAY), SONNET_INTRO_RATE, "cutoff day itself -> still intro rate (inclusive)");
  assert.deepEqual(resolveSonnetRate("2026-09-01"), SONNET_STANDARD_RATE, "day after cutoff -> standard rate");
  assert.deepEqual(resolveSonnetRate(undefined), SONNET_STANDARD_RATE, "missing dayKey falls back to standard rate");
}

// estimateCost wires the date-aware rate through for the sonnet family only.
{
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // Noon UTC keeps the local-day conversion (localDay uses the machine's
  // local timezone) safely inside the same calendar day across all real-world
  // UTC offsets, so this test isn't flaky depending on where it runs.
  const before = estimateCost("sonnet", usage, "2026-08-31T12:00:00Z");
  assert.equal(before, SONNET_INTRO_RATE.in + SONNET_INTRO_RATE.out, "on-cutoff-day entry prices at the intro rate");
  const after = estimateCost("sonnet", usage, "2026-09-01T12:00:00Z");
  assert.equal(after, SONNET_STANDARD_RATE.in + SONNET_STANDARD_RATE.out, "post-cutoff entry prices at the standard rate");
  // Non-sonnet families are unaffected by the timestamp argument.
  const opusCost = estimateCost("opus", usage, "2026-09-01T12:00:00Z");
  assert.equal(opusCost, 5 + 25, "opus rate is unchanged by the sonnet-only date logic");
}

// --- foldWorkflowEntry: per-day workflow breakdown (build 2.9 slice 2) ---
// The invariant that matters: sum(byDay) always equals the top-level totals,
// because both are written by the same fold step.
{
  const acc = { costUsd: 0, outputTokens: 0, messages: 0, byDay: new Map() };
  foldWorkflowEntry(acc, "2026-07-27", 1.5, 1000);
  foldWorkflowEntry(acc, "2026-07-27", 0.5, 500);
  foldWorkflowEntry(acc, "2026-07-28", 2.0, 2000);

  assert.equal(acc.byDay.size, 2, "two distinct days recorded, not padded across the window");
  assert.deepEqual(acc.byDay.get("2026-07-27"), { costUsd: 2.0, outputTokens: 1500, messages: 2 });
  assert.deepEqual(acc.byDay.get("2026-07-28"), { costUsd: 2.0, outputTokens: 2000, messages: 1 });

  const sumCost = [...acc.byDay.values()].reduce((s, d) => s + d.costUsd, 0);
  const sumTokens = [...acc.byDay.values()].reduce((s, d) => s + d.outputTokens, 0);
  const sumMessages = [...acc.byDay.values()].reduce((s, d) => s + d.messages, 0);
  assert.equal(sumCost, acc.costUsd, "sum(byDay.costUsd) matches the top-level total");
  assert.equal(sumTokens, acc.outputTokens, "sum(byDay.outputTokens) matches the top-level total");
  assert.equal(sumMessages, acc.messages, "sum(byDay.messages) matches the top-level total");
}

// --- parseTranscript: entries are windowed by their OWN timestamp, not the
// file's mtime (build 2.9 bugfix). findTranscripts() only prefilters which
// FILES are worth opening; a long-lived session file that passes that
// prefilter can still hold entries spanning far outside WINDOW_DAYS. ---
{
  const now = Date.now();
  const cutoffMs = now - 35 * 24 * 60 * 60 * 1000;
  const inWindowIso = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
  const outOfWindowIso = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

  const lines = [
    // Opens a skill run.
    { type: "user", timestamp: inWindowIso, isSidechain: false, message: { content: marker("test-skill") } },
    // Harness-injected expanded command body -- absorbed, not a boundary.
    { type: "user", timestamp: inWindowIso, isSidechain: false, message: { content: "expanded command body" } },
    // In-window usage entry: must survive.
    {
      type: "assistant",
      timestamp: inWindowIso,
      message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20 } },
    },
    // Out-of-window usage entry (same file, so it passed the mtime prefilter):
    // must be dropped by its own timestamp.
    {
      type: "assistant",
      timestamp: outOfWindowIso,
      message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 20 } },
    },
  ];

  const tmpFile = path.join(os.tmpdir(), `parseTranscript-window-test-${process.pid}.jsonl`);
  await fs.writeFile(tmpFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    const { entries, skillRuns } = await parseTranscript(tmpFile, cutoffMs);

    assert.equal(entries.length, 1, "only the in-window entry survives, regardless of file mtime");
    assert.equal(entries[0].model, "claude-sonnet-5", "the surviving entry is the in-window one");

    assert.equal(skillRuns.length, 1, "the skill run is still recorded once (it has an in-window message)");
    assert.equal(skillRuns[0].key, "test-skill", "skill attribution unaffected by the window fix");
    assert.equal(skillRuns[0].messages, 1, "only the in-window usage counts toward the run, the out-of-window one is excluded");
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

// --- parseTranscript: a skill run whose ONLY usage entry is out-of-window
// must not be emitted at all (messages stays 0, so the segmenter discards
// it on finish()). ---
{
  const now = Date.now();
  const cutoffMs = now - 35 * 24 * 60 * 60 * 1000;
  const outOfWindowIso = new Date(now - 50 * 24 * 60 * 60 * 1000).toISOString();

  const lines = [
    { type: "user", timestamp: outOfWindowIso, isSidechain: false, message: { content: marker("old-only-skill") } },
    { type: "user", timestamp: outOfWindowIso, isSidechain: false, message: { content: "expanded command body" } },
    {
      type: "assistant",
      timestamp: outOfWindowIso,
      message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 20 } },
    },
  ];

  const tmpFile = path.join(os.tmpdir(), `parseTranscript-window-test-2-${process.pid}.jsonl`);
  await fs.writeFile(tmpFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    const { entries, skillRuns } = await parseTranscript(tmpFile, cutoffMs);
    assert.equal(entries.length, 0, "no entries survive the window filter");
    assert.deepEqual(skillRuns, [], "a skill run with zero in-window messages is never emitted");
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

// --- applyTranscriptToAggregates: zero-in-window-entries edge case (build
// 2.9). A transcript file can pass findTranscripts()'s mtime prefilter yet
// contribute nothing once its entries are windowed by their own timestamps
// (e.g. an old session file touched recently by a stray write). That must
// not create a $0/0-message workflow session, nor a workflow/project entry
// that otherwise carries no data. ---
{
  const days = new Map();
  const projects = new Map();
  const workflows = new Map();
  const skills = new Map();
  const rule = { key: "interactive", label: "Interactive" };

  // A file with zero in-window entries and zero skill runs contributes nothing.
  applyTranscriptToAggregates({
    entries: [],
    skillRuns: [],
    projectName: "some-project",
    rule,
    days,
    projects,
    workflows,
    skills,
  });
  assert.equal(workflows.size, 0, "no workflow entry materializes for a zero-contribution transcript");
  assert.equal(projects.size, 0, "no project entry materializes for a zero-contribution transcript");
  assert.equal(days.size, 0, "no day entry materializes for a zero-contribution transcript");

  // A second, real file for the same workflow DOES contribute -- confirms
  // the guard only skips empty transcripts, not the workflow as a whole.
  const entry = {
    timestamp: "2026-07-20T12:00:00Z",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  applyTranscriptToAggregates({
    entries: [entry],
    skillRuns: [],
    projectName: "some-project",
    rule,
    days,
    projects,
    workflows,
    skills,
  });
  const w = workflows.get("interactive");
  assert.ok(w, "the workflow entry is created once a transcript actually contributes");
  assert.equal(w.sessions, 1, "only the contributing transcript counts as a session -- the empty one did not");
  assert.ok(w.costUsd > 0, "cost flowed through from the single in-window entry");
  assert.equal(projects.get("some-project").messages, 1, "project aggregate reflects only the contributing transcript");
}

console.log("exportUsageWorkflows: all assertions passed");
