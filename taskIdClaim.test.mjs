import "./testFileTimeout.mjs";
// Tests for taskIdClaim.mjs (tsk-2026-09-17-021): the dashboard quick-add id-claim path.
// Proves the plugin's fs-available path can never hand out a tsk-id number the real CLI
// (Operations/scripts/mint-task-id.mjs, tsk-2026-09-17-010) has already claimed for the same
// day, that it starts above pre-existing claim folders (not just pre-existing files), and
// documents (with a deterministic reproduction) the residual non-atomicity of the no-fs
// adapter fallback. Run: node taskIdClaim.test.mjs
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  pad3,
  maxOnDiskFromBasenames,
  claimNextTaskIdFs,
  claimNextTaskIdAdapter,
  resolveNextTaskId,
  todayUTCDay,
} from "./taskIdClaim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// The real CLI. Overridable so CI environments without ~/AIOS can point elsewhere, but never
// silently skipped: a missing CLI fails the whole file loudly instead of pretending to pass.
const CLI_PATH = process.env.MINT_TASK_ID_CLI || path.join(os.homedir(), "AIOS/Operations/scripts/mint-task-id.mjs");
if (!existsSync(CLI_PATH)) {
  throw new Error(
    `taskIdClaim.test: real mint-task-id.mjs CLI not found at ${CLI_PATH}. ` +
      `Set MINT_TASK_ID_CLI to override. Refusing to skip this test silently.`
  );
}

async function makeTasksRoot() {
  // Session-unique temp root: never write into the real ~/AIOS/Operations/tasks/.id-claims.
  return fs.mkdtemp(path.join(os.tmpdir(), `taskIdClaim-${process.pid}-${Date.now()}-`));
}

function idNum(id) {
  return parseInt(id.match(/-(\d+)$/)[1], 10);
}

// --- pad3 -------------------------------------------------------------------------------
assert.equal(pad3(1), "001");
assert.equal(pad3(42), "042");
assert.equal(pad3(999), "999");

// --- maxOnDiskFromBasenames (mirrors the exact scan nextTaskId() used to run inline) ------
{
  const day = "2026-09-17";
  assert.equal(maxOnDiskFromBasenames([], day), 0, "empty vault -> 0");
  assert.equal(
    maxOnDiskFromBasenames([`tsk-${day}-003-some-slug`, `tsk-${day}-001`, "tsk-2026-09-16-999"], day),
    3,
    "max NNN for the day, other days ignored"
  );
}

