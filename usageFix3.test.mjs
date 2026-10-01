import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, parseTranscript, estimateCost, applyTranscriptToAggregates } from './vault-scripts/export-usage-stats.mjs';
import { computeUsageColorPlan, usageModelColorFamily, configureUsageModelColors, usageModelSlot } from './model.mjs';
import { USAGE_EXPLICIT_MODEL_SLOTS } from './usagePalettes.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-fix3-'));
const timestamp = '2026-09-30T12:00:00Z';
const counters = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, total_tokens: 107 };
const context = { type: 'turn_context', payload: { model: 'gpt-6-sol' } };
const event = (time = timestamp, last = counters, total = counters) => ({ type: 'event_msg', timestamp: time, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } });
async function writeLines(file, lines) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(JSON.stringify).join('\n') + '\n');
}
async function check(name, run) {
  if (process.env.FIX3_CASE && process.env.FIX3_CASE !== name) return;
  try { await run(); console.log(`PASS usageFix3.test.mjs: ${name}`); }
  catch (error) { console.error(`FAIL usageFix3.test.mjs: ${name}: ${error.message}`); throw error; }
}
try {
  await check('malformed event isolation', async () => {
    const codexRoot = path.join(root, 'codex');
    const file = path.join(codexRoot, '2026/09/30/malformed.jsonl');
    await writeLines(file, [context, event({ toString: null, valueOf: null }),
      event(timestamp, counters, { ...counters, total_tokens: 108 }),
      event(timestamp, [], { ...counters, total_tokens: 109 }),
      event(timestamp, { ...counters, output_tokens: 'bad' }, { ...counters, total_tokens: 110 })]);
    const parsed = await parseTranscript(file, 0);
    assert.equal(parsed.entries.length, 1, 'valid later event survives malformed timestamp, shape and number');
    assert.equal(parsed.rejectedUsage.serialize().rejectedRecords, 3, 'three malformed records rejected');
    assert.equal(parsed.rejectedUsage.serialize().reasons['invalid-codex-event'], 1, 'conversion exception has a specific rejection diagnostic');
    await writeLines(path.join(codexRoot, '2026/09/30/valid.jsonl'), [context, event()]);
    const projectsRoot = path.join(root, 'claude');
    const piRoot = path.join(root, 'pi');
    const bbRoot = path.join(root, 'bb');
    const assistant = (model) => ({ type: 'assistant', timestamp, message: { model, usage: { input_tokens: 2, output_tokens: 3 } } });
    await writeLines(path.join(projectsRoot, 'synthetic', 'session.jsonl'), [assistant('claude-sonnet-4')]);
    await writeLines(path.join(piRoot, 'synthetic', 'session.jsonl'), [assistant('ollama/pi-fixture')]);
    await writeLines(path.join(bbRoot, 'synthetic', 'run-0', 'session.jsonl'), [assistant('ollama/bb-fixture')]);
    const vaultRoot = path.join(root, 'vault');
    await main({ vaultRoot, projectsRoot, piRoot, bbRoot, codexRoot, now: new Date('2026-10-01T00:00:00Z') });
    const stats = JSON.parse(await fs.readFile(path.join(vaultRoot, 'Operations/usage/usage-stats.json'), 'utf8'));
    const models = stats.days.flatMap(day => Object.keys(day.models));
    for (const model of ['openai-codex/gpt-6-sol', 'claude-sonnet-4', 'ollama/pi-fixture', 'ollama/bb-fixture']) {
      assert.ok(models.includes(model), `unaffected source exports ${model}`);
    }
    assert.equal(stats.days[0].models['openai-codex/gpt-6-sol'].messages, 2, 'both valid Codex events export');
    assert.equal(stats.rejectedUsage.rejectedRecords, 3, 'main publishes rejected diagnostics');
  });
  await check('canonical refresh identity', async () => {
    const file = path.join(root, 'canonical.jsonl');
    const reordered = Object.fromEntries(Object.entries(counters).reverse());
    await writeLines(file, [context, event(), event('2026-09-30T12:00:01Z', counters, reordered)]);
    const parsed = await parseTranscript(file, 0);
    assert.equal(parsed.entries.length, 1, 'reordered cumulative refresh is charged once');
    assert.equal(parsed.entries[0].input_tokens + parsed.entries[0].cache_read_input_tokens + parsed.entries[0].output_tokens, 107);
  });
  await check('rejection does not reserve identity', async () => {
    const file = path.join(root, 'rejected-first.jsonl');
    for (const [label, rejected, cutoff, upper] of [
      ['invalid timestamp', event('invalid'), 0, Infinity],
      ['throwing timestamp', event({ toString: null, valueOf: null }), 0, Infinity],
      ['bad usage', event(timestamp, { ...counters, output_tokens: 'bad' }), 0, Infinity],
      ['before cutoff', event('2026-09-29T12:00:00Z'), Date.parse('2026-09-30'), Infinity],
      ['after upper bound', event('2026-10-02T12:00:00Z'), 0, Date.parse('2026-10-01')],
    ]) {
      await writeLines(file, [context, rejected, event()]);
      const parsed = await parseTranscript(file, cutoff, { upperBoundMs: upper });
      assert.equal(parsed.entries.length, 1, `${label}: valid refresh survives earlier rejection`);
      assert.equal(parsed.rejectedUsage.serialize().rejectedRecords, 1, `${label}: rejected counter increments`);
    }
  });
  await check('missing cumulative usage rejected', async () => {
    const file = path.join(root, 'missing-total.jsonl');
    const missing = event(); delete missing.payload.info.total_token_usage;
    await writeLines(file, [context, missing, { ...missing, timestamp: '2026-09-30T12:00:01Z' }]);
    const parsed = await parseTranscript(file, 0);
    assert.equal(parsed.entries.length, 0, 'missing cumulative usage is never charged');
    assert.deepEqual(parsed.rejectedUsage.serialize(), { rejectedRecords: 2, reasons: { 'missing-codex-total': 2 } }, 'missing cumulative diagnostic counts both records');
  });
  await check('fallback persists across explicit arrival', async () => {
    const unknown = 'openai-codex/synthetic-new';
    const explicit = 'openai-codex/gpt-6-astra';
    const bucket = { inputTokens: 100, costUsd: 1 };
    const days = models => [{ date: '2026-09-30', models: Object.fromEntries(models.map(model => [model, bucket])) }];
    const assignments = {};
    const first = computeUsageColorPlan(days([unknown]), assignments);
    const color = usageModelColorFamily(unknown, first);
    const slot = assignments[unknown];
    const next = computeUsageColorPlan(days([unknown, explicit]), assignments);
    assert.equal(usageModelColorFamily(unknown, next), color, 'explicit arrival never repaints fallback');
    assert.equal(assignments[unknown], slot, 'persisted fallback assignment is never overwritten');
    const owned = new Set(Object.values(USAGE_EXPLICIT_MODEL_SLOTS).filter(row => row.provider === 'openai').map(row => row.slot));
    assert.ok(!owned.has(slot), 'fallback never takes an absent explicit binding');
    assert.equal(slot, 4, 'fallback takes the first unowned provider slot');
    const crowded = computeUsageColorPlan(days([unknown, explicit, 'openai-codex/synthetic-second']), assignments);
    assert.deepEqual(crowded.groups['usage-group:openai:other'].members.sort(), [unknown, 'openai-codex/synthetic-second'].sort(), 'exhausted unowned capacity folds fallback models into provider Other');
    assert.equal(assignments[unknown], slot, 'folding does not rewrite persisted assignments');
    const recovered = computeUsageColorPlan(days([unknown, explicit]), assignments);
    assert.equal(usageModelColorFamily(unknown, recovered), color, 'fallback recovers original color after overflow disappears');
    const legacy = { [unknown]: 0 };
    const legacyPlan = computeUsageColorPlan(days([unknown, explicit]), legacy);
    assert.equal(legacy[unknown], 0, 'legacy owned assignment is preserved rather than overwritten');
    assert.ok(legacyPlan.foldedByProvider.openai.includes(unknown), 'legacy collision folds, never steals explicit color');
    configureUsageModelColors(legacy);
    assert.equal(usageModelSlot(unknown).slot, 4, 'standalone legacy collision resolves to provider Other');
    assert.equal(legacy[unknown], 0, 'standalone lookup never overwrites legacy persistence');
    configureUsageModelColors({});
  });
  await check('malformed cumulative schema', async () => {
    const file = path.join(root, 'bad-total.jsonl');
    for (const total of [[], 'wrong shape', {}, { ...counters, output_tokens: '7' }, { ...counters, input_tokens: -1 }]) {
      await writeLines(file, [context, event(timestamp, counters, total), event()]);
      const parsed = await parseTranscript(file, 0);
      assert.deepEqual(parsed.rejectedUsage.serialize(), { rejectedRecords: 1, reasons: { 'invalid-codex-total': 1 } }, 'malformed cumulative schema rejected before identity reservation');
      assert.equal(parsed.entries.length, 1, 'valid event survives malformed cumulative schema');
    }
  });
  await check('Codex cache write tokens and cost', async () => {
    const file = path.join(root, 'cache-write.jsonl');
    const last = { ...counters, cache_write_input_tokens: 13, total_tokens: 120 };
    await writeLines(file, [context, event(timestamp, last, last)]);
    const parsed = await parseTranscript(file, 0);
    assert.equal(parsed.entries.length, 1);
    const entry = parsed.entries[0];
    assert.equal(entry.cache_creation_input_tokens, 13, 'Codex nonzero cache write maps to cache creation');
    const expectedCost = (40 * 2 + 60 * .2 + 13 * 2.5 + 7 * 10) / 1e6;
    assert.equal(estimateCost('other', entry, undefined, entry.model), expectedCost, 'Codex cache write is priced at its distinct nonzero rate');
    const days = new Map();
    applyTranscriptToAggregates({ ...parsed, projectName: 'synthetic', rule: { key: 'interactive', label: 'Interactive' }, days, projects: new Map(), workflows: new Map(), skills: new Map() });
    const bucket = [...days.values()][0][entry.model];
    assert.equal(bucket.cacheWriteTokens, 13, 'aggregate retains Codex cache write tokens');
    assert.equal(bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens, 120, 'all four nonzero Codex buckets retained');
    assert.equal(bucket.costUsd, expectedCost, 'aggregate retains cache write price');
  });
  await check('Codex numeric guard diagnostics', async () => {
    const file = path.join(root, 'bad-numbers.jsonl');
    const bad = [
      { ...counters, input_tokens: '100' }, { ...counters, input_tokens: -1, cached_input_tokens: 0 },
      { ...counters, cached_input_tokens: -1 }, { ...counters, cached_input_tokens: 101 },
      { ...counters, cached_input_tokens: null }, { ...counters, output_tokens: '7' },
      { ...counters, output_tokens: -1 }, { ...counters, cache_write_input_tokens: '13' },
      { ...counters, cache_write_input_tokens: -1 }, { ...counters, cache_write_input_tokens: null },
      { ...counters, input_tokens: null }, { ...counters, output_tokens: null }, [], 'wrong shape',
      { ...counters, input_tokens: 'overflow' }, { ...counters, cached_input_tokens: 'overflow' },
      { ...counters, output_tokens: 'overflow' }, { ...counters, cache_write_input_tokens: 'overflow' },
    ];
    for (const [index, last] of bad.entries()) {
      await writeLines(file, [context, event(timestamp, last), event()]);
      // JSON's number grammar admits an exponent that overflows JS Number.
      // Do not JSON.stringify Infinity, which silently turns it into null.
      const raw = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, raw.replaceAll('"overflow"', '1e400'));
      const parsed = await parseTranscript(file, 0);
      assert.deepEqual(parsed.rejectedUsage.serialize(), { rejectedRecords: 1, reasons: { 'invalid-codex-numbers': 1 } }, `numeric fixture ${index} rejected by Codex guard, not normalizer`);
      assert.equal(parsed.entries.length, 1, `numeric fixture ${index} does not suppress valid refresh`);
      assert.equal(parsed.entries[0].input_tokens, 40, `numeric fixture ${index} retains only valid usage`);
    }
  });
} finally { await fs.rm(root, { recursive: true, force: true }); }
