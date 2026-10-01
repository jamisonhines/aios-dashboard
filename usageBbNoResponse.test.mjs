import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUsageRecordDedupe, main } from './vault-scripts/export-usage-stats.mjs';
const base = { messageId:'shared-message', timestamp:'2026-10-01T10:00:00Z', model:'openai-codex/gpt-6.1-sol', provider:'openai-codex', input_tokens:11, output_tokens:13, cache_creation_input_tokens:17, cache_read_input_tokens:19, assistantContent:'synthetic prose' };
const fields = { messageId:'different-message', timestamp:'2026-10-01T10:00:01Z', model:'openai-codex/gpt-6-sol', input_tokens:23, output_tokens:29, cache_creation_input_tokens:31, cache_read_input_tokens:37 };
const dedupe = createUsageRecordDedupe();
assert.equal(dedupe.accept({...base,sourceSessionId:'bb:pi_fixture.jsonl'}),true);
assert.equal(dedupe.accept({...base,sourceSessionId:'bb:pi_fixture/run-0/session.jsonl',assistantContent:'a different physical copy of prose'}),false,'same message id, timestamp, model and every usage bucket dedupe across physical files without responseId');
for(const [field,value]of Object.entries(fields)) {
  const d=createUsageRecordDedupe();
  d.accept({...base,sourceSessionId:'bb:pi_fixture.jsonl'});
  assert.equal(d.accept({...base,[field]:value,sourceSessionId:'bb:thr_fixture.jsonl'}),true,`distinct no-responseId ${field} counts separately`);
}
const anonymous = createUsageRecordDedupe();
assert.equal(anonymous.accept({...base,messageId:'',sourceSessionId:'bb:pi_fixture.jsonl'}),true);
assert.equal(anonymous.accept({...base,messageId:'',sourceSessionId:'bb:pi_fixture/run-0/session.jsonl'}),true,'records without responseId or message id retain source-scoped fingerprint');
assert.equal(anonymous.accept({...base,messageId:'',sourceSessionId:'bb:pi_fixture.jsonl'}),false,'same-source anonymous duplicates still dedupe');
const record=e=>JSON.stringify({type:'message',timestamp:e.timestamp,id:e.messageId,message:{role:'assistant',provider:e.provider,model:e.model.replace(/^openai-codex\//,''),content:e.assistantContent,usage:{input:e.input_tokens,output:e.output_tokens,cacheRead:e.cache_read_input_tokens,cacheWrite:e.cache_creation_input_tokens}}})+'\n';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'usage-bb-no-response-'));
try {
  const bbRoot=path.join(root,'bb'); const empty=path.join(root,'empty');
  const run=path.join(bbRoot,'pi_fixture/run-0/session.jsonl');
  await fs.mkdir(path.dirname(run),{recursive:true});
  const noId={...base,messageId:''};
  await fs.writeFile(path.join(bbRoot,'pi_fixture.jsonl'),record(base)+record(noId));
  await fs.writeFile(path.join(bbRoot,'thr_fixture.jsonl'),record({...base,assistantContent:'copied prose'}));
  await fs.writeFile(run,record(base)+Object.entries(fields).map(([field,value])=>record({...base,[field]:value})).join('')+record(noId));
  await main({vaultRoot:root,projectsRoot:empty,piRoot:empty,bbRoot,codexRoot:empty,now:new Date('2026-10-01T11:00:00Z')});
  const output=JSON.parse(await fs.readFile(path.join(root,'Operations/usage/usage-stats.json'),'utf8'));
  const models=Object.values(output.days[0].models);
  assert.equal(models.reduce((sum,m)=>sum+m.messages,0),10,'discovered pi, thr and run files count shared no-responseId record once and preserve distinct/anonymous responses');
  assert.equal(models.reduce((sum,m)=>sum+m.inputTokens,0),122,'positive-token no-responseId overlap contributes input once');
  assert.equal(output.dedupe.skippedUsageRecords,2,'both additional physical copies are audited');
  console.log('usageBbNoResponse.test.mjs: PASS (cross-file message identity, seven distinct-field cases, source-scoped anonymous fallback)');
} finally { await fs.rm(root,{recursive:true,force:true}); }
