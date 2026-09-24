import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestText, readProjectAgentSettings, writeProjectAgentOverride } from "./agent-models-write.mjs";

const vault = await fs.mkdtemp(path.join(os.tmpdir(), "agent-model-write-"));
try {
  const settingsPath = path.join(vault, ".pi", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ packages: ["keep"], subagents: { defaultModel: "retain", agentOverrides: { other: { model: "openai-codex/other", extra: true }, tooling: { model: "openai-codex/primary" } } } }, null, 2));
  const before = await readProjectAgentSettings(vault);
  const cleared = await writeProjectAgentOverride(vault, "tooling", "openai-codex/primary", [], before.digest);
  assert.equal(cleared.status, "written", "absent fallback key is not a no-op when clearing inheritance");
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")).subagents.agentOverrides.tooling.fallbackModels, []);
  const result = await writeProjectAgentOverride(vault, "tooling", "openai-codex/primary", ["openai-codex/fallback"], cleared.digest);
  assert.equal(result.status, "written");
  const saved = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(saved.packages, ["keep"]); assert.equal(saved.subagents.defaultModel, "retain"); assert.deepEqual(saved.subagents.agentOverrides.other, { model: "openai-codex/other", extra: true });
  await assert.rejects(() => writeProjectAgentOverride(vault, "tooling", "openai-codex/new", [], "sha256:stale"), /configuration changed on disk, refresh and retry/);
  const canaryBytes = await fs.readFile(settingsPath, "utf8");
  const canary = await writeProjectAgentOverride(vault, "tooling", "openai-codex/new", [], result.digest, { beforeRename: async (file) => fs.writeFile(file, canaryBytes.replace("retain", "CONCURRENT_CANARY")) });
  assert.equal(canary.status, "written", "canary demonstrates residual external-writer race, not a CAS claim");
  assert.ok(!(await fs.readFile(settingsPath, "utf8")).includes("CONCURRENT_CANARY"), "test pin documents that uncooperative final-window changes are not preserved");

  const beforeFinal = await readProjectAgentSettings(vault);
  const beforeFinalCanary = "{\"external\":\"BEFORE_FINAL_READ\"}\n";
  await assert.rejects(
    () => writeProjectAgentOverride(vault, "tooling", "openai-codex/final", [], beforeFinal.digest, { beforeFinalRead: async (file) => fs.writeFile(file, beforeFinalCanary) }),
    /configuration changed on disk, refresh and retry/
  );
  assert.equal(await fs.readFile(settingsPath, "utf8"), beforeFinalCanary, "final digest guard preserves a change made after the first check");
  const finalState = await readProjectAgentSettings(vault);
  let releaseFirst; let firstAtFinalRead;
  const firstWaiting = new Promise((resolve) => { firstAtFinalRead = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  const first = writeProjectAgentOverride(vault, "tooling", "openai-codex/lock-one", [], finalState.digest, { beforeFinalRead: async () => { firstAtFinalRead(); await release; } });
  await firstWaiting;
  await assert.rejects(() => writeProjectAgentOverride(vault, "tooling", "openai-codex/lock-two", [], finalState.digest), /configuration save already in progress/);
  releaseFirst(); await first;
  const outside = path.join(vault, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "settings.json"), "{}");
  await fs.rm(path.join(vault, ".pi"), { recursive: true, force: true }); await fs.symlink(outside, path.join(vault, ".pi"));
  await assert.rejects(() => readProjectAgentSettings(vault), /must not be a symlink/);
  assert.equal(await fs.readFile(path.join(outside, "settings.json"), "utf8"), "{}", "symlink target is never changed");

  const fileLinkVault = await fs.mkdtemp(path.join(os.tmpdir(), "agent-model-file-link-"));
  try {
    await fs.mkdir(path.join(fileLinkVault, ".pi"));
    const target = path.join(fileLinkVault, "outside-settings.json"); await fs.writeFile(target, "{}");
    await fs.symlink(target, path.join(fileLinkVault, ".pi", "settings.json"));
    await assert.rejects(() => readProjectAgentSettings(fileLinkVault), /settings\.json must not be a symlink/);
    assert.equal(await fs.readFile(target, "utf8"), "{}", "settings-file symlink target is never changed");
  } finally { await fs.rm(fileLinkVault, { recursive: true, force: true }); }
} finally { await fs.rm(vault, { recursive: true, force: true }); }
console.log("agentModelsWrite: all assertions passed");
