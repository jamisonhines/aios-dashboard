import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findPiAndBbTranscripts, main } from './vault-scripts/export-usage-stats.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-bb-threads-'));
const bbRoot = path.join(root, 'bb');
const empty = path.join(root, 'empty');
const timestamp = '2026-10-01T10:00:00Z';
const record = (responseId, input) => JSON.stringify({ type: 'message', timestamp, responseId,
  message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol',
    usage: { input, output: 3, cacheRead: 5, cacheWrite: 7 } } }) + '\n';
try {
  const files = {
    'pi_fixture.jsonl': record('shared', 11) + record('thread-only', 17),
    'thr_fixture.jsonl': record('legacy', 19),
    'pi_fixture/run-id/run-0/session.jsonl': record('shared', 11) + record('run-only', 23),
    'nested/pi_ignored.jsonl': record('nested', 1000),
    'subagent-artifacts/pi_ignored/run-0/session.jsonl': record('artifact', 2000),
    'forks/pi_ignored/run-0/session.jsonl': record('fork', 3000),
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(bbRoot, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  const found = await findPiAndBbTranscripts(empty, bbRoot, 0);
  assert.ok(found.some(f => f.filePath === path.join(bbRoot, 'pi_fixture.jsonl')), 'pi_<id>.jsonl at bb root is counted');
  assert.ok(found.some(f => f.filePath === path.join(bbRoot, 'thr_fixture.jsonl')), 'thr_<id>.jsonl at bb root is counted');
  assert.equal(found.length, 3, 'depth, artifact and fork exclusions remain intact');
  assert.ok(found.every(f => f.isTopLevel), 'thread and run transcripts retain top-level attribution');
  await main({ vaultRoot: root, projectsRoot: empty, piRoot: empty, bbRoot, codexRoot: empty, now: new Date(timestamp) });
  const output = JSON.parse(await fs.readFile(path.join(root, 'Operations/usage/usage-stats.json'), 'utf8'));
  const model = output.days[0].models['openai-codex/gpt-6.1-sol'];
  assert.equal(model.messages, 4, 'distinct thread/run responses survive, shared response counts once');
  assert.equal(model.inputTokens, 70, 'both thread and run unique tokens contribute exactly once');
  assert.equal(output.dedupe.skippedUsageRecords, 1, 'existing response dedupe audits the shared response');
  assert.equal(output.dedupe.collisions[0].kind, 'responseId');
  console.log('usageBbThreads: PASS (pi, thr, exclusions, response dedupe)');
} finally { await fs.rm(root, { recursive: true, force: true }); }
