import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import { computeUsageColorPlan, groupUsageDays, usageChartFromWindow, usageDayFamilyBars, usageFamilyBreakdown } from './model.mjs';
import { USAGE_PROVIDER_PALETTES } from './usagePalettes.mjs';
import { separation } from './dev/usage-color-math.mjs';
const bucket = n => ({ inputTokens:n, cacheReadTokens:n*2, cacheWriteTokens:n*3, outputTokens:n*4, messages:1, costUsd:n/100 });
const models = ['claude-sonnet-5','claude-opus-5','claude-opus-5-5','claude-fable-5-1','claude-sonnet-5-5','openai-codex/gpt-6-astra','openai-codex/gpt-5.6-terra','openai-codex/gpt-5.6-sol','openai-codex/gpt-6-sol','openai-codex/gpt-5.5','ollama/model-a','ollama/model-b','ollama/model-c'];
const full = [
  {date:'2026-09-29',models:Object.fromEntries(models.map((key,i)=>[key,bucket(1000-i*50)])),totalCostUsd:9},
  // The selected day reverses the provider's token rank. It must NOT repaint
  // or unfold that small model when the whole-export plan is supplied.
  {date:'2026-09-30',models:{'claude-sonnet-5-5':bucket(20),'claude-opus-5':bucket(1)},totalCostUsd:3},
];
const assignments = {};
const plan = computeUsageColorPlan(full,assignments);
assert.equal(plan.colors['claude-opus-5'].slot,1,'explicit Opus identity keeps mapped colour regardless of token rank');
assert.deepEqual(plan.foldedByProvider.claude,['claude-fable-5-1','claude-sonnet-5-5'], 'fold the smallest Claude token shares over the entire export');
assert.deepEqual(plan.foldedByProvider.openai,['openai-codex/gpt-6-sol','openai-codex/gpt-5.5'], 'fold the smallest OpenAI token shares over the entire export');
assert.deepEqual(plan.foldedByProvider.local,[], 'three local models fit without folding');
const before = full.flatMap(d=>Object.values(d.models)).reduce((n,b)=>n+b.inputTokens+b.cacheReadTokens+b.cacheWriteTokens+b.outputTokens,0);
const grouped = groupUsageDays(full,plan);
assert.equal(grouped.flatMap(d=>Object.values(d.models)).reduce((n,b)=>n+b.costUsd,0),full.flatMap(d=>Object.values(d.models)).reduce((n,b)=>n+b.costUsd,0),'folding preserves API-equivalent cost');
const after = grouped.flatMap(d=>Object.values(d.models)).reduce((n,b)=>n+b.inputTokens+b.cacheReadTokens+b.cacheWriteTokens+b.outputTokens,0);
assert.equal(after,before,'folding preserves all four token buckets');
for (const mode of ['light','dark']) {
  const hex = color => USAGE_PROVIDER_PALETTES[color.provider][mode][color.slot];
  for(const day of grouped) {
    const keys=Object.keys(day.models);
    for(let i=0;i<keys.length;i++)for(let j=0;j<i;j++) {
      const a=hex(plan.colors[keys[i]]),b=hex(plan.colors[keys[j]]),d=separation(a,b);
      assert.ok(d.normal>=15, `${mode}: two models that appear on the same day are separated by normal-vision Delta E of at least 15 (${keys[j]}, ${keys[i]}: ${d.normal})`);
      assert.ok(d.cvd>=6,`${mode}: co-occurring pairs clear the CVD floor (${keys[j]}, ${keys[i]})`);
    }
  }
  // Full reserved provider palettes, and cross-provider combinations, are
  // all-pairs safe, not only one observed adjacent order.
  const reserved=Object.values(USAGE_PROVIDER_PALETTES).flatMap(p=>p[mode]);
  for(let i=0;i<reserved.length;i++)for(let j=0;j<i;j++) {
    const d=separation(reserved[i],reserved[j]);
    assert.ok(d.normal>=15, `${mode}: full reserved palette normal floor (${reserved[j]}, ${reserved[i]})`);
    assert.ok(d.cvd>=6, `${mode}: full reserved palette CVD floor (${reserved[j]}, ${reserved[i]})`);
  }
}
const slice = [full[1]];
const table=usageFamilyBreakdown(slice,'tokens',plan).table;
assert.equal(table.find(r=>r.model==='claude-sonnet-5-5')?.foldedInto,'Claude other','folded model still appears by name in the table');
assert.equal(table.length,2,'folding does not drop model table rows');
assert.equal(usageFamilyBreakdown(slice,'tokens',plan).legend.some(r=>r.label==='Claude other'),true,'folded chart legend names the provider other group');
const allColor=usageFamilyBreakdown(full,'tokens',plan).table.find(r=>r.model==='claude-opus-5').family;
assert.equal(table.find(r=>r.model==='claude-opus-5').family,allColor,'range/filter keeps model colour from the whole-export plan');
const chart=usageChartFromWindow(slice,'tokens',plan);
assert.equal(chart.days[0].segments.length,2,'multi-day chart groups with the full-export plan');
assert.equal(usageDayFamilyBars(full[1],'tokens',plan).bars.find(r=>r.label==='Claude other').inputTokens,20,'single-day chart groups with the full-export plan');
const reload=computeUsageColorPlan(full,JSON.parse(JSON.stringify(assignments)));
assert.deepEqual(reload.colors,plan.colors,'fallback/model assignments persist across re-render');
// Unknown models use available provider steps before folding overflow into
// that same provider's named Other series, never the historical Other grey.
const unknownDays=[{date:'2026-09-30',models:{'openai-codex/new-a':bucket(4),'openai-codex/new-b':bucket(3)},totalCostUsd:.07}];
const unknown=computeUsageColorPlan(unknownDays,{});
assert.notEqual(unknown.colors['openai-codex/new-a'].slot,unknown.colors['openai-codex/new-b'].slot,'unknown models take distinct next unused provider fallback steps');
assert.equal(unknown.colors['openai-codex/new-a'].provider,'openai','unknown fallback belongs to OpenAI');
console.log('usagePalettePairs.test.mjs: all assertions passed');
