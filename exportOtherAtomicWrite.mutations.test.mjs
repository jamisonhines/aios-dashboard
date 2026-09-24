import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "other-exporters-mutation-"));
const copy = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "other-exporters-mutation-copy-")));
const helperPath = path.join(here, "vault-scripts", "export-json-atomic.mjs");
const helper = await fs.readFile(helperPath, "utf8");
const renameNeedle = "    await fs.rename(tempPath, filePath);";
assert.ok(helper.includes(renameNeedle), "mutation anchor must be executable atomic rename");
const slowLiveWrite = "    await fs.writeFile(filePath, \"\");\n    for (let start = 0; start < json.length; start += 64) { await fs.appendFile(filePath, json.slice(start, start + 64)); await sleep(10); }";
const makeHome = async (base) => { const home=path.join(base,"home"), bin=path.join(base,"bin"); await fs.mkdir(path.join(home,".claude","skills","synthetic-skill"),{recursive:true}); await fs.mkdir(path.join(home,".pi","agent"),{recursive:true}); await fs.mkdir(path.join(home,"Library","LaunchAgents"),{recursive:true}); await fs.mkdir(bin,{recursive:true}); await fs.writeFile(path.join(home,".claude","skills","synthetic-skill","SKILL.md"),"---\nname: synthetic-skill\n---\nfixture"); await fs.writeFile(path.join(home,".pi","agent","settings.json"),"{}"); await fs.writeFile(path.join(home,".pi","agent","models-store.json"),JSON.stringify({providers:{synthetic:{models:["fixture-model"]}}})); await fs.writeFile(path.join(home,"Library","LaunchAgents","com.aios.synthetic.fixture.plist"),"fixture"); await fs.writeFile(path.join(bin,"launchctl"),"#!/bin/sh\nprintf '123\\t0\\tcom.aios.synthetic.fixture\\n'\n"); await fs.writeFile(path.join(bin,"plutil"),"#!/bin/sh\nprintf '{\"Label\":\"com.aios.synthetic.fixture\",\"StartInterval\":60}'\n"); await fs.chmod(path.join(bin,"launchctl"),0o755); await fs.chmod(path.join(bin,"plutil"),0o755); return {HOME:home,PATH:bin}; };
const run = (script, vault, env) => new Promise(resolve => { const child=spawn(process.execPath,[script,vault],{env:{...process.env,AIOS_EXPORT_TEST_MODE:"1",...env},stdio:["ignore","pipe","pipe"]}); let stderr=""; child.stderr.on("data",d=>stderr+=d); child.once("exit",code=>resolve({code,stderr})); });
try {
  await fs.writeFile(path.join(copy,"export-json-atomic.mjs"),helper.replace(renameNeedle,slowLiveWrite));
  for (const name of ["export-ops-map.mjs","export-automation-health.mjs","export-agent-models.mjs"]) await fs.copyFile(path.join(here,"vault-scripts",name),path.join(copy,name));
  const env=await makeHome(root);
  const cases=[["export-ops-map.mjs","ops-map.json","Operations"],["export-automation-health.mjs","automation-health.json",path.join("Operations","usage")],["export-agent-models.mjs","agent-models.json","Operations"]];
  for (const [script,fileName,dir] of cases) {
    const vault=path.join(root,`${fileName}-vault`); await fs.mkdir(path.join(vault,".claude","agents"),{recursive:true}); await fs.mkdir(path.join(vault,".pi","agents"),{recursive:true}); await fs.writeFile(path.join(vault,".claude","agents","synthetic.md"),"---\nname: Synthetic\n---"); await fs.writeFile(path.join(vault,".pi","agents","synthetic.md"),"---\nname: Synthetic Agent\nmodel: synthetic/fixture-model\n---"); const out=path.join(vault,dir,fileName); let invalid=false,polling=true,reads=0;
    const reader=(async()=>{while(polling){try{reads++;JSON.parse(await fs.readFile(out,"utf8"));}catch(error){if(error?.code!=="ENOENT") invalid=true;}await new Promise(r=>setTimeout(r,1));}})();
    const results=await Promise.all(Array.from({length:3},()=>run(path.join(copy,script),vault,{...env,AIOS_EXPORT_TEST_WRITE_CHUNK_DELAY_MS:"20"}))); polling=false; await reader;
    assert.deepEqual(results.map(r=>r.code),[0,0,0],`${fileName}: mutated writers must exit cleanly so the reader failure identifies atomic publication`); assert.ok(reads>0,`${fileName}: concurrent reader must actually poll the named resource`); assert.equal(invalid,true,`MUTATION CHECK ${fileName}: replacing atomic rename with direct live write must expose invalid JSON to a concurrent reader`); console.log(`MUTATION (${fileName} atomic rename removed): concurrent reader observed invalid live JSON.`);
  }
  // Differential proof: the later beforeRename owner check can reject old A after the
  // pre-work guard is removed. Disable that masking guard with the pre-work mutation;
  // a green single mutation would be disarmed evidence, not proof of the earlier guard.
  const mutationCases=[
    ["pre-work owner check", "    if (!(await isOwner())) throw lostLockError();\n", "I1 old holder must fail specifically before work after steal", (source) => source.replace("    if (beforeRename && !(await beforeRename())) throw lostLockError();\n", "").replace("    if (!(await isOwner())) throw lostLockError();\n", "")],
    // A bad release deletes B's lock, which otherwise makes B's later beforeRename guard fail
    // before C can observe the release defect. Disable that masking guard alongside this mutation.
    ["release owner check", "    if (token && await isOwner()) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});", "I3 release guard: C must specifically stay busy while replacement B owns the lock", (source) => source.replace("    if (beforeRename && !(await beforeRename())) throw lostLockError();\n", "").replace("    if (token && await isOwner()) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});", "    if (token) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});")],
  ];
  for (const [label,needle,failure,mutate] of mutationCases) { assert.ok(helper.includes(needle),`${label} mutation anchor must exist`); const mutated=path.join(copy,`helper-${label.replaceAll(" ","-")}.mjs`); const source=mutate(helper); assert.notEqual(source,helper,`${label} mutation must change executable helper code`); await fs.writeFile(mutated,source); const child=await new Promise(resolve=>{const c=spawn(process.execPath,[path.join(here,"exportOtherLock.test.mjs")],{env:{...process.env,AIOS_EXPORT_TEST_MODE:"1",AIOS_EXPORT_TEST_HELPER:mutated},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";c.stdout.on("data",d=>stdout+=d);c.stderr.on("data",d=>stderr+=d);c.once("exit",code=>resolve({code,stdout,stderr}));}); assert.notEqual(child.code,0,`MUTATION CHECK ${label}: isolated helper mutation must make the real-process lock suite red`); assert.match(child.stderr,new RegExp(failure),`MUTATION CHECK ${label}: failure must specifically identify its own lock assertion, got ${JSON.stringify(child)}`); const failLine=child.stderr.split("\n").find((line)=>line.includes(failure)); console.log(`MUTATION FAIL (${label} removed): ${failLine}`); console.log(`MUTATION (${label} removed): ${failure}`); }
} finally { await fs.rm(root,{recursive:true,force:true}); await fs.rm(copy,{recursive:true,force:true}); }