// --- claimNextTaskIdFs: identifier assertion (GL-009 rule 2) -----------------------------
// A fake fsp that RECORDS every path it was asked to mkdir/readdir, so the test can assert
// the exact claim-folder identifier by name, not just that *some* mkdir happened.
function makeRecordingFsp(preExisting = []) {
  const existing = new Set(preExisting);
  const calls = [];
  return {
    calls,
    async mkdir(p, opts) {
      calls.push({ path: p, recursive: !!(opts && opts.recursive) });
      if (opts && opts.recursive) {
        existing.add(p);
        return;
      }
      if (existing.has(p)) {
        const err = new Error("EEXIST"); err.code = "EEXIST"; throw err;
      }
      existing.add(p);
    },
    async readdir(dir, opts) {
      calls.push({ path: dir, readdir: true, opts });
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Set();
      for (const full of existing) {
        if (full.startsWith(prefix)) {
          const rest = full.slice(prefix.length);
          if (rest && !rest.includes("/")) names.add(rest);
        }
      }
      return [...names].map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

{
  const fsp = makeRecordingFsp();
  const id = await claimNextTaskIdFs({
    fsp,
    basePath: "/vault",
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
  });
  assert.equal(id, "tsk-2026-09-17-001");
  const expectedLeaf = "/vault/Operations/tasks/.id-claims/2026-09-17/001";
  const leafCall = fsp.calls.find((c) => c.path === expectedLeaf && !c.recursive && !c.readdir);
  assert.ok(
    leafCall,
    `expected a non-recursive mkdir on the exact claim leaf ${expectedLeaf}, got calls: ${JSON.stringify(fsp.calls)}`
  );
}

// --- claimNextTaskIdFs: starts above pre-existing claim folders, not just disk files -----
{
  const fsp = makeRecordingFsp([
    "/vault/Operations/tasks/.id-claims/2026-09-17/003",
    "/vault/Operations/tasks/.id-claims/2026-09-17/004",
    "/vault/Operations/tasks/.id-claims/2026-09-17/005",
  ]);
  // diskMax (from vault filenames) is only 2 -- lower than the existing claims. The result
  // must respect the claims, not the (stale) disk max.
  const id = await claimNextTaskIdFs({
    fsp,
    basePath: "/vault",
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 2,
  });
  assert.equal(id, "tsk-2026-09-17-006", "must start above the highest existing claim folder, not the lower disk max");
}

// --- claimNextTaskIdFs: real-fs integration, pre-existing files + pre-existing claims ------
{
  const tasksRoot = await makeTasksRoot();
  const day = "2026-09-17";
  await fs.writeFile(path.join(tasksRoot, `tsk-${day}-002.md`), "id: dummy\n", "utf8");
  const claimsDayDir = path.join(tasksRoot, ".id-claims", day);
  await fs.mkdir(path.join(claimsDayDir, "004"), { recursive: true });
  await fs.mkdir(path.join(claimsDayDir, "005"), { recursive: true });
  // Caller (main.ts) supplies diskMax from its own vault-file scan; here that's 2 (the
  // written file above), well below the pre-existing claim folders at 004/005.
  const id = await claimNextTaskIdFs({ fsp: fs, basePath: tasksRoot, tasksRootRel: "", day, diskMax: 2 });
  assert.equal(id, `tsk-${day}-006`, "plugin path starts above existing claim folders, not just filenames");
  assert.ok(existsSync(path.join(claimsDayDir, "006")), "the claim folder for the returned id must actually exist on disk");
}

// --- Differential race: 15+ real CLI processes and 15+ plugin-path calls, same tasks root --
// NOTE (Reviewer M-1, measured): execFileSync is synchronous and blocks this loop, so the CLI
// processes are NOT actually interleaved in wall-clock time with the plugin-path calls -- all
// 15 CLI calls complete before the first plugin claim starts (CLI ids come back 001-015 in
// order, plugin ids 016-030 out of order). What this DOES prove, and what matters: the CLI
// writes claims only (never a task file) in the SAME directory the plugin claims into, and the
// plugin honours every one of those 15 claimed-but-unwritten numbers by starting at 016. Real
// plugin-vs-plugin contention (the out-of-order 016-030 run) is also exercised for free.
{
  const tasksRoot = await makeTasksRoot();
  const day = "2026-09-17";
  const N_CLI = 15;
  const N_PLUGIN = 15;

  const runs = [];
  for (let i = 0; i < N_CLI; i++) {
    runs.push(
      new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            const out = execFileSync("node", [CLI_PATH, "--day", day, "--tasks-root", tasksRoot], {
              encoding: "utf8",
            });
            resolve(out.trim().split("\n")[0]);
          } catch (err) {
            reject(err);
          }
        });
      })
    );
  }
  for (let i = 0; i < N_PLUGIN; i++) {
    runs.push(claimNextTaskIdFs({ fsp: fs, basePath: tasksRoot, tasksRootRel: "", day, diskMax: 0 }));
  }

  const ids = await Promise.all(runs);
  assert.equal(ids.length, N_CLI + N_PLUGIN, "every racer produced an id");
  const unique = new Set(ids);
  assert.equal(
    unique.size,
    N_CLI + N_PLUGIN,
    `CLI and plugin path must never hand out the same id: got ${JSON.stringify(ids)}`
  );
  const nums = ids.map(idNum).sort((a, b) => a - b);
  assert.equal(nums[0], 1, "numbering starts at 1 for an empty shared tasks root");
  assert.equal(nums[nums.length - 1], N_CLI + N_PLUGIN, "no wasted gap in this contention-free-of-other-writers run");
}

