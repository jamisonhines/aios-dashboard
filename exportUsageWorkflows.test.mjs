// Tests for the exporter's workflow classifier (build 2.5 m1). Mirror of
// buildWorkflowRules / classifyWorkflow / extractTextContent in
// ~/AIOS/Operations/scripts/export-usage-stats.mjs (kept in sync manually;
// the exporter lives in the vault, not this repo). Run: node exportUsageWorkflows.test.mjs
import assert from "node:assert";

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

const FIRST_COMMAND_RE = /<command-name>(\/[\w-]+)<\/command-name>/;

function buildWorkflowRules(bridgeSessionIds) {
  return [
    {
      key: "telegram-bridge",
      label: "Telegram bridge",
      match: (ctx) => bridgeSessionIds.has(ctx.sessionId),
    },
    {
      key: "telegram-ingest",
      label: "Telegram ingest (WS-004)",
      match: (ctx) =>
        ctx.firstUserContent.startsWith("Run WS-004") ||
        ctx.firstUserContent.includes("ingest-and-upgrade"),
    },
    {
      key: "email-router",
      label: "Email router",
      match: (ctx) => ctx.firstCommand === "/vgb-email-router",
    },
    {
      key: "email-followups",
      label: "Email follow-ups",
      match: (ctx) => ctx.firstCommand === "/vgb-draft-followup",
    },
    {
      key: "email-postmortem",
      label: "Email postmortem",
      match: (ctx) => ctx.firstCommand === "/vgb-draft-postmortem",
    },
    {
      key: "email-other",
      label: "Email automation (other)",
      match: (ctx) => typeof ctx.firstCommand === "string" && ctx.firstCommand.startsWith("/vgb-"),
    },
    {
      key: "learning-scan",
      label: "Learning scan",
      match: (ctx) => ctx.project.endsWith("Operations-learning-scan"),
    },
    {
      key: "interactive",
      label: "Interactive",
      match: () => true,
    },
  ];
}

function classifyWorkflow(rules, ctx) {
  for (const rule of rules) {
    if (rule.match(ctx)) return rule;
  }
  return rules[rules.length - 1];
}

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

console.log("exportUsageWorkflows: all assertions passed");
