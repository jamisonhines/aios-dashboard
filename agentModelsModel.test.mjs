import assert from "node:assert";
import {
  catalogCandidates,
  resolveAgentConfiguration,
  validateAgentSelection,
  orderedFallbackModels,
  agentModelPickerState,
  safeFallbackCandidates,
  modelPickerOptions,
} from "./model.mjs";

const catalog = {
  providers: [
    { id: "openai-codex", access: "connected", availability: "active", fallbackSafe: true, models: ["openai-codex/gpt-primary", "openai-codex/gpt-fallback"] },
    { id: "other", access: "unknown", models: ["other/not-selectable"] },
  ],
};

assert.deepEqual(catalogCandidates(catalog, ["openai-codex"]), ["openai-codex/gpt-fallback", "openai-codex/gpt-primary"]);
assert.deepEqual(
  orderedFallbackModels("openai-codex/gpt-primary", ["openai-codex/gpt-fallback", "openai-codex/gpt-primary", "other/not-selectable"]),
  ["openai-codex/gpt-fallback", "other/not-selectable"],
  "fallback order is preserved and duplicates of primary are removed"
);
assert.deepEqual(
  validateAgentSelection(catalog, "openai-codex/gpt-primary", ["openai-codex/gpt-fallback"], ["openai-codex"]),
  { valid: true, reason: null }
);
assert.equal(agentModelPickerState(catalog, "openai-codex/gpt-primary", [], true, ["openai-codex"]).disabled, false, "connected safe route can be selected");
const catalogOnly = { providers: [{ id: "cache", access: "catalog-only", availability: "unknown", models: ["cache/primary", "cache/fallback"] }] };
assert.equal(agentModelPickerState(catalogOnly, "cache/primary", [], true).disabled, true, "unverified cached access disables primary selection");
assert.deepEqual(modelPickerOptions(catalogOnly, [])[0], { model: "cache/fallback", selectable: false, label: "Disabled by you; subscription and current quota not verified" });
const inactive = { providers: [{ id: "paused", access: "connected", availability: "inactive", models: ["paused/model"] }] };
assert.deepEqual(modelPickerOptions(inactive, [])[0], { model: "paused/model", selectable: false, label: "Subscription inactive" }, "verified inactive is distinct from unknown");
assert.equal(modelPickerOptions(inactive, ["paused"])[0].selectable, false, "owner enablement never overrides explicit inactive availability");
assert.deepEqual(safeFallbackCandidates(inactive, "other/primary", ["paused"]), [], "explicitly inactive provider is never a fallback candidate");
assert.equal(validateAgentSelection(catalogOnly, "cache/primary", ["cache/fallback"]).valid, false, "catalog-only never claims subscription-safe automatic fallback");
assert.deepEqual(safeFallbackCandidates(catalogOnly, "cache/primary", []), [], "same-provider cached IDs do not prove billing safety");
const connectedUnsafe = { providers: [{ id: "p", access: "connected", availability: "active", fallbackSafe: false, models: ["p/primary", "p/fallback"] }] };
assert.equal(validateAgentSelection(connectedUnsafe, "p/primary", ["p/fallback"], ["p"]).valid, true, "owner-enabled provider permits explicitly ordered fallback without entitlement claim");
assert.equal(validateAgentSelection(connectedUnsafe, "p/primary", ["p/fallback"], []).valid, false, "disabled provider cannot be newly selected for fallback");
const disconnectedUnknown = { providers: [{ id: "offline", access: "disconnected", availability: "unknown", models: ["offline/model"] }] };
assert.deepEqual(modelPickerOptions(disconnectedUnknown, [])[0], { model: "offline/model", selectable: false, label: "Disabled by you; subscription and current quota not verified" }, "disconnected does not prove inactive subscription");
assert.equal(agentModelPickerState(catalog, "openai-codex/gpt-primary", [], false).disabled, true, "stale snapshot disables Save");
assert.equal(agentModelPickerState({ providers: [] }, "openai-codex/gpt-primary", [], true).disabled, true, "unknown catalog disables Save");
assert.equal(validateAgentSelection(catalog, "other/not-selectable", []).valid, false, "unknown access is never safe to select");
assert.equal(validateAgentSelection(catalog, "openai-codex/not-cached", []).valid, false, "historical IDs are rejected");

const frontmatter = { model: "openai-codex/frontmatter", fallbackModels: ["openai-codex/f1"] };
assert.equal(resolveAgentConfiguration("tooling", frontmatter, {}, {}).effective.source, "project agent frontmatter");
assert.equal(
  resolveAgentConfiguration("tooling", frontmatter, { agentOverrides: { tooling: { model: "openai-codex/user" } } }, { agentOverrides: { tooling: { model: "openai-codex/project" } } }).effective.model,
  "openai-codex/project",
  "project override beats user override"
);
const providerSpecific = resolveAgentConfiguration(
  "tooling",
  frontmatter,
  {},
  { agentOverrides: { tooling: { model: "openai-codex/project" } }, agentOverridesByProvider: { "openai-codex": { tooling: { model: "openai-codex/provider" } } } }
);
assert.equal(providerSpecific.effective.model, "openai-codex/project", "unknown active parent provider does not fabricate runtime effective value");
assert.equal(providerSpecific.runtimeOnly, true, "provider-specific resolution requires runtime parent provider inspection");
assert.equal(resolveAgentConfiguration("tooling", { model: "inherit" }, {}, {}).effective.source, "parent session model (inherit)");

console.log("agentModelsModel: all assertions passed");
