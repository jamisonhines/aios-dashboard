import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "other-exporters-lock-"));
const helper = process.env.AIOS_EXPORT_TEST_HELPER || path.join(here, "vault-scripts", "export-json-atomic.mjs");
const worker = path.join(root, "worker.mjs");
await fs.writeFile(worker, `import { withOwnedExportLock, writeJsonAtomic } from ${JSON.stringify(new URL(`file://${helper}`).href)}; import { promises as fs } from "node:fs"; const [out, marker, started, tempStarted, delayRaw, waitRaw] = process.argv.slice(2); const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); try { const result = await withOwnedExportLock(out, async ({isOwner}) => { await fs.writeFile(started, marker); await sleep(Number(delayRaw)); await writeJsonAtomic(out, {marker, payload:"x".repeat(50000)}, {beforeRename:isOwner, onTempOpen:() => fs.writeFile(tempStarted, marker)}); }, {waitMs:Number(waitRaw)}); console.log(JSON.stringify(result)); } catch (error) { console.error(error.code+":"+error.message); process.exitCode=1; }`);
const children = new Set();
const run = (out, marker, { started = path.join(root, `${marker}.started`), tempStarted = path.join(root, `${marker}.temp-started`), delay = 0, wait = 1000, env = {} } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [worker, out, marker, started, tempStarted, String(delay), String(wait)], { env: { ...process.env, AIOS_EXPORT_TEST_MODE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(c); let stdout = "", stderr = "";
  c.stdout.on("data", d => stdout += d); c.stderr.on("data", d => stderr += d);
  c.once("exit", code => { children.delete(c); resolve({ code, stdout, stderr, started, tempStarted }); });
});
const waitFor = async (file, message) => { const deadline = Date.now() + 2000; while (!existsSync(file) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5)); assert.ok(existsSync(file), message); };
const result = (child) => JSON.parse(child.stdout.trim());
try {
 const serialize = path.join(root, "serialize.json"), aStarted = path.join(root, "serialize-a.started");
 const a = run(serialize, "serialize-A", { started: aStarted, delay: 250, wait: 1000 }); await waitFor(aStarted, "serialization fixture must observe A inside locked work before starting B");
 const b = await run(serialize, "serialize-B", { wait: 75 }); const ar = await a;
 assert.equal(ar.code, 0, `serialization A must finish: ${JSON.stringify(ar)}`); assert.equal(b.code, 0, `serialization B must return cleanly busy: ${JSON.stringify(b)}`); assert.equal(result(b).busy, true, "serialization: B must specifically report busy while A owns the lock"); assert.equal(JSON.parse(await fs.readFile(serialize, "utf8")).marker, "serialize-A", "serialization: busy B must not publish");

 // I1 differential fixture: A is deliberately held before work, so B steals first.
 // The pre-rename guard masks this pre-work assertion unless both are disabled together.
 const stolen = path.join(root, "stolen.json"), oldStarted = path.join(root, "old-A.started"), newStarted = path.join(root, "new-B.started");
 const oldA = run(stolen, "old-A", { started: oldStarted, delay: 0, wait: 1500, env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60", AIOS_EXPORT_TEST_HOLD_MS: "250" } });
 await waitFor(`${stolen}.lock/owner.json`, "pre-work fixture must observe A ownership before starting B");
 const newB = run(stolen, "new-B", { started: newStarted, delay: 350, wait: 1500, env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60" } }); await waitFor(newStarted, "pre-work fixture must observe B holding the stolen lock"); const oldResult = await oldA;
 assert.notEqual(oldResult.code, 0, `I1 old holder must fail specifically before work after steal: ${JSON.stringify(oldResult)}`); assert.match(oldResult.stderr, /AIOS_EXPORT_LOCK_LOST/, "I1 pre-work guard must name lock ownership loss"); const newResult = await newB; assert.equal(newResult.code, 0, `I1 replacement holder must publish: ${JSON.stringify(newResult)}`); assert.equal(JSON.parse(await fs.readFile(stolen, "utf8")).marker, "new-B", "I1 old holder must not overwrite B");

 // I4 downstream fixture: A clears the pre-work guard before B exists, opens its temp
 // publication, then B steals and publishes. Only the pre-rename fence can reject A.
 const fenced = path.join(root, "fenced.json"), fencedWork = path.join(root, "fenced-A.work"), fencedTemp = path.join(root, "fenced-A.temp-started"), fencedBWork = path.join(root, "fenced-B.work");
 assert.equal(path.basename(fenced), "fenced.json", "I4 fixture must pin the named snapshot resource");
 assert.equal(path.basename(fencedTemp), "fenced-A.temp-started", "I4 fixture must pin A's named temp-publication marker");
 const fencedA = run(fenced, "fenced-A", { started: fencedWork, tempStarted: fencedTemp, wait: 1500, env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60", AIOS_EXPORT_TEST_WRITE_CHUNK_DELAY_MS: "75" } });
 await waitFor(fencedWork, "I4 fixture must observe A inside work before B starts, clearing the pre-work ownership guard");
 await waitFor(fencedTemp, "I4 fixture must observe A open temp publication before B steals the lock");
 const fencedB = run(fenced, "new-B", { started: fencedBWork, wait: 1500, env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60" } });
 await waitFor(fencedBWork, "I4 fixture must observe B enter work after stealing A's stale lock");
 const fencedBR = await fencedB;
 assert.equal(fencedBR.code, 0, `I4 replacement B must publish before A reaches rename: ${JSON.stringify(fencedBR)}`);
 assert.equal(JSON.parse(await fs.readFile(fenced, "utf8")).marker, "new-B", "I4 B snapshot must exist before A resumes at the pre-rename fence");
 const fencedAR = await fencedA;
 assert.notEqual(fencedAR.code, 0, `I4 stale A must fail specifically at pre-rename fence: ${JSON.stringify(fencedAR)}`);
 assert.match(fencedAR.stderr, /AIOS_EXPORT_LOCK_LOST/, "I4 pre-rename fence must name lock ownership loss");
 assert.equal(JSON.parse(await fs.readFile(fenced, "utf8")).marker, "new-B", "I4 stale A must leave B's named snapshot intact");

 const release = path.join(root, "release.json"), releaseAStarted = path.join(root, "release-A.started"), releaseBStarted = path.join(root, "release-B.started");
 const releaseA = run(release, "release-A", { started: releaseAStarted, delay: 0, wait: 1500, env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60", AIOS_EXPORT_TEST_HOLD_MS: "250" } });
 await waitFor(`${release}.lock/owner.json`, "release fixture must observe A ownership before B starts");
 const releaseB = run(release, "release-B", { started: releaseBStarted, delay: 500, wait: 1500, env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60" } }); await waitFor(releaseBStarted, "release fixture must observe B holding replacement lock before A exits"); const releaseAR = await releaseA;
 assert.match(releaseAR.stderr, /AIOS_EXPORT_LOCK_LOST/, "release fixture requires A to lose ownership before cleanup"); const releaseC = await run(release, "release-C", { wait: 80 }); assert.equal(result(releaseC).busy, true, "I3 release guard: C must specifically stay busy while replacement B owns the lock"); const releaseBR = await releaseB; assert.equal(releaseBR.code, 0, `release B must finish: ${JSON.stringify(releaseBR)}`); assert.equal(JSON.parse(await fs.readFile(release, "utf8")).marker, "release-B", "release fixture must preserve replacement owner publication");

 const recover = path.join(root, "recover.json"), lock = `${recover}.lock`, coord = `${lock}.steal-coord`; assert.equal(path.basename(recover), "recover.json", "I2 fixture must pin the named recovery snapshot resource"); await fs.mkdir(lock, { recursive: true }); await fs.mkdir(coord); const old = new Date(Date.now() - 600000); await fs.utimes(lock, old, old); await fs.utimes(coord, old, old); const rr = await run(recover, "recovered", { env: { AIOS_EXPORT_TEST_LOCK_STALE_MS: "60" } }); assert.equal(rr.code, 0, `I2 orphaned coord must be reclaimed: ${JSON.stringify(rr)}`); assert.equal(result(rr).busy, false, `I2 orphaned coord must be reclaimed, not report busy: ${JSON.stringify(rr)}`); assert.equal(JSON.parse(await fs.readFile(recover, "utf8")).marker, "recovered"); assert.equal(existsSync(coord), false, "I2 stale coordination directory must be removed");
 console.log("other-exporter locks: serialization, stale-holder fencing, guarded release, and orphaned steal-coord recovery passed");
} finally {
 for (const child of children) child.kill("SIGTERM");
 await fs.rm(root, { recursive: true, force: true });
}
