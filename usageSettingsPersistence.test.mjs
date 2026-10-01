import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
const root=process.cwd();
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-settings-persistence-'));
try {
  const stub=path.join(dir,'obsidian.mjs');
  const out=path.join(dir,'plugin.mjs');
  fs.writeFileSync(stub,['App','ItemView','Menu','Modal','Notice','PluginSettingTab','Scope','Setting','TFile','TFolder','WorkspaceLeaf'].map(n=>`export class ${n} {}`).join('\n')+`
export class Plugin { async loadData(){return structuredClone(this.persisted)} async saveData(data){this.persisted=structuredClone(data);this.writes??=[];this.writes.push(structuredClone(data))} }
export const Platform={isDesktop:false}; export const normalizePath=p=>p; export const setIcon=()=>{};`);
  esbuild.buildSync({absWorkingDir:root,entryPoints:['main.ts'],bundle:true,format:'esm',outfile:out,treeShaking:false,alias:{obsidian:stub},external:['electron','child_process','node:*','@codemirror/*','@lezer/*']});
  const {default:Plugin}=await import(pathToFileURL(out).href);
  const plugin=new Plugin();
  const obsolete='usageModelColors';
  plugin.persisted={usageView:'tokens',dailyBudgetUsd:23,[obsolete]:{synthetic:4},unknownLegacyKey:{example:true}};
  await plugin.loadSettings();
  assert.equal(plugin.settings.usageView,'tokens','real plugin load preserves selected view with legacy assignments present');
  assert.equal(plugin.settings.dailyBudgetUsd,23,'real plugin load preserves unrelated setting');
  await plugin.saveSettings();
  assert.equal(Object.hasOwn(plugin.writes[0],obsolete),false,'real plugin save never writes legacy per-model colour assignments');
  // Bypass load filtering to prove the save boundary independently: an
  // accidental old assignment in memory must not be persisted either.
  plugin.settings[obsolete]={injected:7};
  plugin.settings.usageView='cost';
  await plugin.saveSettings();
  assert.equal(Object.hasOwn(plugin.writes[1],obsolete),false,'real plugin save rejects colour assignments injected after load');
  assert.equal(plugin.writes[1].usageView,'cost','real plugin save persists selected view');
  assert.equal(plugin.writes[1].dailyBudgetUsd,23,'real plugin save preserves unrelated setting');
  const reloaded=new Plugin(); reloaded.persisted=plugin.persisted;
  await reloaded.loadSettings();
  assert.equal(reloaded.settings.usageView,'cost','real plugin load/save/reload retains metric choice');
  assert.equal(Object.hasOwn(reloaded.settings,obsolete),false,'real plugin reload has no per-model assignments');
  console.log('usageSettingsPersistence.test.mjs: PASS (real plugin load/save/reload, legacy and injected assignments excluded)');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
