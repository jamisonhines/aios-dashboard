import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { main, estimateCost, openAiApiEquivalentRate, findCodexTranscripts, parseTranscript, applyTranscriptToAggregates } from './vault-scripts/export-usage-stats.mjs';
import { usageChartFromWindow, usageDayFamilyBars, usageFamilyBreakdown, usageModelColorFamily, usageModelProvider, usageTotalTokens, configureUsageModelColors, usageModelSlot, computeUsageColorPlan } from './model.mjs';

const usage = { input_tokens: 1e6, cache_read_input_tokens: 2e6, cache_creation_input_tokens: 3e6, output_tokens: 4e6 };
for (const [model, rate, cost] of [
  ['gpt-6-sol', { input: 2, cacheRead: .2, cacheWrite: 2.5, output: 10 }, 49.9],
  ['gpt-6.1-sol', { input: 2, cacheRead: .1, cacheWrite: 2.5, output: 10 }, 49.7],
  ['gpt-6-luna', { input: .1, cacheRead: .01, cacheWrite: .125, output: .5 }, 2.495],
]) {
  assert.deepEqual(openAiApiEquivalentRate(`openai-codex/${model}`), rate, `${model} v2 base rates`);
  assert.equal(estimateCost('other', usage, undefined, `openai-codex/${model}`), cost, `${model} v2 cost`);
}
assert.equal(estimateCost('other', usage, undefined, 'openai-codex/codex-auto-review'), 0, 'unknown OpenAI has no guessed charge');
assert.equal(estimateCost('other', usage, undefined, 'ollama/qwen-example'), 0, 'local usage costs zero');
assert.equal(usageModelProvider('ollama/qwen-example'), 'local', 'local provider bucket');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-views-'));
try {
  const codexRoot = path.join(root, 'codex');
  const file = path.join(codexRoot, '2026/09/30/session.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const event = (timestamp, last, total) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } });
  const a = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, total_tokens: 107 };
  const b = { input_tokens: 210, cached_input_tokens: 80, output_tokens: 11, total_tokens: 221 };
  const cumulative = { input_tokens: 310, cached_input_tokens: 140, output_tokens: 18, total_tokens: 328 };
  await fs.writeFile(file, [
    { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    event('2026-09-29T12:00:00Z', a, a),
    event('2026-09-29T12:00:01Z', a, a), // rate-limit refresh repeats last, not another turn
    { type: 'turn_context', payload: { model: 'codex-auto-review' } },
    event('2026-09-30T12:00:00Z', b, cumulative),
    event('2026-10-02T12:00:00Z', a, { input_tokens: 410 }), // outside upper bound
  ].map(JSON.stringify).join('\n'));
  const outside = path.join(root, 'outside.jsonl'); await fs.writeFile(outside, '{}');
  await fs.symlink(outside, path.join(path.dirname(file), 'escape.jsonl'));
  assert.deepEqual((await findCodexTranscripts(codexRoot, 0)).map(t => t.filePath), [file], 'Codex root discovers only contained date sessions');
  assert.deepEqual(await findCodexTranscripts(codexRoot, Date.now() + 1e8), [], 'Codex mtime cutoff');
  const { entries } = await parseTranscript(file, Date.parse('2026-09-29'), { upperBoundMs: Date.parse('2026-10-01') });
  assert.equal(entries[0].input_tokens, 40, 'Codex subtracts cached input instead of double-counting it');
  assert.equal(entries.length, 2, 'Codex refresh of the same cumulative total is not a second turn');
  assert.deepEqual(entries.map(e => [e.model, e.input_tokens, e.cache_read_input_tokens, e.output_tokens]), [
    ['openai-codex/gpt-6-sol', 40, 60, 7], ['openai-codex/codex-auto-review', 130, 80, 11],
  ], 'Codex per-turn models and exclusive cached bucket');
  assert.equal(entries.reduce((n, e) => n + e.input_tokens + e.cache_read_input_tokens + e.output_tokens, 0), 328, 'Codex cumulative and refresh records do not double count');
  await main({ vaultRoot: path.join(root, 'vault'), projectsRoot: path.join(root, 'empty'), piRoot: path.join(root, 'empty'), bbRoot: path.join(root, 'empty'), codexRoot, now: new Date('2026-10-01T00:00:00Z') });
  const stats = JSON.parse(await fs.readFile(path.join(root, 'vault/Operations/usage/usage-stats.json'), 'utf8'));
  assert.deepEqual(stats.unpricedOpenAiModels, ['openai-codex/codex-auto-review'], 'unknown OpenAI reported unpriced');
  assert.equal(stats.days.length, 2, 'Codex event timestamps attribute days');
  assert.equal(stats.days[0].models['openai-codex/gpt-6-sol'].inputTokens, 40, 'Codex discovered root feeds exporter');
  assert.equal(stats.costSemantics.openaiRateCard, 'openai-codex-api-equivalent-v2', 'v2 serialized version');
  const cliVault = path.join(root, 'cli-vault');
  execFileSync(process.execPath, ['vault-scripts/export-usage-stats.mjs', cliVault], {
    env: { ...process.env, AIOS_USAGE_EXPORT_TEST_MODE: '1', USAGE_EXPORT_TEST_PROJECTS_ROOT: '/dev/null', USAGE_EXPORT_TEST_PI_ROOT: '/dev/null', USAGE_EXPORT_TEST_BB_ROOT: '/dev/null', USAGE_EXPORT_TEST_CODEX_ROOT: codexRoot },
  });
  const cliStats = JSON.parse(await fs.readFile(path.join(cliVault, 'Operations/usage/usage-stats.json'), 'utf8'));
  assert.equal(cliStats.days.reduce((sum, day) => sum + (day.models['openai-codex/gpt-6-sol']?.inputTokens || 0), 0), 40, 'USAGE_EXPORT_TEST_CODEX_ROOT selects fixture sessions, not USAGE_EXPORT_TEST_WRONG_CODEX_ROOT');
  const days = new Map();
  applyTranscriptToAggregates({ entries: [{ timestamp: '2026-09-30T12:00:00Z', model: 'ollama/qwen-example', ...usage }], skillRuns: [], projectName: 'synthetic', rule: { key: 'interactive', label: 'Interactive' }, days, projects: new Map(), workflows: new Map(), skills: new Map() });
  const local = [...days.values()][0]['ollama/qwen-example'];
  assert.equal(local.costUsd, 0, 'local zero cost aggregate');
  assert.equal(usageTotalTokens(local), 10e6, 'local tokens retained');
} finally { await fs.rm(root, { recursive: true, force: true }); }

const bucket = { inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 5, outputTokens: 7, messages: 1, costUsd: 4 };
const day = { date: '2026-09-30', models: { 'claude-opus-5': bucket, 'ollama/qwen-example': { ...bucket, costUsd: 0 } }, totalCostUsd: 4, totalOutputTokens: 14 };
const tokens = usageChartFromWindow([day], 'tokens');
assert.equal(tokens.days[0].segments.length, 2, 'Tokens chart includes free models');
assert.equal(tokens.gridlines[0].label, '34', 'Tokens axis totals all four buckets');
assert.equal(tokens.days[0].segments[0].heightFraction, .5, 'Tokens stack uses token magnitude');
assert.equal(usageDayFamilyBars(day, 'tokens').bars.length, 2, 'single day Tokens chart includes free models');
assert.equal(usageDayFamilyBars(day, 'tokens').gridlines[0].label, '17', 'single day Tokens axis');
assert.equal(usageChartFromWindow([day], 'cost').gridlines[0].label, '$4.00', 'Cost axis remains API-equivalent dollars');
assert.equal(usageFamilyBreakdown([day], 'tokens').table[0].totalTokens, 17, 'Tokens table four-bucket total');
assert.equal(usageFamilyBreakdown([day], 'tokens').table[0].sharePercent, 50, 'Tokens table share uses token total');
assert.notEqual(usageModelColorFamily('claude-opus-5'), usageModelColorFamily('claude-opus-5-5'), 'same Claude family has distinct colours');
const unknownDays = [{date:'2026-09-30',models:{'openai-codex/new-example-a':bucket,'openai-codex/new-example-b':bucket}}];
const unknownPlan = computeUsageColorPlan(unknownDays, {});
const unknown1 = usageModelColorFamily('openai-codex/new-example-a', unknownPlan);
const unknown2 = usageModelColorFamily('openai-codex/new-example-b', unknownPlan);
assert.equal(unknown1, unknown2, 'exhausted unowned slots fold into one provider Other colour');
assert.deepEqual(unknownPlan.groups['usage-group:openai:other'].members.sort(), Object.keys(unknownDays[0].models).sort(), 'overflow models share a named chart group, not overlapping marks');
assert.match(unknown1, /^openai-/, 'fallback uses OpenAI palette, not Other grey');
assert.equal(usageModelColorFamily('openai-codex/new-example-a', unknownPlan), unknown1, 'fallback identity stable after another model');
const assignments = {};
configureUsageModelColors(assignments);
const persistedDays = [{date:'2026-09-30',models:{'openai-codex/new-persisted':bucket}}];
const persistedPlan = computeUsageColorPlan(persistedDays, assignments);
const persistedColor = usageModelColorFamily('openai-codex/new-persisted', persistedPlan);
const reloadedPlan = computeUsageColorPlan(persistedDays, JSON.parse(JSON.stringify(assignments)));
assert.equal(usageModelColorFamily('openai-codex/new-persisted', reloadedPlan), persistedColor, 'fallback allocation persists across reload and filtering');
assert.equal(reloadedPlan.colors['openai-codex/new-persisted'].slot, 4, 'fallback takes the next unowned provider step');
console.log('usageViews.test.mjs: all assertions passed');
