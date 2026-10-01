#!/usr/bin/env node
// External canonical validator evidence. Input/output paths are explicit;
// never writes a live usage snapshot or publishes transcript content.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { computeUsageColorPlan, groupUsageDays, usageModelKeys, usageMetric } from '../model.mjs';
import { USAGE_PROVIDER_PALETTES } from '../usagePalettes.mjs';
const [input,validator,output]=process.argv.slice(2);
if(!input||!validator||!output)throw new Error('Usage: validate-usage-palettes.mjs <export.json> <validator.js> <evidence.md>');
const stats=JSON.parse(fs.readFileSync(input,'utf8'));
const plan=computeUsageColorPlan(stats.days,{});
let evidence='',runs=0;
function check(title,colors,mode){
  const surface=mode==='light'?'#ffffff':'#1e1e1e';
  const args=[validator,colors.join(','),'--mode',mode,'--surface',surface,'--pairs','all'];
  const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:30000});
  const text=`${run.stdout||''}${run.stderr||''}`.replaceAll('\u2014',':');
  evidence+=`### ${title}, ${mode}\n\n\`\`\`text\n$ node ${validator} "${args[1]}" --mode ${mode} --surface "${surface}" --pairs all | perl -CSD -pe 's/\\x{2014}/:/g'\n${text}\nvalidator exit ${run.status}\n\`\`\`\n\n`;
  if(run.status!==0)throw new Error(`${title} ${mode} failed: ${text}`);
  runs++;
}
for(const mode of ['light','dark']){
  for(const [provider,palette] of Object.entries(USAGE_PROVIDER_PALETTES))check(`${provider} reserved provider palette`,palette[mode],mode);
  check('Combined reserved palette',Object.values(USAGE_PROVIDER_PALETTES).flatMap(p=>p[mode]),mode);
  for(const day of groupUsageDays(stats.days,plan)){
    // Union of both views. Cost-only and Tokens-only subsets inherit the
    // all-pairs guarantee; do not treat a positive cached bucket as absent.
    const models=Object.fromEntries(Object.entries(day.models).filter(([,b])=>usageMetric(b,'tokens')>0||usageMetric(b,'cost')>0));
    const colors=usageModelKeys(models,plan).map(key=>{const c=plan.colors[key];return USAGE_PROVIDER_PALETTES[c.provider][mode][c.slot];});
    if(colors.length)check(`Actual co-occurring day ${day.date} (${colors.length} displayed model groups)`,colors,mode);
  }
}
fs.writeFileSync(output,evidence);
console.log(`${runs} canonical all-pairs validator runs: all exit 0; ${stats.days.length} actual days, both modes, provider palettes and combined palette.`);
console.log('Provider other tails: '+JSON.stringify(Object.fromEntries(Object.entries(plan.foldedByProvider).filter(([p])=>p!=='local'))));
console.log('Local group members: '+JSON.stringify(plan.foldedByProvider.local));
console.log('Recent export window: '+plan.ranking.recentStart+' to '+plan.ranking.recentEnd);
