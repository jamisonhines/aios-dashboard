import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import esbuild from 'esbuild';
const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-popup-viewport-'));
const exported = path.join(root, '.popup-viewport-main.ts');
const entry = path.join(root, '.popup-viewport-entry.ts');
try {
  const source = fs.readFileSync('main.ts', 'utf8');
  const renderer = source.slice(source.indexOf('const SVG_NS ='), source.indexOf('// Range buttons'));
  const host = source.slice(source.indexOf('function renderUsageChartHost('), source.indexOf('function renderUsageProjectsTable('));
  fs.writeFileSync(exported, `import {usageChartFromWindow,usagePeriodBreakdown,usagePopupPosition} from './model.mjs';\n${renderer}\n${host}\nexport {renderUsageChartHost};`);
  const stub = path.join(dir, 'obsidian.mjs');
  fs.writeFileSync(stub, ['App','ItemView','Menu','Modal','Notice','Plugin','PluginSettingTab','Scope','Setting','TFile','TFolder','WorkspaceLeaf'].map(n => `export class ${n} {}`).join('\n') + '\nexport const Platform={isDesktop:false}; export const normalizePath=p=>p; export const setIcon=()=>{};');
  fs.writeFileSync(entry, `import {renderUsageChartHost} from './.popup-viewport-main';
HTMLElement.prototype.createEl = function(tag, o={}) { const e=document.createElement(tag); if(o.cls)e.className=o.cls; if(o.text)e.textContent=o.text; for(const [k,v]of Object.entries(o.attr||{}))e.setAttribute(k,v); this.appendChild(e); return e; };
HTMLElement.prototype.createDiv=function(o){return this.createEl('div',o)};
HTMLElement.prototype.createSpan=function(o){return this.createEl('span',o)};
const check=(condition,message)=>{if(!condition)throw Error(message)};
const root=document.querySelector('.aios-dashboard-root');
const scroll=document.querySelector('.aios-scroll');
const models=Object.fromEntries(Array.from({length:40},(_,i)=>['openai-codex/synthetic-'+i,{costUsd:40-i,inputTokens:100+i,cacheReadTokens:13,cacheWriteTokens:17,outputTokens:7,messages:1}]));
const day={date:'2026-10-01',models,totalCostUsd:820,totalOutputTokens:280};
const evidence=[];
try {
  for(const height of [400,290]) {
    root.style.height=height+'px'; scroll.replaceChildren();
    renderUsageChartHost(scroll,{label:'Selected day',days:[day]},{usageRange:'1d'},'cost',[]);
    const hit=scroll.querySelector('.aios-usage-column-hit');
    const viewport=scroll.getBoundingClientRect();
    hit.dispatchEvent(new MouseEvent('mouseenter',{clientX:viewport.right-10,clientY:viewport.top+30}));
    const popup=scroll.querySelector('.aios-usage-popup');
    check(popup,'hover creates popup');
    const rect=popup.getBoundingClientRect();
    check(rect.top>=viewport.top && rect.bottom<=viewport.bottom+0.5,'popup is bounded by visible scroll viewport, not dashboard root or constant height');
    const title=popup.querySelector('.aios-usage-popup-period');
    const total=popup.querySelector('.aios-usage-popup-total');
    const visible=el=>{const r=el.getBoundingClientRect();popup.style.pointerEvents='auto';const present=document.elementsFromPoint(r.left+5,r.top+r.height/2).includes(el);popup.style.pointerEvents='none';return r.top>=viewport.top && r.bottom<=viewport.bottom && present;};
    check(visible(title)&&visible(total),'period label and total are visible through real clipping ancestor');
    const titleTop=title.getBoundingClientRect().top;
    hit.dispatchEvent(new WheelEvent('wheel',{deltaY:250,cancelable:true}));
    const list=popup.querySelector('.aios-usage-popup-models');
    check(list && list.scrollTop>0,'only model list scrolls on column wheel');
    check(title.getBoundingClientRect().top===titleTop && visible(title) && visible(total),'period label and total remain fixed and visible after model-list scrolling');
    check(list.querySelectorAll('.aios-usage-popup-row').length===40,'all models remain accessible in scrollable list');
    evidence.push({paneHeight:height,viewportTop:viewport.top,viewportHeight:viewport.height,popupTop:rect.top,popupHeight:rect.height,titleTop,listScrollTop:list.scrollTop});
    hit.dispatchEvent(new MouseEvent('mouseleave'));
    check(!scroll.querySelector('.aios-usage-popup'),'popup disappears on leave');
  }
  document.getElementById('result').textContent=JSON.stringify({ok:true,evidence});
} catch(error) {document.getElementById('result').textContent=JSON.stringify({ok:false,error:error.message});}
`);
  const bundle = esbuild.buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: 'iife',
    alias: { obsidian: stub }, external: ['electron', 'child_process', 'node:*', '@codemirror/*', '@lezer/*'] }).outputFiles[0].text;
  const html = path.join(dir, 'fixture.html');
  fs.writeFileSync(html, `<style>${fs.readFileSync('styles.css','utf8')} .aios-dashboard-root{width:600px;height:400px;display:flex;flex-direction:column} .fixture-chrome{height:120px;flex:none} .aios-scroll{flex:1;min-height:0;overflow:auto}</style><div class="aios-dashboard-root"><div class="fixture-chrome"></div><div class="aios-scroll"></div></div><pre id="result"></pre><script>${bundle}</script>`);
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const shell = fs.existsSync(cache) ? fs.readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse()[0] : null;
  const chrome = process.env.CHROME_BIN || (shell ? path.join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const dump = path.join(dir, 'dump.html');
  const stdout = fs.openSync(dump, 'w');
  const stderr = fs.openSync(path.join(dir, 'chrome.log'), 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--user-data-dir='+path.join(dir,'profile'), '--dump-dom', 'file://'+html], { stdio:['ignore',stdout,stderr] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Chrome viewport fixture timed out')); }, 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Chrome exited '+code)); });
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  const output = fs.readFileSync(dump, 'utf8');
  const match=output.match(/<pre id="result">([^<]+)<\/pre>/);
  assert.ok(match, 'headless Chrome emits fixture result: '+fs.readFileSync(path.join(dir,'chrome.log'),'utf8').slice(-1500));
  const result=JSON.parse(match[1].replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  assert.equal(result.ok,true, `usagePopupViewport: ${result.error || 'visible viewport and fixed header'}`);
  console.log('usagePopupViewport.test.mjs: PASS '+JSON.stringify(result.evidence));
} finally { fs.rmSync(exported,{force:true}); fs.rmSync(entry,{force:true}); fs.rmSync(dir,{recursive:true,force:true}); }
