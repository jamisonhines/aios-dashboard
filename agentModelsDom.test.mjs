import "./testFileTimeout.mjs";
import assert from "node:assert";
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { computeClaudeAgentModelsView, computePiModelHistoryView } from "./model.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-dom-"));
const stub = path.join(dir, "obsidian.mjs"), entry = path.join(root, ".agent-model-dom-entry.ts"), out = path.join(dir, "out.mjs");
fs.writeFileSync(stub, `export class App{}; export class ItemView{}; export class Menu{}; export class Modal{}; export class Notice{}; export const Platform={isDesktop:true}; export class Plugin{}; export class PluginSettingTab{}; export class Scope{}; export class Setting{}; export class TFile{}; export class TFolder{}; export class WorkspaceLeaf{}; export const normalizePath=(x)=>x; export const setIcon=()=>{};`);
fs.writeFileSync(entry, fs.readFileSync(path.join(root, "main.ts"), "utf8") + "\nexport { renderAgentModelsInventory as inventory, renderSystemAgentsTable as roster };\n");
try {
  esbuild.buildSync({ absWorkingDir: root, entryPoints: [path.basename(entry)], bundle: true, format: "esm", outfile: out, treeShaking: false, external: ["electron","child_process","node:crypto","node:fs","node:path","@codemirror/*","@lezer/*"], alias: { obsidian: stub } });
  const { inventory, roster } = await import(pathToFileURL(out).href);
  function el(tag = "div", opts = {}) { const node = { tag, children: [], text: opts.text || "", cls: opts.cls || "", attrs: opts.attr || {}, empty(){this.children=[];}, addEventListener(){}, setText(v){this.text=v;}, createDiv(o={}){const x=el("div",o);this.children.push(x);return x;}, createSpan(o={}){const x=el("span",o);this.children.push(x);return x;}, createEl(t,o={}){const x=el(t,o);this.children.push(x);return x;} }; return node; }
  const walk = (n, acc = []) => { acc.push(n); n.children.forEach((c) => walk(c, acc)); return acc; };

  const snapshot = { schemaVersion: 2, agents: [
    { slug: "coder", name: "coder", file: ".claude/agents/coder.md", model: "sonnet", status: "set" },
    { slug: "nomodel", name: "nomodel", file: ".claude/agents/nomodel.md", model: null, status: "missing" },
  ], missingModel: ["nomodel"], errors: [] };
  const stats = { windowDays: 35, agents: [{ key: "coder", runs: 5, models: { "claude-sonnet-5": { runs: 4 }, "claude-opus-5": { runs: 1 } } }] };
  const view = computeClaudeAgentModelsView(snapshot, stats);
  const history = computePiModelHistoryView({ schemaVersion: 1, generatedAt: "2026-09-15T10:02:14.953Z", catalog: { providers: [{ id: "openai-codex", models: ["openai-codex/gpt-5.5"] }] }, agents: [{ name: "coder", effective: { model: "openai-codex/gpt-5.6-terra" } }] });

  const host = el(); inventory(host, view, history, "Operations/agent-models-history/2026-09-15-pi.json");
  let nodes = walk(host);
  assert.ok(nodes.some((n) => n.text === "Agent models (Claude)"), "current section is labelled Claude");
  assert.ok(nodes.some((n) => n.cls === "aios-agent-models-error" && n.text.startsWith("No model line in nomodel.") && n.text.includes("Opus (expensive)")), "missing model line is flagged loudly by slug");
  assert.ok(nodes.some((n) => n.cls === "aios-agent-model-configured is-missing" && n.text === "MISSING (inherits Opus)"), "missing row is styled as missing");
  assert.ok(nodes.some((n) => n.cls === "aios-agent-model-configured" && n.text === "sonnet"), "configured model renders from the shim");
  assert.ok(nodes.some((n) => n.cls === "aios-agent-model-used" && n.text === "claude-sonnet-5 ×4, claude-opus-5 ×1"), "used models render with run counts from usage attribution");
  assert.ok(nodes.some((n) => n.text === "Used (last 35 days)"), "used column names the usage window");
  assert.ok(nodes.some((n) => n.tag === "summary" && n.text === "Before 2026-10-12: Pi / OpenAI (history, read-only)"), "history is a labelled read-only section");
  assert.ok(nodes.some((n) => n.text === "openai-codex/gpt-5.6-terra"), "history keeps the Pi/OpenAI model per agent");
  assert.ok(nodes.some((n) => n.text === "openai-codex catalog: openai-codex/gpt-5.5"), "history keeps the Pi catalog");
  for (const tag of ["select", "button", "input"]) assert.ok(!nodes.some((n) => n.tag === tag), `inventory renders no ${tag}: read-only`);

  const noHistory = el(); inventory(noHistory, computeClaudeAgentModelsView(null, stats), computePiModelHistoryView(null), "Operations/agent-models-history/2026-09-15-pi.json"); nodes = walk(noHistory);
  assert.ok(nodes.some((n) => n.text.includes("No Claude agent-models snapshot. Run: node Operations/scripts/export-agent-models.mjs")), "missing snapshot shows the exporter command");
  assert.ok(nodes.some((n) => n.text === "No history snapshot at Operations/agent-models-history/2026-09-15-pi.json."), "missing history names its path");

  const rows = [ { id: "coder", label: "Coder", path: "Agents/Coder/AGENTS.md", description: "Implementer.", wiredTo: { workflows: [], sops: [], skills: [] }, costUsd: null, runs: null, avgCostUsd: null }, { id: "nomodel", label: "No model", description: "Forgot.", wiredTo: { workflows: [], sops: [], skills: [] }, costUsd: null, runs: null, avgCostUsd: null }, { id: "history-only", label: "History", description: "Not a shim.", wiredTo: { workflows: [], sops: [], skills: [] }, costUsd: null, runs: null, avgCostUsd: null } ];
  const rosterHost = el(); roster({ workspace: { openLinkText(){} } }, rosterHost, rows, view); nodes = walk(rosterHost);
  const firstCard = nodes.find((n) => n.cls === "aios-agent-card");
  assert.deepEqual(firstCard.children.slice(0, 3).map((n) => n.cls), ["aios-agent-identity", "aios-agent-model-area", "aios-agent-usage"], "card order unchanged");
  assert.ok(nodes.some((n) => n.text === "Configured: sonnet"), "roster card shows the configured model");
  assert.ok(nodes.some((n) => n.text === "Used (last 35 days): claude-sonnet-5 ×4, claude-opus-5 ×1"), "roster card shows used models");
  assert.ok(nodes.some((n) => n.cls === "aios-agent-model-configured is-missing" && n.text.includes("inherits the main session's Opus")), "roster card flags missing model line");
  assert.ok(nodes.some((n) => n.text === "Used (last 35 days): no runs"), "a shim with no runs says so");
  assert.ok(nodes.some((n) => n.text === "No .claude/agents shim for this agent."), "a roster row without a shim is labelled");
  for (const tag of ["select", "button"]) assert.ok(!nodes.some((n) => n.tag === tag), `roster renders no ${tag}: read-only`);
  console.log("agentModelsDom: all assertions passed");
} finally { fs.rmSync(entry, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
