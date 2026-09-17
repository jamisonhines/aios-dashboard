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

// --- Differential race: 15+ real CLI processes interleaved with 15+ plugin-path calls -----
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

console.log("taskIdClaim: all assertions passed");
