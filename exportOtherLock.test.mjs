import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "other-exporters-lock-"));
const helper = path.join(here, "vault-scripts", "export-json-atomic.mjs");
const worker = path.join(root, "worker.mjs");
await fs.writeFile(worker, `import { withOwnedExportLock, writeJsonAtomic } from ${JSON.stringify(new URL(`file://${helper}`).href)}; import path from "node:path"; const [out, marker] = process.argv.slice(2); try { const r = await withOwnedExportLock(out, ({isOwner}) => writeJsonAtomic(out, {marker, payload:"x".repeat(50000)}, {beforeRename:isOwner}), {waitMs:3000}); console.log(JSON.stringify(r)); } catch (e) { console.error(e.code+":"+e.message); process.exitCode=1; }`);
const run = (out, marker, env = {}) => new Promise((resolve) => { const c = spawn(process.execPath, [worker, out, marker], {env:{...process.env,...env},stdio:["ignore","pipe","pipe"]}); let stdout="",stderr=""; c.stdout.on("data",d=>stdout+=d);c.stderr.on("data",d=>stderr+=d);c.once("exit",code=>resolve({code,stdout,stderr})); });
try {
 const out=path.join(root,"publish.json");
 const a=run(out,"old-A",{AIOS_EXPORT_TEST_LOCK_STALE_MS:"60",AIOS_EXPORT_TEST_WRITE_CHUNK_DELAY_MS:"40"});
 await new Promise(r=>setTimeout(r,100)); const b=await run(out,"new-B",{AIOS_EXPORT_TEST_LOCK_STALE_MS:"60"}); const ar=await a;
 assert.equal(b.code,0,`I1 B must publish: ${JSON.stringify(b)}`); assert.notEqual(ar.code,0,`I1 old holder must fail specifically after steal: ${JSON.stringify(ar)}`); assert.match(ar.stderr,/AIOS_EXPORT_LOCK_LOST/,"I1 must name lock ownership loss"); assert.equal(JSON.parse(await fs.readFile(out,"utf8")).marker,"new-B","I1 old holder must not overwrite B");
 const recover=path.join(root,"recover.json"), lock=`${recover}.lock`,coord=`${lock}.steal-coord`; await fs.mkdir(lock,{recursive:true}); await fs.mkdir(coord); const old=new Date(Date.now()-600000); await fs.utimes(lock,old,old); await fs.utimes(coord,old,old); const rr=await run(recover,"recovered",{AIOS_EXPORT_TEST_LOCK_STALE_MS:"60"}); assert.equal(rr.code,0,`I2 orphaned coord must be reclaimed: ${JSON.stringify(rr)}`); assert.equal(JSON.parse(await fs.readFile(recover,"utf8")).marker,"recovered"); assert.equal(existsSync(coord),false,"I2 stale coordination directory must be removed");
 console.log("other-exporter locks: stolen holder fenced and orphaned steal-coord recovered");
} finally { await fs.rm(root,{recursive:true,force:true}); }
