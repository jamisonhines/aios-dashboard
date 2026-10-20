import "./testFileTimeout.mjs";
import assert from "node:assert";
import * as model from "./model.mjs";
import { computeClaudeAgentModelsView, computePiModelHistoryView } from "./model.mjs";

const snapshot = {
  schemaVersion: 2, generatedAt: "2026-10-20T10:00:00.000Z", source: "claude-agent-shims", agentsDir: ".claude/agents",
  agents: [
    { slug: "capture", name: "capture", file: ".claude/agents/capture.md", model: "haiku", status: "set" },
    { slug: "coder", name: "coder", file: ".claude/agents/coder.md", model: "sonnet", status: "set" },
    { slug: "nomodel", name: "nomodel", file: ".claude/agents/nomodel.md", model: null, status: "missing" },
  ],
  missingModel: ["nomodel"], errors: [],
};
const stats = {
  windowDays: 35,
  agents: [
    { key: "coder", runs: 5, models: { "claude-opus-5": { runs: 1, messages: 9, costUsd: 2 }, "claude-sonnet-5": { runs: 4, messages: 40, costUsd: 1 } } },
    { key: "nomodel", runs: 2, models: { "claude-opus-5": { runs: 2, messages: 3, costUsd: 1 } } },
    { key: "general-purpose", runs: 7, models: { "claude-opus-5": { runs: 7, messages: 1, costUsd: 1 } } },
  ],
};

const view = computeClaudeAgentModelsView(snapshot, stats);
assert.equal(view.available, true);
assert.equal(view.windowDays, 35);
assert.deepEqual(view.rows.map((r) => r.slug), ["capture", "coder", "nomodel"], "one row per shim, in snapshot order; non-shim usage keys are not rows");
const coder = view.rows.find((r) => r.slug === "coder");
assert.equal(coder.configured, "sonnet", "configured model comes from the shim's model line");
assert.deepEqual(coder.used, [{ model: "claude-sonnet-5", runs: 4 }, { model: "claude-opus-5", runs: 1 }], "used models come from usage-stats agents[].models, ordered by run count");
assert.equal(coder.usedRuns, 5, "total runs reuse the usage exporter's own attribution count");
assert.deepEqual(view.rows.find((r) => r.slug === "capture").used, [], "a shim with no attributed runs shows no used models");
assert.equal(view.rows.find((r) => r.slug === "capture").usedRuns, 0);
assert.deepEqual(view.missing, ["nomodel"], "missing model lines are surfaced for the loud warning");
assert.equal(view.rows.find((r) => r.slug === "nomodel").status, "missing");
assert.deepEqual(computeClaudeAgentModelsView(snapshot, null).rows.find((r) => r.slug === "coder").used, [], "no usage stats yields empty used lists, not a crash");
assert.equal(computeClaudeAgentModelsView(snapshot, null).windowDays, null);
assert.equal(computeClaudeAgentModelsView({ schemaVersion: 1, agents: [] }, stats).available, false, "a legacy Pi snapshot is never rendered as the current Claude view");
assert.equal(computeClaudeAgentModelsView(null, stats).available, false);

const legacy = {
  schemaVersion: 1, generatedAt: "2026-09-15T10:02:14.953Z",
  catalog: { providers: [{ id: "openai-codex", models: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.6-luna"] }] },
  agents: [
    { name: "coder", requested: { model: "openai-codex/gpt-5.6-terra" }, effective: { model: "openai-codex/gpt-5.6-terra", source: "project agent frontmatter" } },
    { name: "capture", requested: { model: "openai-codex/gpt-5.6-luna" }, effective: { model: null, source: "parent session model" } },
  ],
};
const history = computePiModelHistoryView(legacy);
assert.equal(history.available, true);
assert.equal(history.date, "2026-09-15");
assert.deepEqual(history.agents, [{ name: "capture", model: "openai-codex/gpt-5.6-luna" }, { name: "coder", model: "openai-codex/gpt-5.6-terra" }], "history lists each Pi agent's model, sorted by name, falling back to the requested model");
assert.deepEqual(history.providers, [{ id: "openai-codex", models: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.6-luna"] }]);
assert.equal(computePiModelHistoryView(snapshot).available, false, "a Claude snapshot is never rendered as history");
assert.equal(computePiModelHistoryView(null).available, false);

for (const retired of ["modelPickerOptions", "catalogCandidates", "orderedFallbackModels", "safeFallbackCandidates", "validateAgentSelection", "agentModelPickerState", "resolveAgentConfiguration"]) {
  assert.equal(model[retired], undefined, `retired Pi picker helper ${retired} is gone`);
}
console.log("agentModelsModel: all assertions passed");