// --- claimNextTaskIdAdapter: happy path + identifier assertion --------------------------
function makeFsAdapter(root) {
  return {
    async list(relPath) {
      const dir = path.join(root, relPath);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      return {
        files: entries.filter((e) => !e.isDirectory()).map((e) => `${relPath}/${e.name}`),
        folders: entries.filter((e) => e.isDirectory()).map((e) => `${relPath}/${e.name}`),
      };
    },
    async mkdir(relPath) {
      // Measured production behaviour (2026-09-17, extracted obsidian.asar
      // FileSystemAdapter.mkdir): fsPromises.mkdir(path, {recursive:true}) -- silently
      // no-ops on an existing directory instead of throwing EEXIST. Reproduced here exactly
      // so tests against this fake exercise the real non-atomicity, not an idealized one.
      await fs.mkdir(path.join(root, relPath), { recursive: true });
    },
  };
}

{
  const tasksRoot = await makeTasksRoot();
  const day = "2026-09-17";
  const adapter = makeFsAdapter(tasksRoot);
  const id = await claimNextTaskIdAdapter({ adapter, tasksRootRel: "Operations/tasks", day, diskMax: 0 });
  assert.equal(id, `tsk-${day}-001`);
  assert.ok(
    existsSync(path.join(tasksRoot, "Operations/tasks/.id-claims", day, "001")),
    "adapter path must write the claim folder under the exact expected identifier"
  );
}

// --- claimNextTaskIdAdapter: starts above existing claims, sequential calls don't collide -
{
  const tasksRoot = await makeTasksRoot();
  const day = "2026-09-17";
  const adapter = makeFsAdapter(tasksRoot);
  const first = await claimNextTaskIdAdapter({ adapter, tasksRootRel: "Operations/tasks", day, diskMax: 5 });
  const second = await claimNextTaskIdAdapter({ adapter, tasksRootRel: "Operations/tasks", day, diskMax: 5 });
  assert.equal(first, `tsk-${day}-006`);
  assert.equal(second, `tsk-${day}-007`, "sequential (non-racing) adapter-path calls do not collide");
}

// --- claimNextTaskIdAdapter: documented residual, a genuine race DOES collide ------------
// This is not a hypothetical: it is the direct consequence of the measured adapter.mkdir
// behaviour above (recursive:true, no EEXIST). Two calls whose list() snapshots land before
// either has written a claim folder will compute the same candidate and both "succeed".
function makeBarrierAdapter(root) {
  let listCalls = 0;
  let releaseBarrier;
  const barrier = new Promise((res) => {
    releaseBarrier = res;
  });
  const inner = makeFsAdapter(root);
  return {
    async list(relPath) {
      listCalls += 1;
      if (listCalls === 1) {
        await barrier; // first caller waits for the second caller to also snapshot
      } else {
        releaseBarrier();
      }
      return inner.list(relPath);
    },
    mkdir: inner.mkdir,
  };
}

{
  const tasksRoot = await makeTasksRoot();
  const day = "2026-09-17";
  const adapter = makeBarrierAdapter(tasksRoot);
  const [a, b] = await Promise.all([
    claimNextTaskIdAdapter({ adapter, tasksRootRel: "Operations/tasks", day, diskMax: 0 }),
    claimNextTaskIdAdapter({ adapter, tasksRootRel: "Operations/tasks", day, diskMax: 0 }),
  ]);
  assert.equal(
    a,
    b,
    "residual: two concurrent no-fs adapter-path claims on the same snapshot collide (adapter.mkdir cannot report EEXIST)"
  );
}

