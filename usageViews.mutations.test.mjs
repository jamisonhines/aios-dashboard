// Executable GL-009 proofs against isolated copies of committed sources.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const root = process.cwd();
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-simplify-proofs-'));
const dir = path.join(sandbox, 'Projects/dashboard');
const exporter = 'vault-scripts/export-usage-stats.mjs';
const req = [
  'REQ: a bb thread transcript named pi_<id>.jsonl at the bb root is counted.',
  'REQ: thr_<id>.jsonl thread transcripts are still counted.',
  'REQ: every chart column is drawn in the single usage purple in both the Cost and Tokens views.',
  'REQ: the usage section renders no per-model legend or models table below the chart.',
  "REQ: hovering a column shows that period's per-model breakdown in the active view's unit, largest first.",
  'REQ: an unpriced model shows Unpriced in the Cost view breakdown.',
];
const cases = [
  { requirement: req[0], file: exporter, from: '/^(?:thr|pi)_.+\\.jsonl$/', to: '/^thr_.+\\.jsonl$/', test: 'usageBbThreads.test.mjs', description: 'reject pi root transcript' },
  { requirement: req[1], file: exporter, from: '/^(?:thr|pi)_.+\\.jsonl$/', to: '/^pi_.+\\.jsonl$/', test: 'usageBbThreads.test.mjs', description: 'reject legacy thr root transcript' },
  { requirement: req[2], file: 'styles.css', from: 'fill: #9060d0;', to: 'fill: #ff0000;', description: 'single usage purple -> red' },
  { requirement: req[2], file: 'main.ts', from: 'class: "aios-usage-bar",', to: 'class: "aios-usage-bar-red",', description: 'column uses non-purple class' },
  { requirement: req[3], file: 'main.ts', from: 'renderUsageChartHost(body, win, viewState, settings.usageView, stats.unpricedOpenAiModels || []);', to: 'renderUsageChartHost(body, win, viewState, settings.usageView, stats.unpricedOpenAiModels || []); body.createEl("table", {text:"Models"});', description: 'restore model table below chart' },
  { requirement: req[3], file: 'main.ts', from: 'renderUsageChartHost(body, win, viewState, settings.usageView, stats.unpricedOpenAiModels || []);', to: 'renderUsageChartHost(body, win, viewState, settings.usageView, stats.unpricedOpenAiModels || []); body.createDiv({cls:"aios-usage-legend",text:"Opus"});', description: 'restore per-model legend below chart' },
  { requirement: req[4], file: 'main.ts', from: 'hit.addEventListener("mouseenter", show);', to: 'hit.addEventListener("mouseenter", hide);', description: 'hover no longer shows popup' },
  { requirement: req[4], file: 'model.mjs', from: 'b.value - a.value || a.label.localeCompare(b.label)', to: 'a.value - b.value || a.label.localeCompare(b.label)', description: 'sort popup ascending instead of largest first' },
  { requirement: req[4], file: 'main.ts', from: 'usageChartFromWindow(win.days, view)', to: 'usageChartFromWindow(win.days, "cost")', description: 'chart host ignores active token unit' },
  { requirement: req[4], file: 'main.ts', from: 'usagePeriodBreakdown(day, view, unpriced)', to: 'usagePeriodBreakdown(chart.days[chart.days.length - 1], view, unpriced)', description: 'hover shows wrong period' },
  { requirement: req[5], file: 'model.mjs', from: 'view === "cost" && unpriced.includes(bucket.model) ? "Unpriced"', to: 'false ? "Unpriced"', description: 'unpriced cost becomes zero dollar claim' },
  { requirement: req[5], file: 'main.ts', from: 'view, unpriced\n  );', to: 'view, []\n  );', description: 'chart host loses unpriced model metadata' },
  { requirement: req[4], file: 'main.ts', from: 'height: String(plotHeight), class: "aios-usage-column-hit",', to: 'height: String(barHeight), class: "aios-usage-column-hit",', description: 'hit target only drawn bar height' },
  { requirement: req[4], file: 'main.ts', from: 'hit.addEventListener("mouseleave", hide);', to: 'hit.addEventListener("mouseleave", () => {});', description: 'popup remains after mouse leave' },
  { requirement: req[4], file: 'model.mjs', from: 'if (left + popup.width > pane.width) left = x - popup.width - gap;', to: 'if (false) left = x - popup.width - gap;', description: 'edge popup does not flip' },
  { requirement: req[2], file: 'main.ts', from: 'const barHeight = Math.max(0, day.totalFraction * plotHeight);', to: 'const barHeight = Math.max(0, (day.segments[0]?.heightFraction || 0) * plotHeight);', description: 'column draws first model instead of period total' },
  { requirement: req[2], file: 'model.mjs', from: '(bucket.inputTokens || 0) + (bucket.cacheReadTokens || 0) + (bucket.cacheWriteTokens || 0) + (bucket.outputTokens || 0)', to: '(bucket.inputTokens || 0) + (bucket.outputTokens || 0)', description: 'token totals omit both cache buckets' },
];
// Retain prior backend value/identifier/guard proofs; palette and removed
// model-table mutations are deliberately retired with those features.
const legacy = [
  ...['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'].map((model, i) => ({ from: ['"gpt-6-sol": { input: 2,', '"gpt-6.1-sol": { input: 2,', '"gpt-6-luna": { input: 0.1,'][i], to: `"${model}": { input: 0,`, description: `${model} base input rate -> 0` })),
  { from: 'if (!openAiRate) return 0;', to: 'if (!openAiRate) return 1;', description: 'unknown OpenAI guessed charge' },
  { from: 'isOpenAiModel(model) && !openAiApiEquivalentRate(model)', to: 'isOpenAiModel(model) && false', description: 'drop unpriced diagnostics' },
  { from: 'input_tokens: last.input_tokens - last.cached_input_tokens,', to: 'input_tokens: last.input_tokens,', description: 'cached input double counted' },
  { from: 'const last = info?.last_token_usage;', to: 'const last = info?.total_token_usage;', description: 'count cumulative instead of per-turn' },
  { from: 'if (codexTotalsSeen.has(codexIdentity)) continue;', to: 'if (false) continue;', description: 'count repeated cumulative refresh' },
  { from: 'if (isLocalModel(model)) return 0;', to: 'if (false) return 0;', description: 'charge local usage' },
  { from: 'bucket.inputTokens += e.input_tokens;', to: 'bucket.inputTokens += isLocalModel(e.model) ? 0 : e.input_tokens;', description: 'drop local tokens' },
  { from: 'usageTestEnv("USAGE_EXPORT_TEST_CODEX_ROOT")', to: 'usageTestEnv("USAGE_EXPORT_TEST_WRONG_CODEX_ROOT")', description: 'Codex env identifier -> wrong root' },
  { from: 'if ((await fs.stat(filePath)).mtimeMs < cutoffMs) continue;', to: 'if (false) continue;', description: 'disable Codex mtime cutoff' },
  { edits: [
    { file: exporter, from: 'entry.isFile() && entry.name.endsWith(".jsonl")', to: '(entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".jsonl")' },
    { file: exporter, from: 'if (!(await isCanonicalRegularFileWithin(filePath, root))) continue;', to: 'if (false) continue;' },
  ], description: 'accept Codex symlink with traversal co-guard disabled' },
].map(c => ({ ...c, file: exporter, test: 'usageViews.test.mjs' }));
const results = [];
try {
  const libs = path.join(sandbox, 'AIOS/Operations/scripts/lib');
  await fs.mkdir(libs, { recursive: true });
  for (const name of ['coordination-parse.mjs', 'coordination-accounting.mjs']) await fs.copyFile(path.resolve(root, '../../AIOS/Operations/scripts/lib', name), path.join(libs, name));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  await fs.symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const mutation of [...cases, ...legacy]) {
    const originals = new Map();
    try {
      for (const edit of mutation.edits || [mutation]) {
        const file = path.join(dir, edit.file);
        const original = await fs.readFile(file, 'utf8');
        if (!originals.has(file)) originals.set(file, original);
        assert.equal(original.split(edit.from).length, 2, `unique executable mutation: ${mutation.description}`);
        await fs.writeFile(file, original.replace(edit.from, edit.to));
      }
      const test = mutation.test || 'usagePurpleChart.test.mjs';
      const run = spawnSync(process.execPath, [test], { cwd: dir, encoding: 'utf8', timeout: 120000 });
      const output = `${run.stdout || ''}${run.stderr || ''}`;
      assert.notEqual(run.status, 0, `survived mutation: ${mutation.description}`);
      const failure = output.match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/)?.[1];
      assert.ok(failure, `must fail by assertion, not infrastructure: ${output}`);
      const result = { requirement: mutation.requirement, mutation: mutation.description, failLine: `${test}: AssertionError [ERR_ASSERTION]: ${failure}`, output };
      results.push(result);
      console.log(`KILLED: ${mutation.description}\nFAIL: ${result.failLine}`);
    } finally { for (const [file, original] of originals) await fs.writeFile(file, original); }
  }
  for (const test of ['usageBbThreads.test.mjs', 'usagePurpleChart.test.mjs', 'usageViews.test.mjs']) {
    const run = spawnSync(process.execPath, [test], { cwd: dir, encoding: 'utf8', timeout: 120000 });
    assert.equal(run.status, 0, `restored green: ${run.stdout}${run.stderr}`);
    console.log(`RESTORED GREEN: ${test}`);
  }
  if (process.env.USAGE_PROOF_RESULTS) await fs.writeFile(process.env.USAGE_PROOF_RESULTS, JSON.stringify(results, null, 2));
  console.log(`usageViews.mutations: ${results.length}/${cases.length + legacy.length} killed; restored suites green`);
} finally { await fs.rm(sandbox, { recursive: true, force: true }); }
