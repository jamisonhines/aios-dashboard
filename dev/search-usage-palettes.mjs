#!/usr/bin/env node
// Deterministic offline search. No colour generation runs in the plugin.
// Usage: node dev/search-usage-palettes.mjs <export.json> <result.json>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromLch, legalCandidate, hue, vectors, separation } from './usage-color-math.mjs';
const providers = ['claude', 'openai', 'local'];
export function providerFor(model) {
  return /^openai(?:-codex)?\//.test(model) ? 'openai' : /^(ollama[^/]*\/|local\/|qwen[^/]*$)/i.test(model) ? 'local' : 'claude';
}
export function candidates(provider, mode) {
  const hues = { claude: [310,325,340,355,10,25,40,55,70,85,100], openai: [135,150,165,180,195,210,225,240,255,270,285], local: [290,305,320,335] }[provider];
  const levels = mode === 'dark' ? [.483,.528,.573,.618,.665] : [.435,.515,.595,.675,.765];
  return [...new Set(hues.flatMap(h => levels.flatMap(L => [.105,.15,.20,.25,.30].map(C => fromLch(L,C,h)))))].filter(hex => {
    const h=hue(hex);
    const inRange=provider==='claude'?(h>=310||h<=100):provider==='openai'?(h>=130&&h<=285):(h>=290&&h<=335);
    return legalCandidate(hex,mode)&&inRange;
  }).map(hex => ({hex,v: vectors(hex)}));
}
// Bounded seeded farthest-point restarts followed by coordinate ascent. Scores
// maximize the worst normal Delta E, with CVD >=6 as a hard constraint. The
// feasibility phase uses the weaker normalized constraint to escape local minima.
export function search(counts, mode, { restarts = 96, passes = 3 } = {}) {
  const pools = Object.fromEntries(providers.map(p => [p,candidates(p,mode)]));
  const order = [];
  for (let i=0;i<Math.max(...Object.values(counts));i++) for(const p of ['local','claude','openai']) if(i<counts[p]) order.push(p);
  let best = {score:-Infinity, colors:[]};
  function score(chosen) {
    let normal=Infinity,cvd=Infinity;
    for(let i=0;i<chosen.length;i++) for(let j=0;j<i;j++) {const d=separation(chosen[i].v,chosen[j].v);normal=Math.min(normal,d.normal);cvd=Math.min(cvd,d.cvd);}
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
  const totals=new Map();for(const day of stats.days)for(const [model,b] of Object.entries(day.models))totals.set(model,(totals.get(model)||0)+(b.inputTokens||0)+(b.cacheReadTokens||0)+(b.cacheWriteTokens||0)+(b.outputTokens||0));
  const ranked=Object.fromEntries(providers.map(p=>[p,[...totals].filter(([k])=>providerFor(k)===p).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))]));
  // A provider Other series exists whenever tails are folded. Try the largest
  // bounded capacities first. Lower capacities fold the next-smallest token
  // share within a provider, always using the entire export, never a UI slice.
  const kept=Object.fromEntries(providers.map(p=>[p,ranked[p].length]));
  const attempts=[];
  const providerAttempts = Object.fromEntries(providers.map(p => [p, Object.fromEntries(['light','dark'].map(mode => {
    const trial=search(Object.fromEntries(providers.map(q=>[q,q===p?ranked[p].length:0])),mode);
    return [mode,{ok:trial.ok,normal:trial.normal,cvd:trial.cvd}];
  }))]));
  console.error('provider attempts '+JSON.stringify(providerAttempts));
  while(true) {
    const counts=Object.fromEntries(providers.map(p=>[p,kept[p]+(kept[p]<ranked[p].length?1:0)]));
    // Budget is fixed, not time-dependent. Try every capacity, using 8
    // restarts/one ascent pass for crowded palettes and 96/three for <=12.
    const total=Object.values(counts).reduce((a,b)=>a+b,0);
    const budget=total>12?{restarts:8,passes:1}:{restarts:96,passes:3};
    let light=search(counts,'light',budget),dark=search(counts,'dark',budget);
    attempts.push({counts, budget, light:{ok:light.ok,normal:light.normal,cvd:light.cvd},dark:{ok:dark.ok,normal:dark.normal,cvd:dark.cvd}});
    console.error(JSON.stringify(attempts.at(-1)));
    if(light?.ok&&dark?.ok) {
      for(const mode of budget.restarts===96?[]:['light','dark']) {
        const refined=search(counts,mode);
        if(refined.ok && refined.normal>(mode==='light'?light:dark).normal) {
          if(mode==='light') light=refined; else dark=refined;
        }
      }
      console.error('refined '+JSON.stringify({counts,light:{normal:light.normal,cvd:light.cvd},dark:{normal:dark.normal,cvd:dark.cvd}}));
      // Folding one identity into an otherwise empty Other group saves no
      // colour. Restore that identity; the same searched step names it.
      for(const p of providers) if(kept[p]===ranked[p].length-1)kept[p]++;
      return {algorithm:'provider-grid-farthest-point-coordinate-ascent-v1',providerAttempts,attempts,ranked,kept,folded:Object.fromEntries(providers.map(p=>[p,ranked[p].slice(kept[p]).map(([m])=>m)])),palettes:Object.fromEntries(providers.map(p=>[p,{light:light.palette[p],dark:dark.palette[p]}])),minimum:{light:{normal:light.normal,cvd:light.cvd},dark:{normal:dark.normal,cvd:dark.cvd}}};
    }
    const choices=providers.filter(p=>kept[p]>0).map(p=>({p,share:ranked[p][kept[p]-1][1]/ranked[p].reduce((s,[,n])=>s+n,0)})).sort((a,b)=>a.share-b.share||a.p.localeCompare(b.p));
    if(!choices.length)throw new Error('No feasible provider palette in bounded search');
    kept[choices[0].p]--;
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: search-usage-palettes.mjs <export.json> <result.json>');
  fs.writeFileSync(output,JSON.stringify(design(JSON.parse(fs.readFileSync(input,'utf8'))),null,2)+'\n');
}