// --- todayUTCDay: proves UTC, not local time (Reviewer M-4) -----------------------------
{
  // Fixed instant deliberately close to a UTC-day boundary: 2026-09-17T23:30:00Z. Force the
  // PROCESS's local timezone to something far from UTC (Node re-reads process.env.TZ for
  // local Date getters -- measured empirically before writing this test) so a regression from
  // getUTC* to local getters is guaranteed to be caught regardless of the runner's own TZ.
  const originalTZ = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati"; // UTC+14
  try {
    const fixed = new Date("2026-09-17T23:30:00.000Z");
    const gotUTC = todayUTCDay(fixed);
    assert.equal(gotUTC, "2026-09-17", "todayUTCDay must read the UTC calendar day");
    const pad2 = (n) => String(n).padStart(2, "0");
    const localStyleDay = `${fixed.getFullYear()}-${pad2(fixed.getMonth() + 1)}-${pad2(fixed.getDate())}`;
    assert.notEqual(
      localStyleDay,
      gotUTC,
      "sanity: at UTC+14 this instant really is a different LOCAL calendar day, so a local-time " +
        "regression in todayUTCDay would have produced localStyleDay here instead of gotUTC"
    );
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
}

// --- resolveNextTaskId: the fs-vs-adapter selection itself (Reviewer I-1) ---------------
// Direct, fast, isolated coverage of the dispatcher with every dependency faked. The
// heavier proof that main.ts's own nextTaskId() calls this correctly (right tasksRootRel,
// right getBasePath, a real Notice on a real failure) lives in nextTaskIdWiring.test.mjs,
// which bundles the actual main.ts source rather than a hand description of it.
{
  // Happy path: basePath resolves, requireFs succeeds -> atomic fs path, no Notice.
  const tasksRoot = await makeTasksRoot();
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: { getBasePath: () => tasksRoot },
    tasksRootRel: "",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => tasksRoot,
    requireFs: () => ({ promises: fs }),
    notice: (msg) => notices.push(msg),
  });
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(notices.length, 0, "the happy fs path must not raise a Notice");
  assert.ok(existsSync(path.join(tasksRoot, ".id-claims/2026-09-17/001")), "the atomic path must actually claim on disk");
}

{
  // No base path (mobile, or any adapter without one): quiet fallback to the adapter path,
  // no Notice -- this is EXPECTED, not a failure.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 3,
    getBasePath: () => undefined,
    requireFs: () => ({ promises: fs }),
    notice: (msg) => notices.push(msg),
  });
  assert.equal(id, "tsk-2026-09-17-004");
  assert.equal(notices.length, 0, "no base path is an expected condition (e.g. mobile), must stay quiet");
}

{
  // requireFs throws even though a base path resolved: still treated as "no fs here", quiet.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => "/some/vault",
    requireFs: () => {
      throw new Error("no fs module in this environment");
    },
    notice: (msg) => notices.push(msg),
  });
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(notices.length, 0, "fs genuinely unavailable is treated the same as no base path, must stay quiet");
}

{
  // Base path AND fs both look available, but the atomic claim itself throws (simulated
  // EACCES-shaped failure): this must be LOUD (Reviewer I-2) and must still fall back so task
  // creation is not blocked.
  const notices = [];
  const failingFsp = {
    async mkdir() {
      const err = new Error("EACCES: permission denied, mkdir '/vault/Operations/tasks/.id-claims'");
      err.code = "EACCES";
      throw err;
    },
    async readdir() {
      return [];
    },
  };
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 2,
    getBasePath: () => "/vault",
    requireFs: () => ({ promises: failingFsp }),
    notice: (msg) => notices.push(msg),
  });
  assert.equal(id, "tsk-2026-09-17-003", "must still hand back an id via the adapter fallback, task creation is never blocked");
  assert.equal(notices.length, 1, "an fs claim failure with fs genuinely present must raise exactly one Notice");
  assert.match(notices[0], /could not claim a task id atomically/i, "the Notice must name what failed, not a generic message");
  assert.match(notices[0], /EACCES/, "the Notice must surface the underlying error so a permissions problem is diagnosable");
}

// --- resolveNextTaskId: Platform.isDesktop-aware probe-failure loudness (round 2 I-4) -------
{
  // Desktop, but getBasePath() itself returns nothing: this is an ANOMALY on desktop, must be
  // loud, distinct from the fs-claim-throws case (I-2) which has its own message text.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => undefined,
    requireFs: () => ({ promises: fs }),
    notice: (msg) => notices.push(msg),
    isDesktop: true,
  });
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(notices.length, 1, "desktop with no resolvable base path must raise exactly one Notice");
  assert.match(notices[0], /expected an atomic task-id claim on desktop/i, "the Notice must name the desktop-specific anomaly");
}

{
  // Same probe failure, but isDesktop: false (mobile) -- must stay quiet, this is expected.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => undefined,
    requireFs: () => ({ promises: fs }),
    notice: (msg) => notices.push(msg),
    isDesktop: false,
  });
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(notices.length, 0, "the identical probe failure on mobile (isDesktop: false) must stay quiet");
}

