#!/usr/bin/env node
// Read-only snapshot of the Claude specialist shims' configured models
// (D-2026-10-20-02). It reads only <vault>/.claude/agents/*.md frontmatter,
// never a credential, settings or provider file, and never writes a shim.
// A shim with no `model:` line silently inherits the main session's model
// (Opus), so it is flagged as missing.
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withOwnedExportLock, writeJsonAtomic } from "./export-json-atomic.mjs";

const AGENTS_DIR = path.join(".claude", "agents");
const unquote = (value) => value.trim().replace(/^["']|["']$/g, "").trim();

export function parseShimFrontmatter(text) {
  const match = typeof text === "string" && text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { name: null, model: null };
  const fields = {};
  // Top-level keys only: an indented continuation line is never a key.
  for (const line of match[1].split("\n")) { const entry = line.match(/^([\w-]+):\s*(.*)$/); if (entry && !(entry[1] in fields)) fields[entry[1]] = unquote(entry[2]); }
  return { name: fields.name || null, model: fields.model || null };
}

export async function buildAgentModelsSnapshot({ vaultRoot } = {}) {
  if (!vaultRoot) throw new Error("vaultRoot is required");
  const dir = path.join(vaultRoot, AGENTS_DIR);
  const errors = []; let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { errors.push(".claude/agents not found"); }
  const agents = [];
  // Regular files only: a symlinked shim could point anywhere, so it is skipped.
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    const slug = entry.name.slice(0, -3);
    const parsed = parseShimFrontmatter(await fs.readFile(path.join(dir, entry.name), "utf8"));
    const status = !parsed.model ? "missing" : parsed.model === "inherit" ? "inherit" : "set";
    agents.push({ slug, name: parsed.name || slug, file: `.claude/agents/${entry.name}`, model: parsed.model, status });
  }
  return { schemaVersion: 2, generatedAt: new Date().toISOString(), source: "claude-agent-shims", agentsDir: ".claude/agents", agents, missingModel: agents.filter((a) => a.status === "missing").map((a) => a.slug), errors };
}

// The pre-2026-10-12 Pi/OpenAI snapshot (schemaVersion 1) is history. Before
// the first Claude export replaces it, copy it (never move it) to a dated
// file beside the output. An existing history file is never overwritten.
export async function preserveLegacySnapshot(output) {
  let raw; try { raw = await fs.readFile(output, "utf8"); } catch { return { status: "absent" }; }
  let parsed; try { parsed = JSON.parse(raw); } catch { return { status: "not-legacy" }; }
  if (parsed?.schemaVersion !== 1) return { status: "not-legacy" };
  const day = typeof parsed.generatedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(parsed.generatedAt) ? parsed.generatedAt.slice(0, 10) : "undated";
  const historyFile = path.join(path.dirname(output), "agent-models-history", `${day}-pi.json`);
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  try { await fs.copyFile(output, historyFile, fsConstants.COPYFILE_EXCL); }
  catch (error) { if (error?.code === "EEXIST") return { status: "exists", historyFile }; throw error; }
  return { status: "copied", historyFile };
}

export async function main(vaultRoot = process.cwd(), { output = path.join(vaultRoot, "Operations", "agent-models.json") } = {}) {
  const snapshot = await buildAgentModelsSnapshot({ vaultRoot });
  let preserved = null;
  const result = await withOwnedExportLock(output, async ({ isOwner }) => {
    preserved = await preserveLegacySnapshot(output);
    await writeJsonAtomic(output, snapshot, { beforeRename: isOwner });
  });
  if (result.busy) { console.log(`agent-models export busy; another writer holds ${output}.lock`); return; }
  if (preserved?.status === "copied") console.log(`agent-models: preserved Pi history snapshot -> ${preserved.historyFile}`);
  const missing = snapshot.missingModel.length ? `${snapshot.missingModel.length} missing a model line (${snapshot.missingModel.join(", ")})` : "all have a model line";
  console.log(`agent-models: ${snapshot.agents.length} Claude agent shim(s), ${missing} -> ${output}`);
}

function parseArgs(argv) {
  const args = [...argv]; let output;
  const outIndex = args.indexOf("--out");
  if (outIndex !== -1) { output = args[outIndex + 1]; if (!output) throw new Error("--out needs a path"); args.splice(outIndex, 2); }
  return { vaultRoot: args[0] || process.cwd(), output: output ? path.resolve(output) : undefined };
}
const direct = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  Promise.resolve().then(() => { const { vaultRoot, output } = parseArgs(process.argv.slice(2)); return main(vaultRoot, output ? { output } : {}); })
    .catch((error) => { console.error("agent-models: export failed:", error?.message || error); process.exitCode = 1; });
}
