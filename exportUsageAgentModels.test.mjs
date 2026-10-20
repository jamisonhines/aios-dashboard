import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyAgentTranscript, main } from "./vault-scripts/export-usage-stats.mjs";

// Per-agent model breakdown (D-2026-10-20-02). It rides on the existing
// attributionAgent fold: same buckets, same one-file-one-run rule, plus a
// per-model count of the runs (files) that used each model.
{
  const agents = new Map();
  const at = (timestamp, model) => ({ timestamp, model, input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  // File 1 uses sonnet twice and opus once: sonnet must count ONE run, not two messages.
  applyAgentTranscript(agents, "coder", [at("2026-10-15T10:00:00Z", "claude-sonnet-5"), at("2026-10-15T10:01:00Z", "claude-sonnet-5"), at("2026-10-15T10:02:00Z", "claude-opus-5")]);
  // File 2 uses sonnet only.
  applyAgentTranscript(agents, "coder", [at("2026-10-16T10:00:00Z", "claude-sonnet-5")]);
  applyAgentTranscript(agents, "capture", [at("2026-10-16T11:00:00Z", "claude-haiku-4-5")]);
  const coder = agents.get("coder");
  assert.equal(coder.runs, 2, "existing run count is unchanged by the model breakdown");
  assert.deepEqual(Object.keys(coder.models).sort(), ["claude-opus-5", "claude-sonnet-5"], "coder breakdown names exactly the models its runs used");
  assert.equal(coder.models["claude-sonnet-5"].runs, 2, "sonnet appears in both coder runs: runs counts files, not messages");
  assert.equal(coder.models["claude-sonnet-5"].messages, 3, "sonnet messages still sum across files");
  assert.equal(coder.models["claude-opus-5"].runs, 1, "opus appears in one coder run");
  assert.deepEqual(Object.keys(agents.get("capture").models), ["claude-haiku-4-5"], "breakdown stays per agent, never shared across buckets");
  const empty = new Map(); applyAgentTranscript(empty, "coder", []);
  assert.equal(empty.size, 0, "an empty run still creates no bucket");
}

// End to end: usage-stats.json agents[] carries the per-model breakdown for an
// attributed subagent transcript.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-agent-models-"));
  const vaultRoot = path.join(root, "vault"), claudeRoot = path.join(root, "claude"), piRoot = path.join(root, "pi"), bbRoot = path.join(root, "bb"), codexRoot = path.join(root, "codex");
  const timestamp = new Date().toISOString();
  const child = path.join(claudeRoot, "project", "session-1", "subagents", "agent-a.jsonl");
  const line = (model, id) => JSON.stringify({ type: "assistant", timestamp, attributionAgent: "coder", message: { id, model, usage: { input_tokens: 10, output_tokens: 20 } } });
  await fs.mkdir(path.dirname(child), { recursive: true });
  await fs.writeFile(child, [line("claude-sonnet-5", "msg_1"), line("claude-sonnet-5", "msg_2")].join("\n") + "\n");
  try {
    await main({ vaultRoot, projectsRoot: claudeRoot, piRoot, bbRoot, codexRoot, now: new Date(timestamp) });
    const output = JSON.parse(await fs.readFile(path.join(vaultRoot, "Operations", "usage", "usage-stats.json"), "utf8"));
    const coder = output.agents.find((agent) => agent.key === "coder");
    assert.ok(coder, "attributed subagent run reaches usage-stats.json agents[]");
    assert.deepEqual(coder.models, { "claude-sonnet-5": { runs: 1, messages: 2, costUsd: coder.models["claude-sonnet-5"].costUsd } }, "agents[].models serializes the per-model run count");
    assert.ok(coder.models["claude-sonnet-5"].costUsd > 0, "per-model cost is carried, not zeroed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
console.log("exportUsageAgentModels: all assertions passed");
