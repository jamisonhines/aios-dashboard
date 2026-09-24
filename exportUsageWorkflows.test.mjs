import "./testFileTimeout.mjs";
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
  foldWorkflowSession,
  localDay,
  parseTranscript,
  applyTranscriptToAggregates,
  applyAgentTranscript,
  UNKNOWN_AGENT_TYPE,
  findTranscripts,
  findPiAndBbTranscripts,
  stripThinkingSuffix,
  OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_V1,
  OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_PROVENANCE,
  openAiApiEquivalentRate,
  createUsageRecordDedupe,
  main,
  validateUsage,
  createRejectedUsageDiagnostics,
  USAGE_DAY_TIME_ZONE,
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

// --- skill segmenter: per-run byDay breakdown (Phase 1 System-browser range
// toggle, 2026-08-04). Mirrors foldWorkflowEntry's per-day fold, but scoped
// to one run instead of one workflow. ---
{
  // localDay() uses LOCAL getters, so timestamps are spaced >36h apart
  // (comfortably more than any UTC offset can shift) to make the "same
  // day" / "different day" split deterministic regardless of the test
  // runner's timezone.
  const seg = createSkillSegmenter();
  seg.boundary(marker("close-session"));
  seg.usage("opus", { ...OPUS, timestamp: "2026-07-27T10:00:00Z" });
  seg.usage("opus", { ...OPUS, timestamp: "2026-07-27T11:00:00Z" });
  // A long-lived run CAN cross a calendar-day boundary; both days must be
  // tracked, not just the run's first day.
  seg.usage("opus", { ...OPUS, timestamp: "2026-07-29T10:00:00Z" });
  const run = seg.finish()[0];
  assert.equal(run.byDay.size, 2, "two distinct days recorded for this one run");
  const firstDayKey = localDay("2026-07-27T10:00:00Z");
  const secondDayKey = localDay("2026-07-29T10:00:00Z");
  assert.equal(run.byDay.get(firstDayKey).messages, 2, "two usage entries landed on the first day");
  assert.equal(run.byDay.get(secondDayKey).messages, 1, "one usage entry landed on the second day");
  const sumCost = [...run.byDay.values()].reduce((s, d) => s + d.costUsd, 0);
  assert.ok(Math.abs(sumCost - run.costUsd) < 1e-9, "sum(byDay.costUsd) matches the run total");

  // A usage entry with no timestamp degrades gracefully (no byDay pollution).
  const seg2 = createSkillSegmenter();
  seg2.boundary(marker("no-timestamp-skill"));
  seg2.usage("opus", OPUS); // OPUS has no `timestamp` field
  const run2 = seg2.finish()[0];
  assert.equal(run2.byDay.size, 0, "missing timestamp -> no byDay entry, but the run itself still counts");
  assert.equal(run2.messages, 1, "the run's own totals are unaffected by the missing timestamp");
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
  assert.deepEqual(acc.byDay.get("2026-07-27"), { costUsd: 2.0, outputTokens: 1500, messages: 2, sessions: 0 });
  assert.deepEqual(acc.byDay.get("2026-07-28"), { costUsd: 2.0, outputTokens: 2000, messages: 1, sessions: 0 });

  const sumCost = [...acc.byDay.values()].reduce((s, d) => s + d.costUsd, 0);
  const sumTokens = [...acc.byDay.values()].reduce((s, d) => s + d.outputTokens, 0);
  const sumMessages = [...acc.byDay.values()].reduce((s, d) => s + d.messages, 0);
  assert.equal(sumCost, acc.costUsd, "sum(byDay.costUsd) matches the top-level total");
  assert.equal(sumTokens, acc.outputTokens, "sum(byDay.outputTokens) matches the top-level total");
  assert.equal(sumMessages, acc.messages, "sum(byDay.messages) matches the top-level total");
}

