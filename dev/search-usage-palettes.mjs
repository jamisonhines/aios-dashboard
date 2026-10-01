#!/usr/bin/env node
// Deterministic offline search. No colour generation runs in the plugin.
// Usage: node dev/search-usage-palettes.mjs <export.json> <result.json>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromLch, legalCandidate, hue, vectors, separation } from './usage-color-math.mjs';
import { rankUsageModels } from '../usageRanking.mjs';
import { usageModelProvider, usageTotalTokens } from '../model.mjs';
const providers = ['claude', 'openai', 'local'];
export const providerFor = usageModelProvider;
export function candidates(provider, mode) {
  const hues = { claude: [310,325,340,355,10,25,40,55,70,85,100], openai: [135,150,165,180,195,210,225,240,255,270,285], local: [290,295,300,305] }[provider];
  const levels = mode === 'dark' ? [.483,.528,.573,.618,.665] : [.435,.515,.595,.675,.765];
  return [...new Set(hues.flatMap(h => levels.flatMap(L => [.105,.15,.20,.25,.30].map(C => fromLch(L,C,h)))))].filter(hex => {
    const h=hue(hex);
    const inRange=provider==='claude'?(h>=310||h<=100):provider==='openai'?(h>=130&&h<=285):(h>=290&&h<310);
    return legalCandidate(hex,mode)&&inRange;
  }).map(hex => ({hex,v: vectors(hex)}));
}
// Bounded seeded farthest-point restarts followed by coordinate ascent. Scores
// maximize the worst normal Delta E, with CVD >=6 as a hard constraint. The
// feasibility phase uses the weaker normalized constraint to escape local minima.
const geometryCache = new Map();
function geometry(mode) {
  if (geometryCache.has(mode)) return geometryCache.get(mode);
  const pools = Object.fromEntries(providers.map(p => [p,candidates(p,mode)]));
  const all = providers.flatMap(p => pools[p]);
  all.forEach((candidate,id) => { candidate.id=id; });
  const normal = new Float64Array(all.length*all.length), cvd = new Float64Array(all.length*all.length);
  for(let i=0;i<all.length;i++) for(let j=0;j<=i;j++) {
    const d=separation(all[i].v,all[j].v);
    normal[i*all.length+j]=normal[j*all.length+i]=d.normal;
    cvd[i*all.length+j]=cvd[j*all.length+i]=d.cvd;
  }
  const result={pools,normal,cvd,size:all.length};
  geometryCache.set(mode,result);return result;
}
export function search(counts, mode, { restarts = 96, passes = 3 } = {}) {
  const {pools,normal:normalDistances,cvd:cvdDistances,size}=geometry(mode);
  const order = [];
  for (let i=0;i<Math.max(...Object.values(counts));i++) for(const p of ['local','claude','openai']) if(i<counts[p]) order.push(p);
  let best = {score:-Infinity, colors:[]};
  function score(chosen) {
    let normal=Infinity,cvd=Infinity;
    for(let i=0;i<chosen.length;i++) for(let j=0;j<i;j++) {const index=chosen[i].id*size+chosen[j].id;normal=Math.min(normal,normalDistances[index]);cvd=Math.min(cvd,cvdDistances[index]);}
    return {normal,cvd, feasibility: Math.min(normal/15,cvd/6)};
  }
  for(let restart=0;restart<restarts;restart++) {
    const chosen=[];
    for(const [i,p] of order.entries()) {
      if(i===0){chosen.push(pools[p][Math.floor(restart*pools[p].length/restarts)]);continue;}
      let winner=null,top=-Infinity;
      for(const c of pools[p]){const s=score([...chosen,c]);const metric=s.feasibility;
        if(metric>top){top=metric;winner=c;}}
      chosen.push(winner);
    }
    for(let pass=0;pass<passes;pass++) for(let i=0;i<chosen.length;i++) {
      const old=score(chosen);let top=old.cvd>=6&&old.normal>=15?old.normal:old.feasibility;let winner=chosen[i];
      for(const c of pools[order[i]]) {
        const changed=chosen.slice();changed[i]=c;const s=score(changed);
        const metric=old.cvd>=6&&old.normal>=15?(s.cvd>=6&&s.normal>=15?s.normal:-Infinity):s.feasibility;
        if(metric>top){top=metric;winner=c;}
      }
      chosen[i]=winner;
    }
    const s=score(chosen);const metric=s.cvd>=6&&s.normal>=15?1000+s.normal:s.feasibility;
    if(metric>best.score) best={score:metric,colors:chosen.map((c,i)=>({provider:order[i],hex:c.hex})),normal:s.normal,cvd:s.cvd};
  }
  return { ...best, ok:best.normal>=15&&best.cvd>=6, palette: Object.fromEntries(providers.map(p=>[p,best.colors.filter(c=>c.provider===p).map(c=>c.hex)])) };
}
export function design(stats) {
  const ranking=rankUsageModels(stats.days,usageModelProvider,usageTotalTokens);
  const ranked=Object.fromEntries(providers.map(p=>[p,ranking.byProvider[p]||[]]));
  const keepFor=(provider,count)=>count===ranked[provider].length ? count : Math.max(0,count-1);
  // Enumerate every allocation, not one greedy path that might over-fold a
  // provider. Local always occupies exactly one reserved displayed slot.
  const allocations=[];
  for(let claude=ranked.claude.length?1:0;claude<=ranked.claude.length;claude++) {
    for(let openai=ranked.openai.length?1:0;openai<=ranked.openai.length;openai++) {
      const kept={claude:keepFor('claude',claude),openai:keepFor('openai',openai),local:0};
      const coverage=['claude','openai'].reduce((sum,p)=>sum+ranked[p].slice(0,kept[p]).reduce((n,r)=>n+r.recentShare,0),0);
      allocations.push({counts:{claude,openai,local:1},kept,individuals:kept.claude+kept.openai,balance:Math.min(kept.claude,kept.openai),coverage});
    }
  }
  allocations.sort((a,b)=>b.individuals-a.individuals || b.balance-a.balance || b.coverage-a.coverage || b.kept.claude-a.kept.claude);
  const attempts=[],passed=[];
  let target=null;
  for(const allocation of allocations) {
    if(target!==null && allocation.individuals<target) break;
    const {counts,kept}=allocation;
    const total=Object.values(counts).reduce((a,b)=>a+b,0);
    const budget=total>12?{restarts:16,passes:1}:{restarts:96,passes:3};
    const light=search(counts,'light',budget),dark=search(counts,'dark',budget);
    attempts.push({counts,kept,individuals:allocation.individuals,budget,light:{ok:light.ok,normal:light.normal,cvd:light.cvd},dark:{ok:dark.ok,normal:dark.normal,cvd:dark.cvd}});
    console.error(JSON.stringify(attempts.at(-1)));
    if(light.ok&&dark.ok) {
      target=allocation.individuals;
      passed.push({...allocation,light,dark});
    }
  }
  if(!passed.length)throw new Error('No feasible provider palette in bounded search');
  // Maximal individual count in this bounded search; then balanced provider
  // retention, recent-share coverage and finally worst normal distance.
  passed.sort((a,b)=>b.balance-a.balance || b.coverage-a.coverage || Math.min(b.light.normal,b.dark.normal)-Math.min(a.light.normal,a.dark.normal) || b.kept.claude-a.kept.claude);
  const winner=passed[0],{counts,kept,light,dark}=winner;
  console.error('winner '+JSON.stringify({counts,kept,individuals:winner.individuals,light:{normal:light.normal,cvd:light.cvd},dark:{normal:dark.normal,cvd:dark.cvd}}));
  return {algorithm:'provider-grid-farthest-point-coordinate-ascent-recency-v2',ranking,attempts,counts,kept,individuals:winner.individuals,retained:Object.fromEntries(providers.map(p=>[p,ranked[p].slice(0,kept[p]).map(r=>r.model)])),folded:Object.fromEntries(providers.map(p=>[p,ranked[p].slice(kept[p]).map(r=>r.model)])),palettes:Object.fromEntries(providers.map(p=>[p,{light:light.palette[p],dark:dark.palette[p]}])),minimum:{light:{normal:light.normal,cvd:light.cvd},dark:{normal:dark.normal,cvd:dark.cvd}}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: search-usage-palettes.mjs <export.json> <result.json>');
  fs.writeFileSync(output,JSON.stringify(design(JSON.parse(fs.readFileSync(input,'utf8'))),null,2)+'\n');
}