{
  // Desktop, base path resolves, but requireFs itself throws (fs unavailable despite a base
  // path): also an anomaly on desktop, also loud, with a message distinguishing it from the
  // no-base-path case.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => "/vault",
    requireFs: () => {
      throw new Error("no fs module in this environment");
    },
    notice: (msg) => notices.push(msg),
    isDesktop: true,
  });
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(notices.length, 1, "desktop with fs unavailable despite a resolved base path must raise exactly one Notice");
  assert.match(notices[0], /fs module was unavailable/i, "the Notice must name the fs-unavailable anomaly, not the no-base-path one");
}

// --- claimNextTaskIdAdapter: a real mkdir throw is loud regardless of platform (M-3) --------
{
  const notices = [];
  const throwingAdapter = {
    async list() {
      return { files: [], folders: [] };
    },
    async mkdir() {
      throw new Error("EPERM: operation not permitted");
    },
  };
  const id = await claimNextTaskIdAdapter({
    adapter: throwingAdapter,
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
    notice: (msg) => notices.push(msg),
  });
  assert.equal(id, "tsk-2026-09-17-001", "must still hand back an id, task creation is never blocked");
  assert.equal(notices.length, 1, "an adapter mkdir throw must raise exactly one Notice (no claim folder was recorded at all)");
  assert.match(notices[0], /could not record a task-id claim/i, "the Notice must say a claim was NOT recorded, distinct from the documented recursive-mkdir residual");
  assert.match(notices[0], /EPERM/, "the Notice must surface the underlying error");
}

{
  // Same failure through the full resolveNextTaskId dispatch, mobile-shaped (isDesktop
  // false/omitted): M-3's notice must still fire even though I-4's desktop-only notice does not.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {
        throw new Error("mobile storage denied the write");
      },
    },
    tasksRootRel: "Operations/tasks",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => undefined,
    requireFs: () => ({ promises: fs }),
    notice: (msg) => notices.push(msg),
    isDesktop: false,
  });
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(notices.length, 1, "M-3's notice must fire on mobile too, even though I-4's probe-failure notice does not");
  assert.match(notices[0], /could not record a task-id claim/i);
}

// --- claimNextTaskIdFs: path traversal in tasksRootRel is rejected (M-9) --------------------
// escapedName is session-unique and cleaned up in `finally`: if the guard under test is
// broken, this test itself would otherwise create a real directory one level above a
// mkdtemp'd root and (measured: this happened once while developing this test) leave it
// behind for a later, correctly-guarded run to trip over as a false failure.
{
  const tasksRoot = await makeTasksRoot();
  const escapedName = `taskIdClaim-escaped-${process.pid}-${Date.now()}`;
  const escapedDir = path.join(path.dirname(tasksRoot), escapedName);
  try {
    await assert.rejects(
      () => claimNextTaskIdFs({ fsp: fs, basePath: tasksRoot, tasksRootRel: `../${escapedName}`, day: "2026-09-17", diskMax: 0 }),
      /refusing a tasksRoot containing/i,
      "a tasksRootRel containing .. must be rejected before any real fs call"
    );
    // Prove no directory was created anywhere outside (or inside) the temp root as a side effect.
    assert.ok(!existsSync(escapedDir), "the rejected traversal must not have created anything outside the intended root");
  } finally {
    await fs.rm(escapedDir, { recursive: true, force: true });
  }
}

{
  // Through the full dispatcher: a traversal attempt on the fs path falls back to the
  // (vault-API-confined) adapter path rather than escaping, and is loud on desktop.
  const notices = [];
  const id = await resolveNextTaskId({
    adapter: {
      async list() {
        return { files: [], folders: [] };
      },
      async mkdir() {},
    },
    tasksRootRel: "../escaped",
    day: "2026-09-17",
    diskMax: 0,
    getBasePath: () => "/vault",
    requireFs: () => ({ promises: fs }),
    notice: (msg) => notices.push(msg),
    isDesktop: true,
  });
  assert.equal(id, "tsk-2026-09-17-001", "must still resolve an id via the confined adapter path");
  assert.ok(
    notices.some((m) => /could not claim a task id atomically/i.test(m) && /refusing a tasksRoot containing/i.test(m)),
    `a rejected traversal on the atomic path must be reported via Notice, got: ${JSON.stringify(notices)}`
  );
}

console.log("taskIdClaim: all assertions passed");
