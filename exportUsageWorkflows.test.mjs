// Tests for the exporter's workflow classifier (build 2.5 m1). Imports the
// REAL functions from the repo-canonical exporter (vault-scripts/, deployed
// to the vault by deploy.sh). Importing the exporter never starts a scan
// (direct-execution guard). Run: node exportUsageWorkflows.test.mjs
import assert from "node:assert";
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

console.log("exportUsageWorkflows: all assertions passed");
