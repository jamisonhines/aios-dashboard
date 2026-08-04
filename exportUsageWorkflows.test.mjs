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
  findTranscripts,
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

console.log("exportUsageWorkflows: all assertions passed");
