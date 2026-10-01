import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageChartFromWindow, usagePeriodBreakdown, usagePopupPosition } from './model.mjs';

const bucket = (costUsd, inputTokens, outputTokens = 7) => ({ costUsd, inputTokens, cacheReadTokens: 13, cacheWriteTokens: 17, outputTokens, messages: 1 });
const day = { date: '2026-09-30', models: {
  'openai-codex/gpt-6.1-sol': bucket(9, 100), opus: bucket(3, 2000000),
  'openai-codex/unknown-example': bucket(0, 500), 'ollama/local-example': bucket(0, 300),
}, totalCostUsd: 12, totalOutputTokens: 28 };
const next = { ...day, date: '2026-10-01', models: { sonnet: bucket(6, 200) }, totalCostUsd: 6 };
const unpriced = ['openai-codex/unknown-example'];
for (const view of ['cost', 'tokens']) {
  const chart = usageChartFromWindow([day, next], view);
  assert.equal(chart.days[0].totalTokens, 2001048, 'total includes input, cache read, cache write and output');
  assert.equal(chart.days[0].totalCostUsd, 12);
  assert.equal(chart.days[1].totalFraction, view === 'cost' ? .5 : 237 / 2001048, 'period height uses active total');
  const popup = usagePeriodBreakdown(chart.days[0], view, unpriced);
  assert.equal(popup.label, day.date);
  assert.equal(popup.rows.length, 4, 'every used model is in popup');
  assert.deepEqual(popup.rows.map(r => r.model), view === 'cost'
    ? ['openai-codex/gpt-6.1-sol', 'opus', 'ollama/local-example', 'openai-codex/unknown-example']
    : ['opus', 'openai-codex/unknown-example', 'ollama/local-example', 'openai-codex/gpt-6.1-sol'], 'popup sorts active metric largest first');
  assert.equal(popup.total, view === 'cost' ? '$12.00' : '2.0M tokens');
  assert.equal(popup.rows.find(r => r.model === unpriced[0]).amount, view === 'cost' ? 'Unpriced' : '537 tokens', 'unpriced model is not a zero dollar claim');
  assert.equal(popup.rows.find(r => r.model.startsWith('ollama/')).amount, view === 'cost' ? '$0.00' : '337 tokens', 'local zero cost remains explicit');
  assert.equal(popup.rows.find(r => r.model.startsWith('openai-codex/gpt')).label, 'gpt-6.1-sol', 'concise labels retained');
}
assert.deepEqual(usagePopupPosition({ width: 600, height: 400 }, { width: 220, height: 150 }, 590, 390), { left: 358, top: 250 }, 'popup flips left and clamps bottom');
assert.deepEqual(usagePopupPosition({ width: 200, height: 100 }, { width: 200, height: 100 }, 5, 5), { left: 0, top: 0 }, 'narrow pane stays bounded');

