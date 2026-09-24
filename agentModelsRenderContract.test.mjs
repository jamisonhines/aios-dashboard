import "./testFileTimeout.mjs";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
for (const required of [
  "Configured model sources",
  "No additional assignable Pi provider or local model source was discovered.",
  "Local policy only · future launches only · access and quota unverified.",
  "Model behavior",
  "Active sessions do not change. Fallback is native Pi behavior for early provider/model failures.",
  "renderAgentModelControls(app, modelArea",
  "modelPickerOptions(snapshot.catalog, settings.enabledModelProviders)",
  "Cross-provider fallback may use separate billing.",
  "aios-agent-card",
  "Details & provenance",
  "View ${provider.models.length} model",
  "const isDirty = () =>",
  "No changes",
  "Ready to save",
]) assert.ok(source.includes(required), `render contract includes: ${required}`);
for (const required of [
  "grid-template-areas: \"identity model usage\" \"links links links\"",
  "grid-area: identity",
  "grid-area: model",
  "grid-area: usage",
  "grid-template-areas: \"dot info models action\"",
  "container-type: inline-size",
  "@container (max-width: 720px)",
  "@container (max-width: 460px)",
  "grid-template-columns: minmax(0, 360px) 88px",
  "width: 88px",
  "align-self: center",
  "grid-template-areas: \"primary\" \"save\" \"meta\" \"state\" \"chain\" \"details\"",
  "justify-self: start",
  "white-space: nowrap",
  "select, .aios-dashboard-root option",
  "option:disabled",
  "aios-agent-model-step-action",
]) assert.ok(styles.includes(required), `layout contract includes: ${required}`);
assert.ok(!source.includes("renderAgentModelsPanel"), "old detached bottom model-management panel is absent");
assert.ok(!source.includes("aios-system-agent-model-badge"), "static historical model badge is absent from roster rendering");
console.log("agentModelsRenderContract: all assertions passed");