// --- foldWorkflowSession: per-day session-start counting (Phase 1
// System-browser range toggle, 2026-08-04). Independent of foldWorkflowEntry
// -- a session can post entries across several days, but only counts once,
// on the day its first in-window entry landed. ---
{
  const acc = { costUsd: 0, outputTokens: 0, messages: 0, byDay: new Map() };
  foldWorkflowSession(acc, "2026-07-27");
  foldWorkflowSession(acc, "2026-07-27");
  foldWorkflowSession(acc, "2026-07-28");

  assert.equal(acc.byDay.get("2026-07-27").sessions, 2, "two sessions attributed to the same day");
  assert.equal(acc.byDay.get("2026-07-28").sessions, 1, "a third session on a different day");

  // Interleaved with foldWorkflowEntry: the two must not clobber each other's
  // fields on the same byDay bucket.
  foldWorkflowEntry(acc, "2026-07-27", 1.0, 100);
  assert.deepEqual(acc.byDay.get("2026-07-27"), { costUsd: 1.0, outputTokens: 100, messages: 1, sessions: 2 });
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

// --- findTranscripts: recurses into subagent directories at any depth
// (build 2.9 recursive-scan fix). Real transcripts on disk are nested like
// <projectsRoot>/<project>/<session-id>/subagents/agent-*.jsonl, and deeper
// still for a subagent that dispatches its own subagents:
// <project>/<session-id>/subagents/workflows/wf_*/agent-*.jsonl. ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "findTranscripts-test-"));
  try {
    const project = "-Users-jaymo-AIOS";
    const sessionId = "9a9ef267-d9f0-478b-8c80-85269dbb526d";
    const projectDir = path.join(root, project);
    const topLevelFile = path.join(projectDir, `${sessionId}.jsonl`);
    const subagentDir = path.join(projectDir, sessionId, "subagents");
    const subagentFile = path.join(subagentDir, "agent-afa3dd6e7ec4f8e6d.jsonl");
    const nestedSubagentDir = path.join(subagentDir, "workflows", "wf_cd47bf27-ac2");
    const nestedSubagentFile = path.join(nestedSubagentDir, "agent-a2f53d6f6ae332553.jsonl");

    await fs.mkdir(nestedSubagentDir, { recursive: true });
    await fs.writeFile(topLevelFile, "{}\n", "utf8");
    await fs.writeFile(subagentFile, "{}\n", "utf8");
    await fs.writeFile(nestedSubagentFile, "{}\n", "utf8");
    // A non-.jsonl sibling (mirrors real tool-results/*.txt, memory/*.md
    // dirs) must not be picked up and must not break the walk.
    await fs.writeFile(path.join(subagentDir, "notes.txt"), "not a transcript", "utf8");

    const cutoffMs = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const files = await findTranscripts(root, cutoffMs);
    assert.equal(files.length, 3, "all three nested .jsonl files are discovered, the .txt sibling is not");

    const byPath = new Map(files.map((f) => [f.filePath, f]));

    const top = byPath.get(topLevelFile);
    assert.ok(top, "top-level session file discovered");
    assert.equal(top.project, project, "project is the top-level dir name");
    assert.equal(top.sessionId, sessionId, "top-level file's sessionId is its own basename");
    assert.equal(top.isTopLevel, true, "top-level file flagged as a real session");

    const sub = byPath.get(subagentFile);
    assert.ok(sub, "one-level-nested subagent file discovered");
    assert.equal(sub.project, project, "subagent file's project is STILL the top-level dir, not 'subagents'");
    assert.equal(sub.sessionId, sessionId, "subagent file's sessionId resolves to its PARENT session id");
    assert.equal(sub.isTopLevel, false, "subagent file is not flagged as a top-level session");

    const nestedSub = byPath.get(nestedSubagentFile);
    assert.ok(nestedSub, "two-levels-nested (subagent-of-a-subagent) file discovered");
    assert.equal(
      nestedSub.project,
      project,
      "deeply-nested file's project is still the top-level dir, never a session-id or 'workflows'/'wf_*' dir"
    );
    assert.equal(
      nestedSub.sessionId,
      sessionId,
      "deeply-nested file walks up to the OUTERMOST session-id directory, not 'subagents' or 'wf_cd47bf27-ac2'"
    );
    assert.equal(nestedSub.isTopLevel, false, "deeply-nested file is not flagged as a top-level session");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- findTranscripts: the existing mtime prefilter still applies to files
// found by the recursive walk, not just top-level ones. ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "findTranscripts-cutoff-test-"));
  try {
    const staleFile = path.join(root, "proj", "session-1", "subagents", "agent-old.jsonl");
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(staleFile, "{}\n", "utf8");
    const farFutureCutoffMs = Date.now() + 24 * 60 * 60 * 1000; // 1 day in the future
    const files = await findTranscripts(root, farFutureCutoffMs);
    assert.deepEqual(files, [], "a subagent file older than cutoff is excluded, same as a top-level file would be");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- applyTranscriptToAggregates: isSubagent semantics (build 2.9
// recursive-scan fix). A subagent transcript's cost/tokens still fold into
// days/projects/workflows (attributed to the PARENT session's workflow rule
// by the caller), but it must not inflate `sessions` (it isn't a user
// session) and must not contribute skillRuns (a subagent transcript has no
// genuine human turns, so any apparent run would be a segmentation
// artifact, not a real skill invocation). ---
{
  const days = new Map();
  const projects = new Map();
  const workflows = new Map();
  const skills = new Map();
  const rule = { key: "interactive", label: "Interactive" };

  const entry = {
    timestamp: "2026-07-20T12:00:00Z",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  // A bogus "skill run" the segmenter should never actually produce for a
  // subagent transcript, but even if it did, isSubagent must suppress it.
  const bogusSkillRun = { key: "agent-afa3dd6e7ec4f8e6d", costUsd: 5, outputTokens: 500, messages: 1 };

  // First fold a real top-level session (establishes the workflow + a real
  // session count of 1) so we can prove the subagent fold on top of it does
  // NOT bump sessions further.
  applyTranscriptToAggregates({
    entries: [entry],
    skillRuns: [{ key: "real-skill", costUsd: 1, outputTokens: 100, messages: 1 }],
    projectName: "AIOS",
    rule,
    days,
    projects,
    workflows,
    skills,
    isSubagent: false,
  });
  assert.equal(workflows.get("interactive").sessions, 1, "the real top-level session counts as 1 session");
  assert.equal(skills.get("real-skill").runs, 1, "the real top-level session's skill run is recorded");

  // Now fold a subagent transcript attributed to the SAME workflow.
  applyTranscriptToAggregates({
    entries: [entry],
    skillRuns: [bogusSkillRun],
    projectName: "AIOS",
    rule,
    days,
    projects,
    workflows,
    skills,
    isSubagent: true,
  });

  const w = workflows.get("interactive");
  assert.equal(w.sessions, 1, "a subagent transcript does NOT increment sessions -- still 1, not 2");
  assert.ok(w.costUsd > 0, "cost still rolled up into the parent session's workflow");
  assert.equal(
    w.costUsd,
    2 * estimateCostForEntry(entry),
    "workflow cost reflects BOTH the top-level session's and the subagent's contribution"
  );
  assert.equal(
    skills.has("agent-afa3dd6e7ec4f8e6d"),
    false,
    "a subagent transcript's skillRuns are dropped entirely -- no bogus per-skill entry created"
  );
  assert.equal(skills.size, 1, "skills map still only has the one real skill from the top-level session");
  assert.equal(
    projects.get("AIOS").messages,
    2,
    "project aggregate DOES include the subagent's messages (cost/tokens roll up, only `sessions` is exempt)"
  );
}

// --- applyTranscriptToAggregates: skill byDay merges into the aggregate
// skills map, and a skillRun with no byDay (e.g. a hand-built test fixture,
// or old callers) degrades gracefully rather than throwing. Also verifies
// the workflow-level session-day fold lands on entries[0]'s day. ---
{
  const days = new Map();
  const projects = new Map();
  const workflows = new Map();
  const skills = new Map();
  const rule = { key: "interactive", label: "Interactive" };
  const entry = {
    timestamp: "2026-07-27T12:00:00Z",
    model: "claude-sonnet-5",
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const runWithByDay = {
    key: "close-session",
    costUsd: 3,
    outputTokens: 100,
    messages: 2,
    byDay: new Map([
      ["2026-07-27", { costUsd: 2, outputTokens: 60, messages: 1 }],
      ["2026-07-28", { costUsd: 1, outputTokens: 40, messages: 1 }],
    ]),
  };
  const runWithoutByDay = { key: "legacy-skill", costUsd: 1, outputTokens: 10, messages: 1 };

  applyTranscriptToAggregates({
    entries: [entry],
    skillRuns: [runWithByDay, runWithoutByDay],
    projectName: "AIOS",
    rule,
    days,
    projects,
    workflows,
    skills,
  });

  const s = skills.get("close-session");
  assert.equal(s.byDay.size, 2, "both days from the run's byDay carried through");
  assert.deepEqual(s.byDay.get("2026-07-27"), { costUsd: 2, outputTokens: 60, messages: 1, runs: 1 });
  assert.deepEqual(s.byDay.get("2026-07-28"), { costUsd: 1, outputTokens: 40, messages: 1, runs: 0 });
  assert.equal(s.runs, 1, "the run itself still counts once at the top level");

  const legacy = skills.get("legacy-skill");
  assert.equal(legacy.byDay.size, 0, "a run with no byDay contributes no per-day data, but still aggregates");
  assert.equal(legacy.runs, 1, "legacy run still counts toward the total");

  const w = workflows.get("interactive");
  assert.equal(w.byDay.get("2026-07-27").sessions, 1, "the session is attributed to entries[0]'s day");
}

function estimateCostForEntry(entry) {
  // Mirrors estimateCost(family, entry, entry.timestamp) for the sonnet
  // family. 2026-07-20 is still inside the Sonnet 5 intro-pricing window
  // (through 2026-08-31), so the intro rate applies.
  const rate = SONNET_INTRO_RATE;
  return (entry.input_tokens * rate.in + entry.output_tokens * rate.out) / 1e6;
}

// --- parseTranscript: extracts attributionAgent from a subagent transcript
// (System-browser Agents section, Phase 3, 2026-08-05). Real subagent
// transcripts carry `attributionAgent` on every line once the Task tool
// resolves a subagent_type; captured from the FIRST line that has it, even
// if earlier lines lack the field (e.g. a leading `user` line with no
// message yet). ---
{
  const now = Date.now();
  const cutoffMs = now - 35 * 24 * 60 * 60 * 1000;
  const ts = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
  const lines = [
    { type: "user", timestamp: ts, isSidechain: true, message: { content: "dispatch prompt" } },
    {
      type: "assistant",
      timestamp: ts,
      attributionAgent: "coder",
      message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20 } },
    },
  ];
  const tmpFile = path.join(os.tmpdir(), `parseTranscript-attribution-test-${process.pid}.jsonl`);
  await fs.writeFile(tmpFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    const { attributionAgent, entries } = await parseTranscript(tmpFile, cutoffMs);
    assert.equal(attributionAgent, "coder", "attributionAgent captured from the assistant line");
    assert.equal(entries.length, 1, "usage entry still parsed normally");
  } finally {
    await fs.rm(tmpFile, { force: true });
  }

  // A top-level session transcript (no attributionAgent anywhere) resolves
  // to undefined, not a stray empty string or throw.
  const noAttrLines = [
    {
      type: "assistant",
      timestamp: ts,
      message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20 } },
    },
  ];
  const tmpFile2 = path.join(os.tmpdir(), `parseTranscript-no-attribution-test-${process.pid}.jsonl`);
  await fs.writeFile(tmpFile2, noAttrLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    const { attributionAgent } = await parseTranscript(tmpFile2, cutoffMs);
    assert.equal(attributionAgent, undefined, "no attributionAgent field anywhere -> undefined, not a crash");
  } finally {
    await fs.rm(tmpFile2, { force: true });
  }
}

// --- applyAgentTranscript: pure accumulator (System-browser Agents section,
// Phase 3, 2026-08-05). One file = one run, attributed to entries[0]'s day;
// cost/tokens/messages sum across entries; byDay mirrors the top-level
// totals the same way skills'/workflows' byDay does. ---
{
  const agents = new Map();
  const e1 = {
    timestamp: "2026-07-27T10:00:00Z",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const e2 = { ...e1, timestamp: "2026-07-27T14:00:00Z" };
  applyAgentTranscript(agents, "coder", [e1, e2]);

  const a = agents.get("coder");
  assert.ok(a, "agent bucket created for a new key");
  assert.equal(a.runs, 1, "one file = one run, even with multiple usage entries inside it");
  assert.equal(a.messages, 2, "both entries counted toward messages");
  const dayKey = localDay("2026-07-27T10:00:00Z");
  assert.equal(a.byDay.get(dayKey).runs, 1, "the run is attributed to entries[0]'s day");
  assert.equal(a.byDay.get(dayKey).messages, 2, "both entries landed on the same day in byDay");
  const sumCost = [...a.byDay.values()].reduce((s, d) => s + d.costUsd, 0);
  assert.ok(Math.abs(sumCost - a.costUsd) < 1e-9, "sum(byDay.costUsd) matches the agent's top-level total");

  // A second file for the SAME agent type accumulates rather than replacing.
  const e3 = { ...e1, timestamp: "2026-07-28T09:00:00Z" };
  applyAgentTranscript(agents, "coder", [e3]);
  assert.equal(agents.get("coder").runs, 2, "a second subagent file for the same type is a second run");
  assert.equal(agents.get("coder").messages, 3, "messages accumulate across files");

  // A different agent type gets its own independent bucket.
  applyAgentTranscript(agents, "reviewer", [e1]);
  assert.equal(agents.size, 2, "distinct agent types get distinct buckets");
  assert.equal(agents.get("reviewer").runs, 1, "the new bucket starts fresh, unaffected by coder's totals");

  // Zero entries contributes nothing (mirrors applyTranscriptToAggregates'
  // zero-in-window-entries guard) -- no bucket is fabricated out of nothing.
  const emptyAgents = new Map();
  applyAgentTranscript(emptyAgents, "capture", []);
  assert.equal(emptyAgents.size, 0, "an empty entries array creates no bucket at all");

  // Missing/undefined agentType falls back to the named UNKNOWN_AGENT_TYPE
  // bucket instead of crashing or silently dropping real spend.
  const unknownAgents = new Map();
  applyAgentTranscript(unknownAgents, undefined, [e1]);
  assert.equal(unknownAgents.has(UNKNOWN_AGENT_TYPE), true, "missing agentType falls back to UNKNOWN_AGENT_TYPE");
  assert.equal(unknownAgents.get(UNKNOWN_AGENT_TYPE).runs, 1, "the run still counts under the fallback bucket");
}

// --- Double-count reconciliation (task-mandated correctness check,
// 2026-08-05): folding a subagent transcript into BOTH the pre-existing
// days/projects/workflows aggregates (applyTranscriptToAggregates,
// isSubagent: true) AND the new `agents` dimension (applyAgentTranscript)
// must not inflate the headline workflow/day/project totals -- `agents` is
// an orthogonal breakdown over the SAME already-counted-once entries, not a
// second charge. This models exactly what main() does: both calls receive
// the identical `entries` array from one parseTranscript() call. ---
{
  const days = new Map();
  const projects = new Map();
  const workflows = new Map();
  const skills = new Map();
  const agents = new Map();
  const rule = { key: "interactive", label: "Interactive" };

  const parentEntry = {
    timestamp: "2026-07-20T09:00:00Z",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const subagentEntry = {
    timestamp: "2026-07-20T09:05:00Z",
    model: "claude-sonnet-5",
    input_tokens: 1000,
    output_tokens: 2000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  // Parent session transcript (isSubagent: false).
  applyTranscriptToAggregates({
    entries: [parentEntry],
    skillRuns: [],
    projectName: "AIOS",
    rule,
    days,
    projects,
    workflows,
    skills,
    isSubagent: false,
  });
  // Its one dispatched subagent (isSubagent: true) -- same entries object
  // fed to BOTH the existing fold and the new agents fold, exactly as
  // main()'s nested-transcript loop does.
  applyTranscriptToAggregates({
    entries: [subagentEntry],
    skillRuns: [],
    projectName: "AIOS",
    rule,
    days,
    projects,
    workflows,
    skills,
    isSubagent: true,
  });
  applyAgentTranscript(agents, "coder", [subagentEntry]);

  const expectedParentCost = estimateCostForEntry(parentEntry);
  const expectedSubagentCost = estimateCostForEntry(subagentEntry);
  const w = workflows.get("interactive");

  assert.ok(
    Math.abs(w.costUsd - (expectedParentCost + expectedSubagentCost)) < 1e-9,
    "workflow total is parent + subagent cost, counted exactly once each (not doubled by the agents fold)"
  );
  assert.equal(w.sessions, 1, "still exactly one real session -- the subagent never inflates session count");
  assert.ok(
    Math.abs(agents.get("coder").costUsd - expectedSubagentCost) < 1e-9,
    "the agents-dimension total equals the subagent's own cost, not the combined parent+subagent total"
  );
  assert.ok(
    agents.get("coder").costUsd < w.costUsd,
    "the agents dimension is a SLICE of the workflow total, never larger than it -- proves no doubling"
  );
}

// --- Pi / BB OpenAI records: provider-qualified identity, token aliases,
// and API-equivalent cost from the versioned model-specific rate card. ---
for (const suffix of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  assert.equal(stripThinkingSuffix(`openai-codex/gpt-5.6-sol:${suffix}`), "openai-codex/gpt-5.6-sol", `${suffix} is a Pi thinking suffix`);
}
assert.equal(stripThinkingSuffix("openai-codex/gpt-5.6-sol:custom"), "openai-codex/gpt-5.6-sol:custom", "unknown suffix remains model identity");

// Pin all currently observed rates. Each full-million-token entry makes the
// four token buckets independently visible in the assertion.
const OPENAI_RATE_EXPECTATIONS = {
  "gpt-5.5": { input: 5, cacheRead: 0.5, cacheWrite: 0, output: 30 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.6-sol": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
};
assert.deepEqual(OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_V1, OPENAI_RATE_EXPECTATIONS, "versioned card pins every observed OpenAI model");
assert.equal(OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_PROVENANCE, "docs/openai-codex-api-equivalent-v1.md", "rate card names its versioned local provenance artifact");
{
  const provenance = await fs.readFile(new URL("./docs/openai-codex-api-equivalent-v1.md", import.meta.url), "utf8");
  assert.match(provenance, /openai-codex-api-equivalent-v1/, "provenance artifact names the rate-card version");
  assert.match(provenance, /Retrieved: 2026-09-16/, "provenance artifact records its retrieval date");
  assert.match(provenance, /USD per million tokens/, "provenance artifact states rate units");
  assert.match(provenance, /272,000/, "provenance artifact records the applicable base-tier boundary");
  assert.match(provenance, /not expose a reliable per-entry threshold discriminator/, "provenance artifact states why estimates deliberately remain base-tier");
  for (const [modelId, rate] of Object.entries(OPENAI_RATE_EXPECTATIONS)) {
    assert.match(provenance, new RegExp(`\\| ${modelId} \\| ${rate.input} \\| ${rate.cacheRead} \\| ${rate.cacheWrite} \\| ${rate.output} \\|`), `${modelId} provenance records every base token-bucket rate`);
  }
}
for (const [modelId, rate] of Object.entries(OPENAI_RATE_EXPECTATIONS)) {
  const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.deepEqual(openAiApiEquivalentRate(`openai-codex/${modelId}`), rate, `${modelId} resolves its own rate, not Claude other`);
  assert.equal(estimateCost("other", usage, undefined, `openai-codex/${modelId}`), rate.input + rate.cacheRead + rate.cacheWrite + rate.output, `${modelId} prices every token bucket`);
}
assert.equal(estimateCost("other", { input_tokens: 1_000_000, output_tokens: 1_000_000 }, undefined, "openai-codex/future-model"), 0, "unknown OpenAI is safely uncharged rather than priced as Claude other");

{
  const tmpFile = path.join(os.tmpdir(), `parse-openai-usage-${process.pid}.jsonl`);
  const timestamp = new Date().toISOString();
  const records = [
    { type: "model_change", timestamp, provider: "openai-codex", modelId: "selected-model:high" },
    // Deliberately incompatible transcript totals prove graph aggregation does
    // not select reported costs.
    { type: "message", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-5.5:off", usage: { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: { total: 999 } } } },
    // The selection's modelId must not replace this different message model.
    { type: "message", timestamp, message: { role: "assistant", model: "gpt-5.6-luna:minimal", usage: { input: 23, output: 29, cacheRead: 31, cacheWrite: 37, cost: { total: 998 } } } },
    { type: "message", timestamp, message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 41, output: 43, cacheRead: 47, cacheWrite: 53, cost: { total: 997 } } } },
    { type: "message", timestamp, message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", usage: { input: 59, output: 61, cacheRead: 67, cacheWrite: 71, cost: { total: 996 } } } },
    { type: "message", timestamp, message: { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", usage: { input: 73, output: 79, cacheRead: 83, cacheWrite: 89, cost: { total: 995 } } } },
    { type: "message", timestamp, message: { role: "assistant", provider: "openai-codex", model: "future-model", usage: { input: 101, output: 103, cacheRead: 107, cacheWrite: 109, cost: { total: 994 } } } },
  ];
  await fs.writeFile(tmpFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  try {
    const { entries } = await parseTranscript(tmpFile, Date.now() - 60_000);
    assert.deepEqual(entries.map((entry) => entry.model), ["openai/gpt-5.5", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-6-astra", "openai-codex/future-model"], "message model remains provider-qualified and model-specific");
    assert.ok(entries.every((entry) => !("reportedCostUsd" in entry) && !("usesTranscriptReportedCost" in entry)), "transcript-reported cost is not carried into graph records");
    const days = new Map(), projects = new Map(), workflows = new Map(), skills = new Map();
    applyTranscriptToAggregates({ entries, skillRuns: [], projectName: "AIOS", rule: { key: "interactive", label: "Interactive" }, days, projects, workflows, skills });
    const buckets = days.get(localDay(timestamp));
    const first = buckets["openai/gpt-5.5"];
    assert.deepEqual({ input: first.inputTokens, output: first.outputTokens, cacheRead: first.cacheReadTokens, cacheWrite: first.cacheWriteTokens }, { input: 11, output: 13, cacheRead: 17, cacheWrite: 19 }, "all Pi aliases and model identity survive day aggregation");
    for (const entry of entries.slice(0, -1)) {
      const bucket = buckets[entry.model];
      const expected = estimateCost("other", entry, entry.timestamp, entry.model);
      assert.equal(bucket.costUsd, expected, `${entry.model} graph cost uses its token buckets, not its transcript total`);
      assert.ok(bucket.costUsd < 1, `${entry.model} was not assigned the incompatible $995+ transcript total`);
    }
    assert.equal(buckets["openai-codex/future-model"].costUsd, 0, "unknown OpenAI retains identity while safely uncharged");
    assert.equal(estimateCost("opus", { input_tokens: 1_000_000, output_tokens: 0, reportedCostUsd: 0 }), 5, "a generic reported-cost field never changes Claude estimates");
  } finally { await fs.unlink(tmpFile); }
}

// Non-OpenAI records with a cost field retain their existing estimated
// family/key behavior. This is parser -> aggregate, not estimateCost in isolation.
{
  const tmpFile = path.join(os.tmpdir(), `parse-non-openai-usage-${process.pid}.jsonl`);
  const timestamp = new Date().toISOString();
  await fs.writeFile(tmpFile, [
    { type: "message", timestamp, message: { role: "assistant", provider: "anthropic", model: "claude-opus", usage: { input: 1_000_000, output: 0, cost: { total: 0.01 } } } },
    { type: "message", timestamp, message: { role: "assistant", provider: "other-provider", model: "other-model", usage: { input: 1_000_000, output: 0, cost: { total: 0.02 } } } },
  ].map(JSON.stringify).join("\n") + "\n");
  try {
    const { entries } = await parseTranscript(tmpFile, Date.now() - 60_000);
    const days = new Map(), projects = new Map(), workflows = new Map(), skills = new Map();
    applyTranscriptToAggregates({ entries, skillRuns: [], projectName: "AIOS", rule: { key: "interactive", label: "Interactive" }, days, projects, workflows, skills });
    const buckets = days.get(localDay(timestamp));
    assert.equal(buckets.opus.costUsd, 5, "Claude record ignores reported field and retains estimated opus family/key");
    assert.equal(buckets.other.costUsd, 5, "other-provider record ignores reported field and retains estimated Other family/key");
  } finally { await fs.unlink(tmpFile); }
}

// Deliberately overlap roots: the same resolved run-0/session.jsonl matches
// both roots, so return-level resolved-path de-duplication must leave one.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "find-pi-bb-overlap-"));
  const bbRoot = path.join(root, "bb"); const piRoot = path.join(bbRoot, "thread");
  const shared = path.join(bbRoot, "thread", "run-0", "session.jsonl");
  await fs.mkdir(path.dirname(shared), { recursive: true }); await fs.writeFile(shared, "{}\n");
  try {
    const found = await findPiAndBbTranscripts(piRoot, bbRoot, 0);
    assert.deepEqual(found.map((entry) => entry.filePath), [shared], "overlapping roots return one resolved canonical path");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "find-pi-bb-transcripts-"));
  const piRoot = path.join(root, "pi"); const bbRoot = path.join(root, "bb");
  await fs.mkdir(path.join(piRoot, "project"), { recursive: true });
  await fs.mkdir(path.join(bbRoot, "thread", "run-0"), { recursive: true });
  await fs.mkdir(path.join(bbRoot, "subagent-artifacts", "thread", "run-0"), { recursive: true });
  await fs.mkdir(path.join(bbRoot, "forks", "thread", "run-0"), { recursive: true });
  for (const file of [
    path.join(piRoot, "project", "session.jsonl"), path.join(bbRoot, "thread", "run-0", "session.jsonl"), path.join(bbRoot, "thr_source.jsonl"),
    path.join(bbRoot, "subagent-artifacts", "thread", "run-0", "session.jsonl"), path.join(bbRoot, "forks", "thread", "run-0", "session.jsonl"),
  ]) await fs.writeFile(file, "{}\n");
  try {
    const found = await findPiAndBbTranscripts(piRoot, bbRoot, 0);
    assert.deepEqual(found.map((entry) => entry.filePath).sort(), [path.join(piRoot, "project", "session.jsonl"), path.join(bbRoot, "thread", "run-0", "session.jsonl"), path.join(bbRoot, "thr_source.jsonl")].sort(), "artifact and fork copies that otherwise match canonical names are excluded");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}


// main() integration: canonical Pi/BB discovery must feed the real exporter
// aggregation and its output without touching a real vault.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-main-pi-bb-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const timestamp = new Date().toISOString();
  const piFile = path.join(piRoot, "project", "pi-session.jsonl");
  const bbFile = path.join(bbRoot, "thread", "run-0", "session.jsonl");
  await fs.mkdir(path.dirname(piFile), { recursive: true }); await fs.mkdir(path.dirname(bbFile), { recursive: true });
  await fs.writeFile(piFile, [
    { type: "model_change", timestamp, provider: "openai", modelId: "selected" },
    { type: "message", timestamp, message: { role: "assistant", model: "gpt-integration", usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0.09 } } } },
  ].map(JSON.stringify).join("\n") + "\n");
  await fs.writeFile(bbFile, [
    { type: "model_change", timestamp, provider: "openai-codex", modelId: "selected" },
    { type: "message", timestamp, message: { role: "assistant", model: "gpt-bb", usage: { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: { total: 0.11 } } } },
  ].map(JSON.stringify).join("\n") + "\n");
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date(timestamp) });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    const models = output.days.flatMap((day) => Object.keys(day.models));
    assert.ok(models.includes("openai/gpt-integration"), "main aggregates Pi discovery output");
    assert.ok(models.includes("openai-codex/gpt-bb"), "main aggregates BB discovery output");
    assert.deepEqual(output.costSemantics, { claude: "api-equivalent estimate", openai: "api-equivalent estimate", openaiCodex: "api-equivalent estimate", openaiRateCard: "openai-codex-api-equivalent-v1", openaiRateCardProvenance: "docs/openai-codex-api-equivalent-v1.md", openaiCodexTier: "base rates only; transcript fields lack a reliable per-entry 272K threshold discriminator", openaiCodexTierThresholdTokens: 272000, unknownOpenAi: "unpriced; rate card required" }, "serialized graph-cost semantics disclose rate-card provenance and the deliberate 272K base-tier limitation");
    assert.deepEqual(output.unpricedOpenAiModels, ["openai-codex/gpt-bb", "openai/gpt-integration"], "unknown OpenAI models are explicitly serialized as unpriced rather than silently priced as Claude other");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Nested Pi child runs are canonical only when they descend from a direct Pi
// parent JSONL with the exact parent-session basename. The artifact copy is
// deliberately not discovered, while the parent, child, and BB records are.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "find-pi-nested-child-"));
  const piRoot = path.join(root, "pi"); const bbRoot = path.join(root, "bb");
  const project = "project";
  const parentSessionId = "parent-session";
  const runUuid = "123e4567-e89b-42d3-a456-426614174000";
  const parent = path.join(piRoot, project, `${parentSessionId}.jsonl`);
  const child = path.join(piRoot, project, parentSessionId, runUuid, "run-0", "session.jsonl");
  const artifact = path.join(piRoot, project, "subagent-artifacts", `${runUuid}_coder_transcript.jsonl`);
  const bb = path.join(bbRoot, "thread", "run-0", "session.jsonl");
  await fs.mkdir(path.dirname(parent), { recursive: true });
  await fs.mkdir(path.dirname(child), { recursive: true });
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.mkdir(path.dirname(bb), { recursive: true });
  await Promise.all([parent, child, artifact, bb].map((file) => fs.writeFile(file, "{}\n")));
  try {
    const found = await findPiAndBbTranscripts(piRoot, bbRoot, 0);
    assert.deepEqual(
      found.map((entry) => entry.filePath).sort(),
      [parent, child, bb].sort(),
      "direct Pi parent and canonical child are included once; Pi artifacts remain excluded"
    );
    const childEntry = found.find((entry) => entry.filePath === child);
    assert.equal(childEntry.sourceSessionId, `pi:${project}/${parentSessionId}/${runUuid}/run-0/session.jsonl`, "child fingerprint source is root-namespaced and unique per transcript, not the run UUID/session attribution");
    assert.equal(childEntry.sessionId, runUuid, "child session ID remains available for attribution only");
    assert.equal(childEntry.isTopLevel, true, "standalone Pi child counts as a session");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// A parent-session directory can share its direct parent JSONL basename, but
// must not be a symlink that leads discovery outside the real Pi project root.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "find-pi-parent-dir-symlink-"));
  const piRoot = path.join(root, "pi"); const bbRoot = path.join(root, "bb");
  const project = "project", parentSessionId = "parent-session", runUuid = "123e4567-e89b-42d3-a456-426614174998";
  const parent = path.join(piRoot, project, `${parentSessionId}.jsonl`);
  const parentDir = path.join(piRoot, project, parentSessionId);
  const outsideTree = path.join(root, "outside-tree");
  const outsideChild = path.join(outsideTree, runUuid, "run-0", "session.jsonl");
  await fs.mkdir(path.dirname(parent), { recursive: true }); await fs.mkdir(path.dirname(outsideChild), { recursive: true });
  await Promise.all([fs.writeFile(parent, "{}\n"), fs.writeFile(outsideChild, "{}\n")]);
  let symlinkCreated = true;
  try { await fs.symlink(outsideTree, parentDir); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") symlinkCreated = false;
    else throw error;
  }
  try {
    if (symlinkCreated) {
      const found = await findPiAndBbTranscripts(piRoot, bbRoot, 0);
      assert.deepEqual(found.map((entry) => entry.filePath), [parent], "a same-named symlinked parent-session directory outside Pi is rejected while its direct parent JSONL remains discovered");
    } else {
      console.log("exportUsageWorkflows: parent-directory symlink containment assertion skipped (platform cannot create symlinks)");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Pi child transcripts must be real, canonical files inside their expected
// run directory. A symlinked session.jsonl is rejected rather than followed.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "find-pi-child-symlink-"));
  const piRoot = path.join(root, "pi"); const bbRoot = path.join(root, "bb");
  const project = "project", parentSessionId = "parent-session", runUuid = "123e4567-e89b-42d3-a456-426614174999";
  const parent = path.join(piRoot, project, `${parentSessionId}.jsonl`);
  const child = path.join(piRoot, project, parentSessionId, runUuid, "run-0", "session.jsonl");
  const outside = path.join(root, "outside.jsonl");
  await fs.mkdir(path.dirname(parent), { recursive: true }); await fs.mkdir(path.dirname(child), { recursive: true });
  await Promise.all([fs.writeFile(parent, "{}\n"), fs.writeFile(outside, "{}\n")]);
  let symlinkCreated = true;
  try { await fs.symlink(outside, child); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") symlinkCreated = false;
    else throw error;
  }
  try {
    if (symlinkCreated) {
      const found = await findPiAndBbTranscripts(piRoot, bbRoot, 0);
      assert.deepEqual(found.map((entry) => entry.filePath), [parent], "symlinked Pi child session.jsonl is rejected even when its lexical path matches the canonical layout");
    } else {
      console.log("exportUsageWorkflows: symlink containment assertion skipped (platform cannot create symlinks)");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Semantic dedupe uses provider-qualified response IDs. Fallbacks are scoped
// to a root-namespaced transcript source, never a workflow session ID.
{
  const dedupe = createUsageRecordDedupe();
  const fallback = (sourceSessionId, sourceRef = sourceSessionId) => ({
    sourceSessionId, sourceRef, sourcePath: "/private/local/transcript.jsonl", timestamp: "2026-09-16T12:00:00.000Z", model: "openai/gpt-test", provider: "openai", input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, assistantContent: "same response", messageId: ""
  });
  assert.equal(dedupe.accept({ ...fallback("pi:project-a/session.jsonl"), responseId: "shared-response" }), true, "first provider-qualified response ID is counted");
  assert.equal(dedupe.accept({ ...fallback("pi:project-b/session.jsonl"), provider: "openai-codex", responseId: "shared-response" }), true, "same responseId under another provider counts independently");
  assert.equal(dedupe.accept(fallback("claude:project/parent.jsonl")), true, "first same-source fallback record is counted");
  assert.equal(dedupe.accept(fallback("claude:project/parent.jsonl")), false, "same-source fallback duplicate is deduped");
  assert.equal(dedupe.accept(fallback("claude:project/parent/subagents/child.jsonl")), true, "distinct-source fallback record is preserved even with identical timestamp/model/tokens/content");
  assert.equal(dedupe.collisions.length, 1, "only the same-source fallback produces a collision diagnostic");
  assert.equal(dedupe.collisions[0].kind, "fingerprint", "fallback collision diagnostic preserves kind");
  assert.equal(dedupe.collisions[0].keptSource, "claude:project/parent.jsonl", "collision diagnostic preserves a root-relative identifier");
  assert.doesNotMatch(JSON.stringify(dedupe.collisions), /\/private\/local/, "collision diagnostics never persist absolute local paths");
}

// Root-level response IDs are accepted alongside message.responseId.
{
  const tmpFile = path.join(os.tmpdir(), `parse-root-response-id-${process.pid}.jsonl`);
  const timestamp = new Date().toISOString();
  await fs.writeFile(tmpFile, JSON.stringify({ type: "message", responseId: "root-response-id", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-root", usage: { input: 1, output: 1 } } }) + "\n");
  try {
    const { entries } = await parseTranscript(tmpFile, Date.now() - 60_000);
    assert.equal(entries[0].responseId, "root-response-id", "root-level obj.responseId participates in semantic dedupe");
  } finally { await fs.unlink(tmpFile); }
}

// Claude parent/child paths share a workflow sessionId for attribution, but
// must retain distinct root-namespaced fallback identities for usage dedupe.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-main-claude-fallback-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const timestamp = new Date().toISOString();
  const parent = path.join(claudeRoot, "project", "workflow-session.jsonl");
  const child = path.join(claudeRoot, "project", "workflow-session", "subagents", "agent.jsonl");
  const identicalRecord = { type: "assistant", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-claude-fallback", content: "same prose", usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 } } };
  await fs.mkdir(path.dirname(child), { recursive: true });
  await Promise.all([fs.writeFile(parent, JSON.stringify(identicalRecord) + "\n"), fs.writeFile(child, JSON.stringify(identicalRecord) + "\n")]);
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date(timestamp) });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    assert.equal(output.days[0].models["openai/gpt-claude-fallback"].messages, 2, "distinct Claude parent/child transcripts without IDs both count despite identical timestamp/model/tokens/content");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Direct Pi files with the same basename in different projects are separate
// transcripts, not fallback duplicates.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-main-pi-basename-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const timestamp = new Date().toISOString();
  const record = { type: "assistant", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-pi-basename", content: "same prose", usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 } } };
  const one = path.join(piRoot, "project-one", "same-basename.jsonl"); const two = path.join(piRoot, "project-two", "same-basename.jsonl");
  await Promise.all([fs.mkdir(path.dirname(one), { recursive: true }), fs.mkdir(path.dirname(two), { recursive: true })]);
  await Promise.all([fs.writeFile(one, JSON.stringify(record) + "\n"), fs.writeFile(two, JSON.stringify(record) + "\n")]);
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date(timestamp) });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    assert.equal(output.days[0].models["openai/gpt-pi-basename"].messages, 2, "same direct Pi basename in different projects cannot collide in fallback dedupe");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// main() applies one global semantic usage-record guard after canonical
// discovery. responseId wins across paths; records without one retain the
// root-namespaced transcript source dimension so identical assistant prose
// remains distinct.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-main-semantic-dedupe-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const timestamp = new Date().toISOString();
  const project = "project";
  const parentSessionId = "parent-session";
  const runUuid = "123e4567-e89b-42d3-a456-426614174001";
  const usage = { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0.01 } };
  const record = ({ id, model, responseId, content = "same prose" }) => ({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      provider: "openai-codex",
      model,
      content: [{ type: "text", text: content }],
      usage,
      ...(responseId ? { responseId } : {}),
    },
  });
  const parent = path.join(piRoot, project, `${parentSessionId}.jsonl`);
  const child = path.join(piRoot, project, parentSessionId, runUuid, "run-0", "session.jsonl");
  const artifact = path.join(piRoot, project, "subagent-artifacts", `${runUuid}_coder_transcript.jsonl`);
  const duplicateA = path.join(piRoot, project, "duplicate-a.jsonl");
  const duplicateB = path.join(piRoot, project, "duplicate-b.jsonl");
  const proseA = path.join(piRoot, project, "prose-a.jsonl");
  const proseB = path.join(piRoot, project, "prose-b.jsonl");
  const bb = path.join(bbRoot, "thread", "run-0", "session.jsonl");
  const files = new Map([
    [parent, [record({ id: "parent-message", model: "gpt-parent", responseId: "resp-parent" })]],
    [child, [record({ id: "child-message", model: "gpt-child", responseId: "resp-child" })]],
    // This copied child response must not be discovered at all.
    [artifact, [record({ id: "child-message", model: "gpt-child", responseId: "resp-child" })]],
    [duplicateA, [record({ id: "duplicate-a", model: "gpt-cross", responseId: "resp-cross" })]],
    [duplicateB, [record({ id: "duplicate-b", model: "gpt-cross", responseId: "resp-cross", content: "different copy text" })]],
    [proseA, [record({ id: "same-message-id", model: "gpt-prose" })]],
    [proseB, [record({ id: "same-message-id", model: "gpt-prose" })]],
    [bb, [record({ id: "bb-message", model: "gpt-bb", responseId: "resp-bb" })]],
  ]);
  for (const [file, records] of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, records.map(JSON.stringify).join("\n") + "\n");
  }
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date(timestamp) });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    const models = Object.values(output.days[0].models);
    const modelMessages = Object.fromEntries(Object.entries(output.days[0].models).map(([model, values]) => [model, values.messages]));
    assert.equal(models.reduce((sum, values) => sum + values.messages, 0), 6, "parent + child + one cross-path duplicate + two same-prose sessions + BB all count exactly once");
    assert.equal(modelMessages["openai-codex/gpt-parent"], 1, "direct Pi parent counts");
    assert.equal(modelMessages["openai-codex/gpt-child"], 1, "canonical Pi child counts once despite its artifact copy");
    assert.equal(modelMessages["openai-codex/gpt-cross"], 1, "cross-path responseId duplicate counts once");
    assert.equal(modelMessages["openai-codex/gpt-prose"], 2, "identical prose without response IDs remains distinct across source sessions");
    assert.equal(modelMessages["openai-codex/gpt-bb"], 1, "canonical BB record remains counted");
    assert.equal(output.dedupe.skippedUsageRecords, 1, "the responseId collision is audited in generated output");
    assert.equal(output.dedupe.collisions[0].kind, "responseId", "the audit identifies the responseId collision strategy");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Claude streamed usage fragments are response updates, not separate responses.
// The last timestamp wins, with later physical file order breaking equal-time ties.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-claude-stream-fragments-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const transcript = path.join(claudeRoot, "project", "stream.jsonl");
  const at = (seconds) => `2026-09-16T12:00:0${seconds}.000Z`;
  const assistant = ({ id, envelopeId, timestamp, text, output }) => ({ type: "assistant", ...(envelopeId ? { id: envelopeId } : {}), timestamp, message: { role: "assistant", model: "claude-sonnet-5", id, content: text, usage: { input_tokens: 2, output_tokens: output } } });
  const user = (text) => ({ type: "user", timestamp: at(0), message: { content: text } });
  const records = [
    user("<command-name>/skill-a</command-name>"),
    assistant({ id: "stream-1", timestamp: at(1), text: "draft", output: 1 }),
    user("expanded skill body"),
    user("<command-name>/skill-b</command-name>"),
    // Same response, changed text and cumulative output. This must retain 9,
    // and keep the original skill-a attribution rather than skill-b.
    assistant({ id: "stream-1", timestamp: at(2), text: "final answer", output: 9 }),
    // Equal timestamps use physical JSONL order, so 11 wins over 10.
    assistant({ id: "stream-2", timestamp: at(3), text: "first", output: 10 }),
    assistant({ id: "stream-2", timestamp: at(3), text: "second", output: 11 }),
    // A physically later but timestamp-older fragment must not replace 20.
    assistant({ id: "stream-3", timestamp: at(5), text: "newer", output: 20 }),
    assistant({ id: "stream-3", timestamp: at(4), text: "older", output: 30 }),
    // Different envelope IDs do not replace the canonical Claude message.id.
    assistant({ id: "stream-4", envelopeId: "line-one", timestamp: at(6), text: "first envelope", output: 40 }),
    assistant({ id: "stream-4", envelopeId: "line-two", timestamp: at(7), text: "last envelope", output: 50 }),
    // Missing IDs deliberately retain conservative fallback behavior.
    assistant({ id: undefined, timestamp: at(4), text: "missing one", output: 12 }),
    assistant({ id: undefined, timestamp: at(4), text: "missing two", output: 13 }),
  ];
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, records.map(JSON.stringify).join("\n") + "\n");
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date("2026-09-16T12:01:00.000Z") });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    const sonnet = output.days[0].models.sonnet;
    assert.equal(sonnet.messages, 6, "four streamed IDs plus two missing-ID fallbacks retain six responses");
    assert.equal(sonnet.outputTokens, 115, "final cumulative outputs, file-order tie winner, descending timestamp winner, and message.id grouping are retained");
    assert.equal(output.responseDiagnostics.rawUsageRecords, 10, "diagnostics retain raw fragment count separately");
    assert.equal(output.responseDiagnostics.retainedResponses, 6, "diagnostics report retained response count separately");
    assert.equal(output.skills.find((skill) => skill.key === "skill-a")?.outputTokens, 9, "final stream usage remains charged to the original skill attribution");
    assert.equal(output.skills.find((skill) => skill.key === "skill-b")?.outputTokens, 106, "later skill keeps only its own subsequent responses, including descending-timestamp and envelope-ID regressions");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Global semantic dedupe happens before skill rebuild, including duplicates
// that straddle a skill boundary. Explicitly missing initial attribution is
// also preserved when a response later flushes under a skill.
{
  const tmpFile = path.join(os.tmpdir(), `usage-skill-dedupe-${process.pid}.jsonl`);
  const at = (second) => `2026-09-16T13:00:${String(second).padStart(2, "0")}.000Z`;
  const user = (text, second) => ({ type: "user", timestamp: at(second), message: { content: text } });
  const claude = ({ id, timestamp, output, text = "same", responseId = "" }) => ({ type: "assistant", timestamp, message: { role: "assistant", model: "claude-opus-5", ...(id ? { id } : {}), ...(responseId ? { responseId } : {}), content: text, usage: { input_tokens: 2, output_tokens: output } } });
  const records = [
    user("<command-name>/first</command-name>", 0),
    claude({ timestamp: at(1), output: 9 }),
    user("expanded command body", 2),
    user("<command-name>/second</command-name>", 3),
    claude({ timestamp: at(1), output: 9 }),
    user("expanded command body", 4),
    user("<command-name>/third</command-name>", 5),
    claude({ id: "response-a", responseId: "shared-response", timestamp: at(6), output: 7, text: "first response id" }),
    user("expanded command body", 7),
    user("<command-name>/fourth</command-name>", 8),
    claude({ id: "response-b", responseId: "shared-response", timestamp: at(9), output: 7, text: "second response id" }),
    user("expanded fourth command body", 10),
    user("ordinary human boundary", 11),
    // Begins outside a skill and must remain unassigned after /later begins.
    claude({ id: "unassigned-stream", timestamp: at(12), output: 1, text: "initial unassigned" }),
    user("<command-name>/later</command-name>", 13),
    claude({ id: "unassigned-stream", timestamp: at(14), output: 9, text: "final unassigned" }),
  ];
  await fs.writeFile(tmpFile, records.map(JSON.stringify).join("\n") + "\n");
  try {
    const dedupe = createUsageRecordDedupe();
    const { entries, skillRuns } = await parseTranscript(tmpFile, Date.parse(at(0)) - 1, { usageDedupe: dedupe });
    assert.equal(entries.length, 3, "missing-ID and response-ID duplicates are removed from the retained ledger");
    assert.equal(skillRuns.find((run) => run.key === "first")?.outputTokens, 9, "first skill keeps its retained missing-ID record");
    assert.equal(skillRuns.find((run) => run.key === "second"), undefined, "duplicate missing-ID record does not leak into a later skill");
    assert.equal(skillRuns.find((run) => run.key === "third")?.outputTokens, 7, "first response-ID occurrence is retained for its original skill");
    assert.equal(skillRuns.find((run) => run.key === "fourth"), undefined, "duplicate response-ID occurrence does not leak into a later skill");
    assert.equal(skillRuns.find((run) => run.key === "later"), undefined, "explicitly absent initial attribution does not acquire a later skill");
  } finally { await fs.unlink(tmpFile); }
}

// A Claude message ID is only canonical inside its physical transcript.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-claude-source-identity-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const timestamp = "2026-09-16T12:00:00.000Z";
  const record = (output) => JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", model: "claude-opus-5", id: "same-id", content: "same", usage: { input_tokens: 1, output_tokens: output } } });
  const one = path.join(claudeRoot, "one", "a.jsonl"), two = path.join(claudeRoot, "two", "b.jsonl");
  await Promise.all([fs.mkdir(path.dirname(one), { recursive: true }), fs.mkdir(path.dirname(two), { recursive: true })]);
  await Promise.all([fs.writeFile(one, record(3) + "\n"), fs.writeFile(two, record(5) + "\n")]);
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date("2026-09-16T12:01:00.000Z") });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    const opus = output.days[0].models.opus;
    assert.equal(opus.messages, 2, "same Claude message ID in distinct transcripts never collapses");
    assert.equal(opus.outputTokens, 8, "both physical transcripts retain their own final response");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// OpenAI's response-ID path is unchanged on frozen inputs: raw and retained
// counts only diverge for an actual response-ID duplicate, never because of
// Claude stream grouping.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-openai-parity-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb");
  const timestamp = "2026-09-16T12:00:00.000Z";
  const file = path.join(piRoot, "project", "session.jsonl");
  const record = (responseId, output) => ({ type: "message", timestamp, message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", responseId, usage: { input: 2, output, cacheRead: 3, cacheWrite: 0 } } });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [record("openai-one", 5), record("openai-two", 7)].map(JSON.stringify).join("\n") + "\n");
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, now: new Date("2026-09-16T12:01:00.000Z") });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    const terra = output.days[0].models["openai-codex/gpt-5.6-terra"];
    assert.deepEqual([terra.messages, terra.inputTokens, terra.cacheReadTokens, terra.cacheWriteTokens, terra.outputTokens], [2, 4, 6, 0, 12], "OpenAI buckets retain their pre-existing response-ID accounting");
    const diagnostic = output.responseDiagnostics.byProviderModel.find((row) => row.provider === "openai" && row.model === "openai-codex/gpt-5.6-terra");
    assert.equal(diagnostic.rawUsageRecords, 2, "OpenAI raw baseline count is preserved");
    assert.equal(diagnostic.retainedResponses, 2, "OpenAI retained baseline count is preserved");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Rejected records and prior-response final flushes must not mutate a newly
// opened skill before its expanded command body is absorbed.
for (const scenario of ["duplicate", "prior-flush"]) {
  const tmpFile = path.join(os.tmpdir(), `usage-segmentation-${scenario}-${process.pid}.jsonl`);
  const at = (second) => `2026-09-16T14:00:${String(second).padStart(2, "0")}.000Z`;
  const user = (text, second) => ({ type: "user", timestamp: at(second), message: { content: text } });
  const usage = ({ id, timestamp, output, text, omitId = false }) => ({ type: "assistant", timestamp, message: { role: "assistant", model: "claude-opus-5", ...(!omitId ? { id } : {}), content: text, usage: { input_tokens: 2, output_tokens: output } } });
  const first = usage({ id: "prior-response", timestamp: at(1), output: scenario === "duplicate" ? 9 : 1, text: scenario === "duplicate" ? "duplicate" : "draft", omitId: scenario === "duplicate" });
  const rejectedOrFlush = scenario === "duplicate"
    ? usage({ id: "prior-response", timestamp: at(1), output: 9, text: "duplicate", omitId: true })
    : usage({ id: "prior-response", timestamp: at(3), output: 9, text: "final" });
  const records = [
    user("<command-name>/first</command-name>", 0),
    first,
    user("<command-name>/second</command-name>", 2),
    rejectedOrFlush,
    user("expanded command body", 4),
    usage({ id: "second-real", timestamp: at(5), output: 7, text: "genuine second response" }),
  ];
  await fs.writeFile(tmpFile, records.map(JSON.stringify).join("\n") + "\n");
  try {
    const { entries, skillRuns } = await parseTranscript(tmpFile, Date.parse(at(0)) - 1, { usageDedupe: createUsageRecordDedupe() });
    assert.equal(entries.length, 2, `${scenario}: retained ledger has the first response and genuine second response only`);
    assert.equal(skillRuns.find((run) => run.key === "first")?.outputTokens, scenario === "duplicate" ? 9 : 9, `${scenario}: first retains its response's final buckets`);
    assert.equal(skillRuns.find((run) => run.key === "second")?.outputTokens, 7, `${scenario}: rejected or prior-flush record does not consume second's command-body injection`);
  } finally { await fs.unlink(tmpFile); }
}

// Usage input guard: raw schemas are validated before aliases normalize. The
// fixture clears model/timestamp/window guards, so this test observes schema rejection itself.
{
  const rejected = createRejectedUsageDiagnostics();
  assert.deepEqual(validateUsage({ input: 0, output: 0 }, rejected), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, usagePresence: { cacheWrite: false, cacheRead: false } }, "numeric normalized zeros remain valid while optional buckets remain absent");
  for (const usage of [{}, { input: -1, output: 2 }, { input: "1", output: 2 }, { input: NaN, output: 2 }, { input: Infinity, output: 2 }, []]) assert.equal(validateUsage(usage, rejected), undefined, "empty, negative, string, non-finite, and unsupported usage are rejected");
  assert.equal(rejected.serialize().reasons["missing-input_tokens"], 1, "empty object identifies missing input instead of fabricating zero");
  assert.equal(rejected.serialize().reasons["invalid-input_tokens"], 4, "invalid input reason is counted by name");
  assert.equal(rejected.serialize().reasons["unsupported-usage"], 1, "unsupported usage form is counted by name");
}

// Both timestamp edges are inclusive, while a later final fragment outside the
// captured upper bound cannot replace the in-bound final ledger fragment.
{
  const tmp = path.join(os.tmpdir(), `usage-bounds-${process.pid}.jsonl`);
  const lower = Date.parse("2026-09-16T00:00:00.000Z"), upper = Date.parse("2026-09-16T00:00:10.000Z");
  const item = (timestamp, id, output) => ({ type: "assistant", timestamp, message: { role: "assistant", model: "claude-opus-5", id, usage: { input_tokens: 1, output_tokens: output } } });
  await fs.writeFile(tmp, [item(new Date(lower).toISOString(), "lower", 2), item(new Date(upper).toISOString(), "stream", 3), item("not-a-date", "bad", 4), item("2026-09-16T00:00:11.000Z", "stream", 9)].map(JSON.stringify).join("\n"));
  try {
    const rejected = createRejectedUsageDiagnostics();
    const { entries } = await parseTranscript(tmp, lower, { upperBoundMs: upper, rejectedUsage: rejected });
    assert.deepEqual(entries.map((entry) => [entry.claudeMessageId, entry.output_tokens]), [["lower", 2], ["stream", 3]], "inclusive temporal edges retain records and final selection is capped at scan start");
    assert.equal(rejected.serialize().reasons["invalid-timestamp"], 1, "invalid timestamp is diagnosed by name");
    assert.equal(rejected.serialize().reasons["outside-temporal-window"], 1, "later fragment is diagnosed as temporal exclusion");
  } finally { await fs.rm(tmp, { force: true }); }
}

// Timezone is explicit and host-independent at a DST-adjacent instant.
assert.equal(localDay("2026-03-29T20:30:00.000Z"), "2026-03-30", `export calendar uses ${USAGE_DAY_TIME_ZONE}, not host-local time`);

// Writers serialize publication: a bounded busy result leaves the last valid JSON byte-for-byte intact.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-atomic-"));
  const vaultRoot = path.join(root, "vault"), out = path.join(vaultRoot, "Operations", "usage", "usage-stats.json");
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, '{"last":"good"}\n');
  await fs.writeFile(`${out}.lock`, "held");
  try {
    await assert.rejects(() => main({ vaultRoot, projectsRoot: path.join(root, "claude"), piRoot: path.join(root, "pi"), bbRoot: path.join(root, "bb"), lockWaitMs: 0 }), /usage export busy/);
    assert.equal(await fs.readFile(out, "utf8"), '{"last":"good"}\n', "busy writer never truncates prior valid snapshot");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

console.log("exportUsageWorkflows: all assertions passed");