const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-purple-render-'));
const entry = path.join(root, '.usage-purple-entry.ts');
const out = path.join(dir, 'out.mjs');
const stub = path.join(dir, 'obsidian.mjs');
fs.writeFileSync(stub, ['App', 'ItemView', 'Menu', 'Modal', 'Notice', 'Plugin', 'PluginSettingTab', 'Scope', 'Setting', 'TFile', 'TFolder', 'WorkspaceLeaf'].map(n => `export class ${n} {}`).join('\n') + '\nexport const Platform = {isDesktop:false}; export const normalizePath = p => p; export const setIcon = () => {};');
fs.writeFileSync(entry, fs.readFileSync('main.ts', 'utf8') + '\nexport {renderUsageChartHost as chartHost, renderUsageViewSwitch as viewSwitch, renderUsageTab as usageTab};');
function el(tag = 'div', options = {}) {
  const node = { tag, children: [], text: options.text || '', attrs: { ...options.attr, class: options.cls || '' }, events: {}, style: {},
    createDiv(o) { return this.createEl('div', o); }, createSpan(o) { return this.createEl('span', o); },
    createEl(t, o = {}) { const child = el(t, o); this.appendChild(child); return child; },
    appendChild(child) { child.parentElement = this; this.children.push(child); },
    setAttribute(k, v) { this.attrs[k] = v; }, setAttr(k, v) { this.attrs[k] = v; },
    addEventListener(k, v) { this.events[k] = v; }, remove() { this.parentElement.children = this.parentElement.children.filter(c => c !== this); },
    closest() { return pane; }, getBoundingClientRect() {
      if (this.attrs.class === 'aios-usage-popup') return { left: 0, top: 0, width: parseFloat(this.style.width) || 300, height: 150 };
      if (this.attrs.class === 'aios-usage-chart-wrap') return { left: 20, top: 50, width: 600, height: 180 };
      return { left: 0, top: 0, width: 600, height: 400 };
    },
    classList: { add() {} }, empty() { this.children = []; },
    setText(text) { this.text = text; }, addClass() {},
    scrollTop: 0, scrollHeight: 400, clientHeight: 400,
  }; return node;
}
function all(node, pred) { return [...(pred(node) ? [node] : []), ...node.children.flatMap(c => all(c, pred))]; }
const pane = el();
try {
  esbuild.buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm', outfile: out, treeShaking: false,
    external: ['electron', 'child_process', 'node:*', '@codemirror/*', '@lezer/*'], alias: { obsidian: stub } });
  const { chartHost, viewSwitch, usageTab } = await import(pathToFileURL(out).href);
  globalThis.document = { createElementNS(_, tag) { return el(tag); } };
  globalThis.ResizeObserver = class { observe() {} }; 
  for (const range of ['1d', '7d']) for (const view of ['cost', 'tokens']) {
    const host = el();
    const days = range === '1d' ? [day] : [day, next];
    chartHost(host, { label: 'Selected period', days }, { usageRange: range }, view, unpriced);
    const bars = all(host, n => n.tag === 'rect' && n.attrs.class === 'aios-usage-bar');
    assert.equal(bars.length, days.length, `${range} ${view}: one plain purple bar per period`);
    assert.equal(Number(bars[0].attrs.height), 158, `${range} ${view}: column draws the whole period total`);
    assert.ok(all(host, n => n.tag === 'text' && n.textContent === (view === 'cost' ? '$12.00' : '2.0M')).length, `${range} ${view}: y-axis uses active period total`);
    if (days.length > 1) assert.equal(Number(bars[1].attrs.height), (view === 'cost' ? .5 : 237 / 2001048) * 158, `${range} ${view}: each column height uses active period metric`);
    const hits = all(host, n => n.tag === 'rect' && n.attrs.class === 'aios-usage-column-hit');
    assert.equal(hits.length, days.length, 'each column has hover target');
    for (const hit of hits) assert.equal(hit.attrs.height, '158', 'hover target is full plot height even below maximum');
    assert.equal(hits[0].attrs.y, '6', 'hover target begins at top of plot');
    hits[0].events.mouseenter({ clientX: 590, clientY: 390 });
    const popup = all(host, n => n.attrs.class === 'aios-usage-popup')[0];
    assert.ok(popup, `${range} ${view}: hovering column creates breakdown popup`);
    const text = all(popup, n => n.text).map(n => n.text);
    assert.deepEqual(text, view === 'cost'
      ? ['2026-09-30', '$12.00', 'gpt-6.1-sol', '$9.00', 'Opus', '$3.00', 'ollama/local-example', '$0.00', 'unknown-example', 'Unpriced']
      : ['2026-09-30', '2.0M tokens', 'Opus', '2.0M tokens', 'unknown-example', '537 tokens', 'ollama/local-example', '337 tokens', 'gpt-6.1-sol', '137 tokens'], `${range} ${view}: popup renders period total and every model in metric order`);
    assert.equal(popup.style.left, '258px', 'popup flips left inside pane accounting for wrap offset');
    assert.equal(popup.style.top, '200px', 'popup clamps to pane bottom accounting for wrap offset');
    popup.scrollHeight = 900; popup.clientHeight = 150;
    let prevented = false;
    hits[0].events.wheel({ deltaY: 200, preventDefault() { prevented = true; } });
    assert.equal(popup.scrollTop, 200, 'long popup scrolls while column is hovered');
    assert.ok(prevented, 'scrolling long popup does not move dashboard');
    hits[0].events.mouseleave();
    assert.equal(all(host, n => n.attrs.class === 'aios-usage-popup').length, 0, 'popup disappears on mouse leave');
    if (days.length > 1) {
      hits[1].events.mouseenter({ clientX: 100, clientY: 20 });
      assert.ok(all(host, n => n.text === '2026-10-01').length, 'second column popup uses its own period');
      assert.equal(all(host, n => n.text === 'Opus').length, 0, 'popup never leaks other period models');
      hits[1].events.mouseleave();
    }
  }
  const legacy = { usageView: 'cost', usageModelColors: { opus: 9, invalid: -1 } };
  const host = el(); let saved; let redraws = 0;
  viewSwitch(host, legacy, async () => { saved = { ...legacy }; }, () => redraws++);
  all(host, n => n.tag === 'button' && n.text === 'Tokens')[0].events.click();
  assert.equal(saved.usageView, 'tokens'); assert.equal(redraws, 1, 'old color settings do not prevent saved metric switch');
  const tabHost = el();
  const stats = { generatedAt: new Date().toISOString(), days: [day, next], projects: [], windowDays: 35, totals: {}, unpricedOpenAiModels: unpriced };
  const statsPath = 'synthetic/usage-stats.json';
  const app = { vault: { adapter: { exists: async p => p === statsPath, read: async () => JSON.stringify(stats) } } };
  usageTab(app, tabHost, el(), { ...legacy, usageStatsPath: statsPath, dailyBudgetUsd: 0 }, { usageRange: 'all', usageOffset: 0, expanded: new Set() }, () => {}, async () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(all(tabHost, n => n.tag === 'svg').length, 'actual usage tab renders chart with legacy settings');
  assert.equal(all(tabHost, n => n.tag === 'table').length, 0, 'actual usage tab renders no models table below chart');
  assert.equal(all(tabHost, n => /aios-usage-legend/.test(n.attrs.class)).length, 0, 'actual usage tab renders no per-model legend');
  assert.equal(all(tabHost, n => n.attrs.class === 'aios-usage-tiles').length, 1, 'summary tiles stay above chart');
  const tabHit = all(tabHost, n => n.attrs.class === 'aios-usage-column-hit')[0];
  tabHit.events.mouseenter({ clientX: 100, clientY: 10 });
  assert.ok(all(tabHost, n => n.text === 'unknown-example').length, 'tab forwards period models to hover');
  assert.ok(all(tabHost, n => n.text === '537 tokens').length, 'tab forwards selected token view to hover');
  tabHit.events.mouseleave();
  const source = fs.readFileSync('main.ts', 'utf8');
  assert.doesNotMatch(source, /renderUsageLegend|renderUsageModelsTable|usageModelColors|computeUsageColorPlan|usagePaletteStyles/, 'usage section has no per-model legend/table or color machinery');
  assert.match(source, /renderUsageWorkflowsSection\(body/); assert.match(source, /renderUsageSkillsSection\(body/);
  const css = fs.readFileSync('styles.css', 'utf8');
  assert.match(css, /\.aios-usage-bar\s*\{\s*fill:\s*#9060d0;/, 'all columns use the single usage purple');
  console.log('usagePurpleChart.test.mjs: PASS (totals, purple columns, no model list, popup, unpriced, legacy settings)');
} finally { fs.rmSync(entry, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
