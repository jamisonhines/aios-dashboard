// Coder's executable GL-009 proofs. Mutates isolated copies of committed
// production sources and runs the shipped tests, never a live exporter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-view-proofs-'));
const dir = path.join(sandbox, 'Projects', 'dashboard');
const exporter = 'vault-scripts/export-usage-stats.mjs';
const req = [
  'REQ: gpt-6-sol, gpt-6.1-sol and gpt-6-luna usage is priced from the v2 rate card, not $0.',
  'REQ: an OpenAI model missing from the rate card is still reported as unpriced, never charged a guessed rate.',
  'REQ: Codex session token usage is counted per turn under its model, with cached input counted as cache read and not again as input.',
  "REQ: a Codex session's cumulative token total is not added on top of its per-turn usage.",
  "REQ: a local ollama model's usage costs $0 and still counts its tokens.",
  'REQ: the Tokens view charts and tables total tokens per model, and the Cost view charts and tables API-equivalent dollars.',
  'REQ: the selected usage view persists across a re-render.',
  'REQ: two different models never share a colour, including two models of the same Claude family.',
  "REQ: a model with no explicit colour gets its own provider's next fallback colour, not the shared Other grey.",
  'REQ: two models that appear on the same day are separated by normal-vision Delta E of at least 15.',
  'REQ: models with the largest recent 7-day share keep individual colours before older models.',
  'REQ: all local models share one Local chart colour and stay listed by name in the table.',
];
const cases = [
  ...['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'].map((model, i) => ({ requirement: req[0], description: `${model} base input rate -> 0`, file: exporter, from: [
    '"gpt-6-sol": { input: 2,', '"gpt-6.1-sol": { input: 2,', '"gpt-6-luna": { input: 0.1,',
  ][i], to: `"${model}": { input: 0,` })),
  { requirement: req[1], description: 'unknown OpenAI zero charge -> guessed charge 1', file: exporter, from: 'if (!openAiRate) return 0;', to: 'if (!openAiRate) return 1;' },
  { requirement: req[1], description: 'remove unpriced model reporting', file: exporter, from: 'isOpenAiModel(model) && !openAiApiEquivalentRate(model)', to: 'isOpenAiModel(model) && false' },
  { requirement: req[2], description: 'count cached input again as uncached input', file: exporter, from: 'input_tokens: last.input_tokens - last.cached_input_tokens,', to: 'input_tokens: last.input_tokens,' },
  { requirement: req[3], description: 'use cumulative total as last-turn usage', file: exporter, from: 'const last = info?.last_token_usage;', to: 'const last = info?.total_token_usage;' },
  { requirement: req[3], description: 'count a repeated cumulative refresh as a second turn', file: exporter, from: 'if (codexTotalsSeen.has(identity)) continue;', to: 'if (false) continue;' },
  { requirement: req[4], description: 'remove local zero-cost branch', file: exporter, from: 'if (isLocalModel(model)) return 0;', to: 'if (false) return 0;' },
  { requirement: req[4], description: 'drop local input tokens in aggregation', file: exporter, from: 'bucket.inputTokens += e.input_tokens;', to: 'bucket.inputTokens += isLocalModel(e.model) ? 0 : e.input_tokens;' },
  { requirement: req[5], description: 'Tokens metric -> dollar cost', file: 'model.mjs', from: 'return view === "tokens" ? usageTotalTokens(bucket) : bucket.costUsd;', to: 'return bucket.costUsd;' },
  { requirement: req[5], description: 'Tokens table total -> unpriced dollar cell', file: 'main.ts', from: 'view === "tokens" ? formatCompactNumber(usageTotalTokens(row)) : unpriced.includes(row.model)', to: 'false ? formatCompactNumber(usageTotalTokens(row)) : unpriced.includes(row.model)', test: 'usageTokenTableRender.test.mjs' },
  { requirement: req[5], description: 'both chart hosts ignore selected Tokens mode', edits: [
    { file: 'main.ts', from: 'usageDayFamilyBars(win.days[0], view, colorPlan)', to: 'usageDayFamilyBars(win.days[0], "cost", colorPlan)' },
    { file: 'main.ts', from: 'usageChartFromWindow(win.days, view, colorPlan)', to: 'usageChartFromWindow(win.days, "cost", colorPlan)' },
  ], test: 'usageTokenTableRender.test.mjs' },
  { requirement: req[6], description: 'reset saved usage choice to cost on every render', file: 'main.ts', from: 'const controls = container.createDiv({ cls: "aios-usage-range aios-usage-view-switch" });', to: 'settings.usageView = "cost"; const controls = container.createDiv({ cls: "aios-usage-range aios-usage-view-switch" });', test: 'usageTokenTableRender.test.mjs' },
  { requirement: req[7], description: 'Opus 5.5 slot 2 -> Opus 5 slot 1', file: 'usagePalettes.mjs', from: "'claude-opus-5-5': { provider:'claude', slot:2 }", to: "'claude-opus-5-5': { provider:'claude', slot:1 }" },
  { requirement: req[7], description: 'distinct model slot shares another slot hex', file: 'usagePalettes.mjs', from: "'#6d3a71'", to: "'#d1b200'", test: 'usageModel.test.mjs' },
  { requirement: req[8], description: 'fallback identity -> shared Other grey', file: 'model.mjs', from: 'return `${provider}-${slot}`;', to: 'if (!Object.hasOwn(USAGE_EXPLICIT_MODEL_SLOTS, key)) return "other"; return `${provider}-${slot}`;' },
  { requirement: req[2], kind: 'identifier', description: 'USAGE_EXPORT_TEST_CODEX_ROOT -> USAGE_EXPORT_TEST_WRONG_CODEX_ROOT', file: exporter, from: 'usageTestEnv("USAGE_EXPORT_TEST_CODEX_ROOT")', to: 'usageTestEnv("USAGE_EXPORT_TEST_WRONG_CODEX_ROOT")' },
  { requirement: req[2], kind: 'guard', description: 'disable Codex mtime cutoff', file: exporter, from: 'if ((await fs.stat(filePath)).mtimeMs < cutoffMs) continue;', to: 'if (false) continue;' },
  { requirement: req[2], kind: 'guard', description: 'accept escaped Codex symlink with traversal gate disabled', coGuards: 'walkJsonlFiles regular-file-only traversal; canonical regular-file/symlink rejection; realpath containment', disabledTogether: 'walkJsonlFiles regular-file-only traversal; canonical regular-file/symlink rejection; realpath containment', edits: [
    { file: exporter, from: 'entry.isFile() && entry.name.endsWith(".jsonl")', to: '(entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".jsonl")' },
    { file: exporter, from: 'if (!(await isCanonicalRegularFileWithin(filePath, root))) continue;', to: 'if (false) continue;' },
  ] },
];
cases.push(
  { requirement:req[9], description:'light co-occurring Opus step -> Sonnet step', file:'usagePalettes.mjs', from:"'#e300b4'", to:"'#d1b200'", test:'usagePalettePairs.test.mjs' },
  { requirement:req[9], description:'dark co-occurring Opus step -> Sonnet step', file:'usagePalettes.mjs', from:"'#a05600'", to:"'#b29200'", test:'usagePalettePairs.test.mjs' },
  { requirement:req[9], kind:'guard', description:'disable tail folding with capacity rejection disabled', coGuards:'colour-plan over-capacity rejection', disabledTogether:'colour-plan over-capacity rejection', edits:[
    {file:'model.mjs',from:'const keepCount = ranked.length > capacity ? capacity - 1 : ranked.length;',to:'const keepCount = ranked.length;'},
    {file:'model.mjs',from:'if (slot < 0) throw new Error(`Usage ${provider} colour plan over capacity`);',to:'if (slot < 0) slot = capacity - 1;'},
  ],test:'usagePalettePairs.test.mjs'},
  { requirement:req[9], description:'rank and fold from selected last day instead of entire export', file:'model.mjs', from:'rankUsageModels(fullDays, usageModelProvider, usageTotalTokens)', to:'rankUsageModels(fullDays.slice(-1), usageModelProvider, usageTotalTokens)' , test:'usagePalettePairs.test.mjs' },
  { requirement:req[9], description:'both chart hosts drop whole-export folding plan', edits:[
    {file:'main.ts',from:'usageDayFamilyBars(win.days[0], view, colorPlan)',to:'usageDayFamilyBars(win.days[0], view)'},
    {file:'main.ts',from:'usageChartFromWindow(win.days, view, colorPlan)',to:'usageChartFromWindow(win.days, view)'},
  ],test:'usageTokenTableRender.test.mjs'},
  { requirement:req[5], description:'drop named folded models from model table', file:'model.mjs',from:'return { legend, table };',to:'return { legend, table: table.filter(row => !row.foldedInto) };',test:'usagePalettePairs.test.mjs' },
  { requirement:req[7], description:'ignore fixed model bindings and allocate by current table order', file:'model.mjs',from:'kept.filter(key => Object.hasOwn(USAGE_EXPLICIT_MODEL_SLOTS, key))',to:'kept.filter(() => false)',test:'usagePalettePairs.test.mjs' },
);
cases.push(
  {requirement:req[9],description:'multi-day chart alone drops whole-export folding plan',file:'main.ts',from:'usageChartFromWindow(win.days, view, colorPlan)',to:'usageChartFromWindow(win.days, view)',test:'usageTokenTableRender.test.mjs'},
  {requirement:req[5],description:'folded chart drops cache-read token bucket',file:'model.mjs',from:'const acc = models[key] ||= usageEmptyBucket();\n      for (const field of Object.keys(acc)) acc[field] += bucket[field] || 0;',to:'const acc = models[key] ||= usageEmptyBucket();\n      for (const field of Object.keys(acc)) if (field !== "cacheReadTokens") acc[field] += bucket[field] || 0;',test:'usagePalettePairs.test.mjs'},
  {requirement:req[5],description:'folded chart drops API-equivalent cost',file:'model.mjs',from:'const acc = models[key] ||= usageEmptyBucket();\n      for (const field of Object.keys(acc)) acc[field] += bucket[field] || 0;',to:'const acc = models[key] ||= usageEmptyBucket();\n      for (const field of Object.keys(acc)) if (field !== "costUsd") acc[field] += bucket[field] || 0;',test:'usagePalettePairs.test.mjs'},
);
cases.push(
  {requirement:req[10],description:'rank by whole-window share before recent share',file:'usageRanking.mjs',from:'b.recentShare-a.recentShare || b.wholeShare-a.wholeShare',to:'b.wholeShare-a.wholeShare || b.recentShare-a.recentShare',test:'usageRecentPalette.test.mjs'},
  {requirement:req[10],description:'recent seven dates -> eight dates',file:'usageRanking.mjs',from:'-6*86400000',to:'-7*86400000',test:'usageRecentPalette.test.mjs'},
  {requirement:req[10],description:'anchor recent window to oldest export day',file:'usageRanking.mjs',from:'dates.at(-1)',to:'dates[0]',test:'usageRecentPalette.test.mjs'},
  {requirement:req[10],description:'remove whole-window share tie-break',file:'usageRanking.mjs',from:'|| b.wholeShare-a.wholeShare',to:'|| 0',test:'usageRecentPalette.test.mjs'},
  {requirement:req[10],description:'reverse model-key tie-break',file:'usageRanking.mjs',from:'a.model.localeCompare(b.model)',to:'b.model.localeCompare(a.model)',test:'usageRecentPalette.test.mjs'},
  {requirement:req[11],description:'disable dedicated Local group branch',file:'model.mjs',from:"if (provider === 'local') {",to:'if (false) {',test:'usageRecentPalette.test.mjs'},
  {requirement:req[11],description:'split Local into individual chart groups',file:'model.mjs',from:"groups[group] = {label:'Local',members};",to:'for (const model of members) groups[model] = {label:usageModelLabel(model),members:[model]};',test:'usageRecentPalette.test.mjs'},
  {requirement:req[11],description:'drop local names from the models table',file:'model.mjs',from:'return { legend, table };',to:"return { legend, table: table.filter(row => usageModelProvider(row.model) !== 'local') };",test:'usageRecentPalette.test.mjs'},
  {requirement:'each provider owns a hue range (Claude warm: yellow, amber, orange, red, rose; OpenAI cool: green, aqua, teal, blue, indigo; local: violet/grey).',kind:'guard',description:'let Local candidates overlap Claude with fixed grid guard disabled',coGuards:'fixed Local candidate hue grid',disabledTogether:'fixed Local candidate hue grid',edits:[
    {file:'dev/search-usage-palettes.mjs',from:'(h>=290&&h<310)',to:'(h>=290&&h<340)'},
    {file:'dev/search-usage-palettes.mjs',from:'local: [290,295,300,305]',to:'local: [290,295,300,305,335]'},
  ],test:'usageRecentPalette.test.mjs'},
);
const results = [];
try {
  const libs = path.join(sandbox, 'AIOS', 'Operations', 'scripts', 'lib');
  await fs.mkdir(libs, { recursive: true });
  for (const name of ['coordination-parse.mjs', 'coordination-accounting.mjs']) {
    await fs.copyFile(path.resolve(root, '../../AIOS/Operations/scripts/lib', name), path.join(libs, name));
  }
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  await fs.symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const mutation of cases) {
    const edits = mutation.edits || [mutation];
    const originals = new Map();
    try {
      for (const edit of edits) {
        const file = path.join(dir, edit.file);
        const original = await fs.readFile(file, 'utf8');
        if (!originals.has(file)) originals.set(file, original);
        assert.equal(original.split(edit.from).length, 2, `mutation must match exactly once: ${mutation.description}`);
        await fs.writeFile(file, original.replace(edit.from, edit.to));
      }
      const test = mutation.test || 'usageViews.test.mjs';
      const run = spawnSync(process.execPath, [test], { cwd: dir, encoding: 'utf8', timeout: 120000 });
      const output = `${run.stdout || ''}${run.stderr || ''}`;
      assert.notEqual(run.status, 0, `survived mutation: ${mutation.description}`);
      const failure = output.match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/)?.[1];
      assert.ok(failure, `must fail by assertion, not infrastructure: ${output}`);
      const stack = output.match(/at file:\/\/[^\n]+/g)?.find(line => line.includes(test));
      const result = { kind: mutation.kind || 'value', requirement: mutation.requirement, mutation: mutation.description, coGuards: mutation.coGuards || 'none', disabledTogether: mutation.disabledTogether || 'n/a', failLine: `${test}: AssertionError [ERR_ASSERTION]: ${failure}`, stack: stack?.replaceAll(dir, '<proof-copy>'), output };
      results.push(result);
      console.log(`KILLED: ${mutation.description}\nFAIL: ${result.failLine}\n${result.stack || ''}`);
    } finally {
      for (const [file, original] of originals) await fs.writeFile(file, original);
    }
  }
  for (const test of ['usageViews.test.mjs', 'usageTokenTableRender.test.mjs', 'usageModel.test.mjs', 'usagePalettePairs.test.mjs', 'usageRecentPalette.test.mjs']) {
    const green = spawnSync(process.execPath, [test], { cwd: dir, encoding: 'utf8', timeout: 120000 });
    assert.equal(green.status, 0, `restored green: ${green.stdout}${green.stderr}`);
    console.log(`RESTORED GREEN: ${test}`);
  }
  if (process.env.USAGE_PROOF_RESULTS) await fs.writeFile(process.env.USAGE_PROOF_RESULTS, JSON.stringify(results, null, 2));
  console.log(`usageViews.mutations: ${results.length}/${cases.length} killed; restored suites green`);
} finally { await fs.rm(sandbox, { recursive: true, force: true }); }
