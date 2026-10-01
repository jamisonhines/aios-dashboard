// Fix-round GL-009 proofs run in isolated copies, never a live exporter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
const root = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-fix1-proofs-'));
const dir = path.join(temp, 'Projects/dashboard');
const viewportReq = 'REQ: the popup period label and total stay visible inside the visible scroll viewport of a short pane.';
const cases = [
  { requirement: viewportReq, file: 'main.ts', from: 'height: pane.clientHeight };', to: 'height: 400 };', test: 'usagePopupViewport.test.mjs', mutation: 'visible viewport height -> constant 400' },
  { requirement: viewportReq, file: 'main.ts', from: 'popupModels = popup.createDiv({ cls: "aios-usage-popup-models" });', to: 'popupModels = popup.createDiv({ cls: "aios-usage-popup-models" }); popupModels.appendChild(header);', test: 'usagePopupViewport.test.mjs', mutation: 'fixed header -> scrolling model list' },
];
const sharedReq = 'REQ: a response without responseId that appears in two discovered transcripts with the same message id, timestamp, model and usage is counted once.';
const distinctReq = 'REQ: two responses without responseId that differ in message id, timestamp, model or usage are both counted.';
const messageKey = `return "message:" + JSON.stringify([
      entry.messageId, entry.timestamp, entry.model,
      entry.input_tokens, entry.output_tokens,
      entry.cache_creation_input_tokens, entry.cache_read_input_tokens,
    ]);`;
cases.push({ requirement: sharedReq, file: 'vault-scripts/export-usage-stats.mjs', from: 'if (typeof entry.messageId === "string" && entry.messageId.length > 0)', to: 'if (false)', test: 'usageBbNoResponse.test.mjs', mutation: 'disable source-independent message identity' });
for (const field of ['messageId','timestamp','model','input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens']) {
  cases.push({ requirement: distinctReq, file: 'vault-scripts/export-usage-stats.mjs', from: messageKey, to: messageKey.replace('entry.'+field, '""'), test: 'usageBbNoResponse.test.mjs', mutation: 'omit distinct response field '+field });
}
const settingsReq = 'REQ: saving settings through the real plugin save path never writes per-model colour assignments.';
cases.push({ requirement: settingsReq, file: 'main.ts', from: 'await this.saveData(persisted);', to: 'await this.saveData({ ...this.settings, ["usageModel" + "Colors"]: { obsolete: 1 } });', test: 'usageSettingsPersistence.test.mjs', mutation: 'Reviewer mutation writes obsolete assignments through saveData' });
cases.push({ requirement: settingsReq, file: 'main.ts', from: 'await this.saveData(persisted);', to: 'await this.saveData(this.settings);', test: 'usageSettingsPersistence.test.mjs', mutation: 'save bypasses whitelist with legacy assignments injected after load' });
const results = [];
try {
  const libs = path.join(temp, 'AIOS/Operations/scripts/lib');
  await fs.mkdir(libs, { recursive: true });
  for (const name of ['coordination-parse.mjs','coordination-accounting.mjs']) await fs.copyFile(path.resolve(root,'../../AIOS/Operations/scripts/lib',name),path.join(libs,name));
  for (const file of execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)) {
    await fs.mkdir(path.dirname(path.join(dir,file)),{recursive:true});
    await fs.copyFile(path.join(root,file),path.join(dir,file));
  }
  await fs.symlink(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');
  for (const mutation of cases) {
    const file = path.join(dir,mutation.file);
    const original = await fs.readFile(file,'utf8');
    assert.equal(original.split(mutation.from).length,2,'unique executable mutation: '+mutation.mutation);
    try {
      await fs.writeFile(file,original.replace(mutation.from,mutation.to));
      const run = spawnSync(process.execPath,[mutation.test],{cwd:dir,encoding:'utf8',timeout:120000});
      const output = `${run.stdout || ''}${run.stderr || ''}`;
      assert.notEqual(run.status,0,'survived: '+mutation.mutation);
      const message = output.match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/)?.[1];
      assert.ok(message,'must fail at named assertion: '+output);
      const result = { requirement: mutation.requirement, mutation: mutation.mutation, failLine: `${mutation.test}: AssertionError [ERR_ASSERTION]: ${message}` };
      results.push(result); console.log('KILLED: '+result.mutation+'\nFAIL: '+result.failLine);
    } finally { await fs.writeFile(file,original); }
  }
  for (const test of new Set(cases.map(c=>c.test))) {
    const run=spawnSync(process.execPath,[test],{cwd:dir,encoding:'utf8',timeout:120000});
    assert.equal(run.status,0,`restored green: ${run.stdout}${run.stderr}`);
    console.log('RESTORED GREEN: '+test);
  }
  if(process.env.USAGE_FIX1_PROOF_RESULTS)await fs.writeFile(process.env.USAGE_FIX1_PROOF_RESULTS,JSON.stringify(results,null,2));
  console.log(`usageSimplifyFix1.mutations: ${results.length}/${cases.length} killed; restored suites green`);
} finally { await fs.rm(temp,{recursive:true,force:true}); }
