import "./testFileTimeout.mjs";
// D-2026-10-23-01 REQ-1: `npm run ship-template -- <template-path>` builds the plugin and copies
// its three built files into an AIOS template. It must refuse anything that is not a template
// (an instance vault is never a target), never write data.json, and never downgrade.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "ship-template.mjs");
const PLUGIN_DIR = ".obsidian/plugins/aios-dashboard";
const FILES = ["main.js", "manifest.json", "styles.css"];
const tmps = [];
process.on("exit", () => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function makeTemplate({ instance = false, provenance = true, pluginVersion = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ship-template-"));
  tmps.push(dir);
  mkdirSync(path.join(dir, "Operations"), { recursive: true });
  writeFileSync(path.join(dir, "Operations/template-manifest.md"), "```aios-framework-paths\nframework: x\n```\n");
  if (provenance) writeFileSync(path.join(dir, "PROVENANCE.md"), "template\n");
  if (instance) { mkdirSync(path.join(dir, ".aios-update"), { recursive: true }); writeFileSync(path.join(dir, ".aios-update/state.json"), "{}\n"); }
  if (pluginVersion) {
    mkdirSync(path.join(dir, PLUGIN_DIR), { recursive: true });
    writeFileSync(path.join(dir, PLUGIN_DIR, "manifest.json"), JSON.stringify({ id: "aios-dashboard", version: pluginVersion }));
  }
  return dir;
}
const ship = (...args) => spawnSync("node", [SCRIPT, "--no-build", ...args], { cwd: HERE, encoding: "utf8" });
const repoVersion = JSON.parse(readFileSync(path.join(HERE, "manifest.json"), "utf8")).version;

// SHIP-1 happy path: the three built files land byte-identical, nothing else is written.
{
  const t = makeTemplate({ pluginVersion: "1.0.0" });
  const r = ship(t);
  assert.equal(r.status, 0, `SHIP-1 exit 0, got ${r.status}: ${r.stderr}`);
  for (const f of FILES) {
    assert.ok(existsSync(path.join(t, PLUGIN_DIR, f)), `SHIP-1 ${f} was shipped into the template`);
    assert.ok(readFileSync(path.join(t, PLUGIN_DIR, f)).equals(readFileSync(path.join(HERE, f))), `SHIP-1 ${f} is byte-identical to the build`);
  }
  assert.equal(existsSync(path.join(t, PLUGIN_DIR, "data.json")), false, "SHIP-2 data.json is never shipped");
  assert.match(r.stdout, new RegExp(`shipped aios-dashboard ${repoVersion.replace(/\./g, "\\.")} into`), "SHIP-3 names the shipped version");
}
// SHIP-4 an instance vault is refused by name, and nothing is written.
{
  const t = makeTemplate({ instance: true });
  const r = ship(t);
  assert.equal(r.status, 1, "SHIP-4 refuses an instance");
  assert.match(r.stderr, /is an AIOS instance \(it has \.aios-update\/state\.json\), not the template/, "SHIP-4 names why");
  assert.equal(existsSync(path.join(t, PLUGIN_DIR, "main.js")), false, "SHIP-4 nothing written into an instance");
}
// SHIP-5 a folder without PROVENANCE.md and the manifest is not a template.
{
  const t = makeTemplate({ provenance: false });
  const r = ship(t);
  assert.equal(r.status, 1, "SHIP-5 refuses a non-template");
  assert.match(r.stderr, /is not an AIOS template \(needs PROVENANCE\.md and Operations\/template-manifest\.md\)/, "SHIP-5 names why");
  assert.equal(existsSync(path.join(t, PLUGIN_DIR, "main.js")), false, "SHIP-5 nothing written");
}
// SHIP-6 a template already carrying a newer dashboard is not downgraded.
{
  const t = makeTemplate({ pluginVersion: "99.0.0" });
  const r = ship(t);
  assert.equal(r.status, 1, "SHIP-6 refuses a downgrade");
  assert.match(r.stderr, new RegExp(`template already has aios-dashboard 99\\.0\\.0, newer than this build \\(${repoVersion.replace(/\./g, "\\.")}\\)`), "SHIP-6 names both versions");
  assert.equal(JSON.parse(readFileSync(path.join(t, PLUGIN_DIR, "manifest.json"), "utf8")).version, "99.0.0", "SHIP-6 manifest untouched");
}
// SHIP-7 usage.
{
  const r = ship();
  assert.equal(r.status, 1, "SHIP-7 no path is a usage error");
  assert.match(r.stderr, /usage: npm run ship-template -- <template-path>/, "SHIP-7 usage text");
}

console.log("shipTemplate.test.mjs: all assertions passed");
