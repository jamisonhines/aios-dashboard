import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, parseTranscript } from './vault-scripts/export-usage-stats.mjs';

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
} finally { await fs.rm(root, { recursive: true, force: true }); }
