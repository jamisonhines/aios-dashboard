import "./testFileTimeout.mjs";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
for (const required of [
  "Agent models (Claude)",
  "Read-only. Configured = the model: line in .claude/agents/<slug>.md.",
  "These shims silently inherit the main session's Opus (expensive).",
  "Before 2026-10-12: Pi / OpenAI (history, read-only)",
  "computeClaudeAgentModelsView(agentModelsRaw, stats)",
  "computePiModelHistoryView(historyRaw)",
  "renderAgentModelReadonly(modelArea",
  "agentModelsHistoryPath: \"Operations/agent-models-history/2026-09-15-pi.json\"",
  "aios-agent-card",
]) assert.ok(source.includes(required), `render contract includes: ${required}`);
// Read-only: no write path, picker or provider policy survives in the view.
for (const banned of ["agent-models-write", "writeProjectAgentOverride", "readProjectAgentSettings", "enabledModelProviders", "aios-agent-model-save", "aios-agent-model-primary", "aios-agent-model-fallback-picker", "renderAgentModelControls", "Ready to save"]) {
  assert.ok(!source.includes(banned), `view no longer contains ${banned}`);
}
for (const required of [
  "grid-template-areas: \"identity model usage\" \"links links links\"",
  "grid-area: model",
  ".aios-agent-model-configured.is-missing",
  ".aios-agent-model-table-row",
  ".aios-agent-model-history",
]) assert.ok(styles.includes(required), `layout contract includes: ${required}`);
for (const dead of [".aios-agent-model-save", ".aios-agent-model-primary", ".aios-agent-provider-inventory", ".aios-agent-model-fallback"]) assert.ok(!styles.includes(dead), `dead picker style ${dead} is removed`);
console.log("agentModelsRenderContract: all assertions passed");
