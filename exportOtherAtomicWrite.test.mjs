import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "other-exporters-atomic-"));
const fakeHome = path.join(root, "home");
const fakeBin = path.join(root, "bin");
await fs.mkdir(path.join(fakeHome, ".claude", "skills", "synthetic-skill"), { recursive: true });
await fs.mkdir(path.join(fakeHome, ".pi", "agent", "sessions"), { recursive: true });
await fs.mkdir(path.join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
await fs.mkdir(fakeBin, { recursive: true });
await fs.writeFile(path.join(fakeHome, ".claude", "skills", "synthetic-skill", "SKILL.md"), "---\nname: synthetic-skill\ndescription: fixture\n---\n# Synthetic skill\n");
await fs.writeFile(path.join(fakeHome, ".pi", "agent", "settings.json"), "{}");
await fs.writeFile(path.join(fakeHome, ".pi", "agent", "models-store.json"), JSON.stringify({ providers: { synthetic: { models: ["fixture-model"] } } }));
await fs.writeFile(path.join(fakeBin, "launchctl"), "#!/bin/sh\nprintf '123\\t0\\tcom.aios.synthetic.fixture\\n'\n");
await fs.writeFile(path.join(fakeBin, "plutil"), "#!/bin/sh\nprintf '{\"Label\":\"com.aios.synthetic.fixture\",\"StartInterval\":60}'\n");
await fs.chmod(path.join(fakeBin, "launchctl"), 0o755); await fs.chmod(path.join(fakeBin, "plutil"), 0o755);
await fs.writeFile(path.join(fakeHome, "Library", "LaunchAgents", "com.aios.synthetic.fixture.plist"), "synthetic");
const syntheticEnv = { HOME: fakeHome, PATH: fakeBin };
const cases = [
  ["vault-scripts/export-ops-map.mjs", "ops-map.json", (json) => Array.isArray(json.nodes) && json.nodes.some((node) => node.id === "synthetic-skill")],
  ["vault-scripts/export-automation-health.mjs", "automation-health.json", (json) => Array.isArray(json.jobs) && json.jobs.some((job) => job.label === "com.aios.synthetic.fixture")],
  ["vault-scripts/export-agent-models.mjs", "agent-models.json", (json) => Array.isArray(json.agents) && json.agents.some((agent) => agent.name === "Synthetic Agent")],
];
const run = (script, vault, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, vault], { env: { ...process.env, ...syntheticEnv, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => stdout += d); child.stderr.on("data", (d) => stderr += d);
  child.once("exit", (code) => resolve({ code, stdout, stderr }));
});
try {
  for (const [script, fileName, populated] of cases) {
    const vault = path.join(root, fileName);
    await fs.mkdir(path.join(vault, ".claude", "agents"), { recursive: true });
    await fs.mkdir(path.join(vault, ".pi", "agents"), { recursive: true });
    await fs.writeFile(path.join(vault, ".claude", "agents", "synthetic.md"), "---\nname: Synthetic\n---\nfixture");
    await fs.writeFile(path.join(vault, ".pi", "agents", "synthetic.md"), "---\nname: Synthetic Agent\nmodel: synthetic/fixture-model\n---\nfixture");
    const outFile = path.join(vault, "Operations", fileName === "ops-map.json" || fileName === "agent-models.json" ? "" : "usage", fileName);
    const outcomes = new Set(); let polling = true;
    const reader = (async () => { while (polling) { try { const json = JSON.parse(await fs.readFile(outFile, "utf8")); outcomes.add(populated(json) ? "valid" : "invalid-shape"); } catch (error) { outcomes.add(error?.code === "ENOENT" ? "absent" : "invalid-json"); } await new Promise((r) => setTimeout(r, 2)); } })();
    const results = await Promise.all(Array.from({ length: 3 }, () => run(script, vault, { AIOS_EXPORT_TEST_WRITE_CHUNK_DELAY_MS: "15", AIOS_EXPORT_TEST_LOCK_STALE_MS: "60000" })));
    polling = false; await reader;
    assert.deepEqual([...outcomes].filter((outcome) => outcome.startsWith("invalid")), [], `${fileName}: concurrent readers must never observe partial or fixture-empty JSON, got ${JSON.stringify([...outcomes])}`);
    assert.ok(outcomes.has("valid"), `${fileName}: reader must observe a complete JSON artifact populated from the synthetic fixture`);
    assert.ok(results.every((result) => result.code === 0), `${fileName}: all real exporter processes must exit cleanly, got ${JSON.stringify(results)}`);
    assert.equal(path.basename(outFile), fileName, `${fileName}: happy-path assertion pins the exact live JSON resource name`);
    console.log(`${fileName}: 3 real writers and concurrent reader observed only complete populated JSON (${[...outcomes].join(", ")})`);
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log("exportOtherAtomicWrite: all assertions passed");
