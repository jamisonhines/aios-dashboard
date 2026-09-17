import assert from "node:assert";
import { readFile } from "node:fs/promises";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const rule = (selector) => {
  const match = styles.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `style rule exists: ${selector}`);
  return match[1];
};

const controls = rule(".aios-dashboard-root .aios-agent-model-controls");
assert.match(controls, /grid-template-columns:\s*minmax\(0, 360px\) 88px/, "wide layout reserves only a compact Save column");
assert.match(controls, /grid-template-areas:\s*"primary save" "meta state"/, "status remains adjacent to its compact Save control");

const save = rule(".aios-dashboard-root .aios-agent-model-save");
assert.match(save, /width:\s*88px/, "Save remains within the requested compact 72–96px range");
assert.match(save, /align-self:\s*center/, "Save does not stretch to the model area's height");
assert.match(save, /justify-self:\s*start/, "Save stays immediately after the selector");

const disabled = rule(".aios-dashboard-root .aios-agent-model-save:disabled");
assert.match(disabled, /opacity:\s*1/, "unchanged Save remains recognizable instead of fading into a slab");
assert.match(disabled, /color:\s*var\(--aios-dim\)/, "unchanged Save is subdued");

const state = rule(".aios-dashboard-root .aios-agent-model-state");
assert.match(state, /text-align:\s*left/, "status stays compact beside/below Save rather than reserving model width");
assert.match(state, /white-space:\s*normal/, "long status text can wrap in the compact column");

assert.match(styles, /@container \(max-width: 460px\)[\s\S]*?\.aios-agent-model-save \{ justify-self: start; width: 88px; min-height: 28px; \}/, "narrow layout keeps Save compact and left-aligned");
console.log("agentModelsStyle: all assertions passed");
