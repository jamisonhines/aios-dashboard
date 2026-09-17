// Behavioral render contract for token transparency and System Skills widths.
// Bundles the shipped main.ts with test-only exports; no renderer is copied.
import assert from "node:assert";
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-token-render-"));
const stub = path.join(dir, "obsidian.mjs");
const entry = path.join(root, ".usage-token-render-entry.ts");
const out = path.join(dir, "out.mjs");

fs.writeFileSync(stub, [
  "export class App {}", "export class ItemView {}", "export class Menu {}", "export class Modal {}", "export class Notice {}",
  "export const Platform = { isDesktop: false };", "export class Plugin {}", "export class PluginSettingTab {}", "export class Scope {}",
  "export class Setting {}", "export class TFile {}", "export class TFolder {}", "export class WorkspaceLeaf {}",
  "export const normalizePath = (p) => p;", "export const setIcon = () => {};",
].join("\n"));
fs.writeFileSync(entry, fs.readFileSync(path.join(root, "main.ts"), "utf8") + "\nexport { renderUsageModelsTable as models, renderSystemSkillsTable as systemSkills };\n");

function el(tag = "div", options = {}) {
  const node = {
    tag, children: [], text: options.text ?? "", cls: options.cls ?? "", attrs: options.attr ?? {},
    createDiv(o = {}) { const child = el("div", o); this.children.push(child); return child; },
    createSpan(o = {}) { const child = el("span", o); this.children.push(child); return child; },
    createEl(name, o = {}) { const child = el(name, o); this.children.push(child); return child; },
    addEventListener() {}, hide() {}, show() {}, isShown() { return false; },
  };
  return node;
}
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) { const match = find(child, predicate); if (match) return match; }
  return undefined;
}

try {
  esbuild.buildSync({
    absWorkingDir: root, entryPoints: [path.basename(entry)], bundle: true, format: "esm", outfile: out, treeShaking: false,
    external: ["electron", "child_process", "node:crypto", "node:fs", "node:path", "@codemirror/*", "@lezer/*"], alias: { obsidian: stub },
  });
  const { models, systemSkills } = await import(pathToFileURL(out).href);

  // Distinct values prove the cells are wired by field, not merely populated.
  const modelsHost = el();
  models(modelsHost, [{ label: "Opus", family: "opus", inputTokens: 101, cacheReadTokens: 202, cacheWriteTokens: 0, outputTokens: 404, costUsd: 5.5, sharePercent: 42, messages: 7 }]);
  const modelsTable = find(modelsHost, (node) => node.tag === "table");
  const modelsHeader = modelsTable.children[0].children[0].children.map((node) => node.text);
  const modelsCells = modelsTable.children[1].children[0].children;
  assert.deepEqual(modelsHeader, ["Model", "Input", "Cache read", "Cache write", "Output", "Cost", "Share", "Msgs", ""], "Models headers pad to nine shared positions");
  assert.equal(modelsCells.length, 9, "Models row pads to nine shared positions");
  assert.deepEqual(
    modelsCells.slice(1).map((node) => node.text),
    ["101", "202", "0", "404", "$5.50", "42%", "7", ""],
    "Models cells map Input, Cache read, Cache write, Output, Cost, Share, and Msgs in that exact order; zero cache write is 0"
  );

  // System Skills intentionally remains a six-column table; it gets its own
  // closed six-column CSS map rather than pretending its Cost column aligns
  // with the nine-column Models table.
  const systemHost = el();
  systemSkills({ workspace: { openLinkText() {} } }, systemHost, [{ id: "skill", origin: "skills-dir", disableModelInvocation: false, costUsd: 1, runs: 2, description: "Desc", usedBy: [], avgCostUsd: 0.5 }]);
  const systemTable = find(systemHost, (node) => node.tag === "table");
  assert.deepEqual(systemTable.children[0].children[0].children.map((node) => node.text), ["Skill", "Cost", "Runs", "Description", "Used by", "Avg/run"], "System Skills emits its deliberate six-column shape");
  assert.equal(systemTable.children[1].children[0].children.length, 6, "System Skills rows emit six cells matching their six headers");

  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const systemCss = css.slice(css.indexOf(".aios-dashboard-root .aios-usage-breakdown-table.aios-system-skills-table th:first-child"), css.indexOf(".aios-dashboard-root .aios-system-skills-desc"));
  assert.match(systemCss, /first-child[\s\S]{0,180}?width:\s*32%/, "System Skills first column is explicitly 32%");
  assert.match(systemCss, /nth-child\(2\),[\s\S]*?nth-child\(3\)[\s\S]{0,100}?width:\s*15%/, "System Skills Cost and Runs each use 15%");
  assert.match(systemCss, /nth-child\(4\)[\s\S]{0,180}?width:\s*20%/, "System Skills Description is explicitly 20%");
  assert.match(systemCss, /nth-child\(5\)[\s\S]{0,180}?width:\s*10%/, "System Skills Used by is explicitly 10%");
  assert.match(systemCss, /nth-child\(6\)[\s\S]{0,180}?width:\s*8%/, "System Skills Avg/run is explicitly 8%");
  assert.equal(32 + 15 + 15 + 20 + 10 + 8, 100, "System Skills' six emitted columns have a closed 100% width map");
  assert.match(css, /does not claim cross-table Cost alignment/, "CSS documents that the six-column System table does not claim false shared alignment");

  console.log("usageTokenTableRender.test.mjs: all assertions passed");
} finally {
  fs.rmSync(entry, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
