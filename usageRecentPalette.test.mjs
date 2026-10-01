import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import { computeUsageColorPlan,groupUsageDays,usageFamilyBreakdown,usageChartFromWindow,usageDayFamilyBars } from './model.mjs';
import { USAGE_PROVIDER_PALETTES } from './usagePalettes.mjs';
const bucket=n=>({inputTokens:n,cacheReadTokens:n*2,cacheWriteTokens:n*3,outputTokens:n*4,messages:1,costUsd:n/100});
const recent=Array.from({length:12},(_,i)=>`openai-codex/recent-${String(i).padStart(2,'0')}`);
const days=[
  {date:'2026-09-01',models:{'openai-codex/gpt-5.6-terra':bucket(1e8),'openai-codex/gpt-5.6-sol':bucket(2e8)},totalCostUsd:3e6},
  {date:'2026-09-23',models:{'openai-codex/outside-seven-days':bucket(9e7)},totalCostUsd:9e5},
  {date:'2026-09-24',models:Object.fromEntries(recent.map((model,i)=>[model,bucket(100-i)])),totalCostUsd:9},
  {date:'2026-09-30',models:{'openai-codex/recent-11':bucket(1)},totalCostUsd:.01},
];
const plan=computeUsageColorPlan(days,{});
const kept=Object.keys(plan.groups).filter(key=>key.startsWith('openai-codex/')).sort();
assert.deepEqual(kept,recent.slice(0,USAGE_PROVIDER_PALETTES.openai.light.length-1),'recent 7-day share outranks retired whole-window volume');
assert.equal(plan.ranking.recentStart,'2026-09-24','recent window includes exactly seven export calendar dates');
assert.equal(plan.ranking.recentEnd,'2026-09-30','recent window anchored to latest export day, not host clock or filter');
assert.equal(plan.ranking.byProvider.openai.find(r=>r.model==='openai-codex/outside-seven-days').recentShare,0,'day before recent cutoff has no recent share');
const tieDays=[
  {date:'2026-09-01',models:{'openai-codex/tie-z':bucket(2),'openai-codex/tie-a':bucket(1)},totalCostUsd:.03},
  {date:'2026-09-30',models:{'openai-codex/tie-z':bucket(10),'openai-codex/tie-a':bucket(10),'openai-codex/key-b':bucket(9),'openai-codex/key-a':bucket(9)},totalCostUsd:.38},
];
const ranking=computeUsageColorPlan(tieDays,{}).ranking.byProvider.openai;
assert.deepEqual(ranking.map(r=>r.model),['openai-codex/tie-z','openai-codex/tie-a','openai-codex/key-a','openai-codex/key-b'],'recent-share ties break by whole-window share, then model key');
assert.ok(Math.abs(ranking.reduce((n,r)=>n+r.recentShare,0)-1)<1e-12,'provider-relative recent shares sum to one');
const partial=usageFamilyBreakdown([days.at(-1)],'tokens',plan).table;
assert.equal(partial[0].foldedInto,'OpenAI other','filtering to a tail-heavy day never repaints the export plan');
assert.equal(usageFamilyBreakdown([days.at(-1)],'cost',plan).table[0].family,partial[0].family,'view change keeps recency-plan colour');
const locals=['ollama/local-a','ollama/local-b','qwen-example'];
const localDays=[{date:'2026-09-30',models:Object.fromEntries(locals.map((m,i)=>[m,{...bucket(i+1),costUsd:0}])),totalCostUsd:0}];
const localPlan=computeUsageColorPlan(localDays,{});
assert.equal(USAGE_PROVIDER_PALETTES.local.light.length,1,'one reserved Local colour frees provider palette space');
assert.deepEqual(Object.values(localPlan.groups).map(g=>g.label),['Local'],'all local models share one named Local chart group');
assert.equal(new Set(locals.map(m=>localPlan.colors[m].slot)).size,1,'all local models share the same Local slot');
const grouped=groupUsageDays(localDays,localPlan);
assert.equal(Object.keys(grouped[0].models).length,1,'local grouping renders one mark, not overlapping same-colour marks');
assert.equal(Object.values(grouped[0].models)[0].inputTokens,6,'Local group retains every local input token');
assert.equal(Object.values(grouped[0].models)[0].costUsd,0,'Local group remains free');
const table=usageFamilyBreakdown(localDays,'tokens',localPlan).table;
assert.deepEqual(table.map(r=>r.model).sort(),locals.sort(),'all local models stay listed by name in the table');
assert.ok(table.every(r=>r.foldedInto==='Local'),'local table rows identify the Local group, not Local other');
assert.equal(usageChartFromWindow(localDays,'tokens',localPlan).days[0].segments.length,1,'multi-day Tokens chart has one Local series');
assert.deepEqual(usageDayFamilyBars(localDays[0],'tokens',localPlan).bars.map(b=>b.label),['Local'],'single-day Tokens chart has one Local bar');
assert.equal(usageChartFromWindow(localDays,'cost',localPlan).days[0].segments.length,0,'free Local group does not invent a dollar bar');
console.log('usageRecentPalette.test.mjs: all assertions passed');
