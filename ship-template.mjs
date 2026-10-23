#!/usr/bin/env node
// Ship the dashboard into an AIOS template (D-2026-10-23-01): build, then copy the three built
// files into <template>/.obsidian/plugins/aios-dashboard/. Instances then receive it through the
// update engine (it is a framework path there, gated as code). Usage:
//   npm run ship-template -- <template-path>        (builds first)
//   node ship-template.mjs --no-build <template-path> (tests: copies the current build)
// Refuses: a folder that is not the template, an instance vault, and a downgrade. Never writes
// data.json (per-vault settings). Does not commit: review and commit in the template repo.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = ".obsidian/plugins/aios-dashboard";
const FILES = ["main.js", "manifest.json", "styles.css"];

function semverCmp(a, b) {
  const x = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const y = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
const fail = (msg) => { console.error(msg); process.exit(1); };

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const rest = args.filter((a) => a !== "--no-build");
if (rest.length !== 1 || rest[0].startsWith("-")) fail("usage: npm run ship-template -- <template-path>");
const template = path.resolve(rest[0]);

if (existsSync(path.join(template, ".aios-update/state.json"))) {
  fail(`refusing: ${template} is an AIOS instance (it has .aios-update/state.json), not the template. Instances get the dashboard through the update engine.`);
}
if (!existsSync(path.join(template, "PROVENANCE.md")) || !existsSync(path.join(template, "Operations/template-manifest.md"))) {
  fail(`refusing: ${template} is not an AIOS template (needs PROVENANCE.md and Operations/template-manifest.md).`);
}

const version = JSON.parse(readFileSync(path.join(HERE, "manifest.json"), "utf8")).version;
const dst = path.join(template, PLUGIN_DIR);
const existing = path.join(dst, "manifest.json");
if (existsSync(existing)) {
  let have = null;
  try { have = JSON.parse(readFileSync(existing, "utf8")).version; } catch { have = null; }
  if (have && semverCmp(have, version) > 0) fail(`refusing: the template already has aios-dashboard ${have}, newer than this build (${version}).`);
}

if (!noBuild) {
  const b = spawnSync("npm", ["run", "build"], { cwd: HERE, stdio: "inherit" });
  if (b.status !== 0) fail(`build failed (exit ${b.status}); nothing was shipped.`);
}
mkdirSync(dst, { recursive: true });
for (const f of FILES) copyFileSync(path.join(HERE, f), path.join(dst, f));
console.log(`shipped aios-dashboard ${version} into ${dst}`);
console.log(`next: review and commit in the template: git -C ${template} add ${FILES.map((f) => `${PLUGIN_DIR}/${f}`).join(" ")}`);
