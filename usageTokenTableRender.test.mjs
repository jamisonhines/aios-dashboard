import './testFileTimeout.mjs';
// Usage model-table contracts were replaced by usagePurpleChart.test.mjs.
// Retain the independent System Skills six-column rendering contract.
import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-skills-render-'));
const entry = path.join(root, '.system-skills-entry.ts');
const stub = path.join(dir, 'obsidian.mjs');
const out = path.join(dir, 'out.mjs');
fs.writeFileSync(stub, ['App', 'ItemView', 'Menu', 'Modal', 'Notice', 'Plugin', 'PluginSettingTab', 'Scope', 'Setting', 'TFile', 'TFolder', 'WorkspaceLeaf'].map(n => `export class ${n} {}`).join('\n') + '\nexport const Platform = {isDesktop:false}; export const normalizePath = p => p; export const setIcon = () => {};');
fs.writeFileSync(entry, fs.readFileSync('main.ts', 'utf8') + '\nexport {renderSystemSkillsTable as systemSkills};');
function el(tag = 'div', o = {}) {
  return { tag, children: [], text: o.text || '', attrs: o.attr || {}, events: {},
    createDiv(o) { return this.createEl('div', o); }, createSpan(o) { return this.createEl('span', o); },
    createEl(tag, o) { const child = el(tag, o); this.children.push(child); return child; },
    setAttr(k,v) { this.attrs[k] = v; }, addEventListener(k,v) { this.events[k] = v; },
  };
}
function find(node, pred) { if (pred(node)) return node; return node.children.map(c => find(c, pred)).find(Boolean); }
try {
  esbuild.buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm', outfile: out, treeShaking: false,
    external: ['electron', 'child_process', 'node:*', '@codemirror/*', '@lezer/*'], alias: { obsidian: stub } });
  const { systemSkills } = await import(pathToFileURL(out).href);
  const host = el();
  systemSkills({ workspace: { openLinkText() {} } }, host, [{ id: 'skill', origin: 'skills-dir', disableModelInvocation: false, costUsd: 1, runs: 2, description: 'Desc', usedBy: [], avgCostUsd: .5 }]);
  const table = find(host, n => n.tag === 'table');
  assert.deepEqual(table.children[0].children[0].children.map(n => n.text), ['Skill', 'Cost', 'Runs', 'Description', 'Used by', 'Avg/run'], 'System Skills emits deliberate six-column shape');
  assert.equal(table.children[1].children[0].children.length, 6, 'System Skills rows match six headers');
  const css = fs.readFileSync('styles.css', 'utf8');
  const section = css.slice(css.indexOf('.aios-dashboard-root .aios-usage-breakdown-table.aios-system-skills-table th:first-child'), css.indexOf('.aios-dashboard-root .aios-system-skills-desc'));
  assert.match(section, /first-child[\s\S]{0,180}?width:\s*32%/, 'System Skills first column 32%');
  assert.match(section, /nth-child\(2\),[\s\S]*?nth-child\(3\)[\s\S]{0,100}?width:\s*15%/, 'Cost and Runs 15%');
  assert.match(section, /nth-child\(4\)[\s\S]{0,180}?width:\s*20%/, 'Description 20%');
  assert.match(section, /nth-child\(5\)[\s\S]{0,180}?width:\s*10%/, 'Used by 10%');
  assert.match(section, /nth-child\(6\)[\s\S]{0,180}?width:\s*8%/, 'Avg/run 8%');
  assert.equal(32 + 15 + 15 + 20 + 10 + 8, 100, 'closed width map');
  assert.match(css, /does not claim cross-table Cost alignment/);
  console.log('usageTokenTableRender.test.mjs: all assertions passed (System Skills)');
} finally { fs.rmSync(entry, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
