import "./testFileTimeout.mjs";
// Proves main.ts's own nextTaskId() -- not a hand description of it -- actually threads the
// caller's tasksRoot setting into the claim (Reviewer Important-1 and Important-3, d7bccc1
// review) and raises a real Obsidian Notice when the atomic claim fails despite fs looking
// available (Important-2). taskIdClaim.test.mjs proves resolveNextTaskId's own dispatch logic
// in isolation with hand-built fakes; this file proves main.ts calls it with the RIGHT
// arguments, by bundling the actual shipped main.ts source (same esbuild-bundle-with-stubbed-
// obsidian approach as coordinationRenderContract.test.mjs) rather than re-describing main.ts's
// behaviour in a fake.
//
// Before this file: taskIdClaim.mjs was fully tested, but nothing exercised main.ts:1222's
// nextTaskId itself. Reviewer measured that changing the (then-hardcoded) claim root string to
// "Operations/WRONG-ROOT" left `npm test` and `npx tsc --noEmit` both at exit 0 -- the module
// was proven, the wiring was not. Run: node nextTaskIdWiring.test.mjs
import assert from "node:assert";
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { todayUTCDay } from "./taskIdClaim.mjs";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Records every `new Notice(msg)` call so tests can assert on the exact message, not just that
// something happened (GL-009 rule 3: assert the specific failure, not a status code).
const OBSIDIAN_STUB_SOURCE = [
  "export class App {}",
  "export class ItemView {}",
  "export class Menu {}",
  "export class Modal {}",
  "let __noticeLog = [];",
  "export class Notice { constructor(msg) { __noticeLog.push(msg); } }",
  "export function __getNoticeLog() { return __noticeLog; }",
  "export function __clearNoticeLog() { __noticeLog = []; }",
  // Mutable so tests can flip desktop/mobile (round 2 Important-4) without rebuilding.
  "export const Platform = { isMobile: false, isDesktop: true };",
  "export function __setIsDesktop(v) { Platform.isDesktop = v; }",
  "export class Plugin {}",
  "export class PluginSettingTab {}",
  "export class Scope {}",
  "export class Setting {}",
  "export class TFile {}",
  "export class TFolder {}",
  "export class WorkspaceLeaf {}",
  "export const normalizePath = (p) => p;",
  "export const setIcon = () => {};",
  "",
].join("\n");

// Appended verbatim to a disposable copy of main.ts's own source. nextTaskId is the exact
// private function main.ts declares; nothing here changes what it does.
const EXPORT_APPEND =
  "\nexport {\n" +
  "  nextTaskId as __nextTaskId,\n" +
  "  createQuickTask as __createQuickTask,\n" +
  "  isoDate as __isoDate,\n" +
  "};\n" +
  'export { __getNoticeLog, __clearNoticeLog, __setIsDesktop } from "obsidian";\n';

function buildWiringBundle() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-dashboard-nexttaskid-wiring-"));
  const stubPath = path.join(tmpDir, "obsidian-stub.mjs");
  // .cjs, and format "cjs" below, deliberately matching esbuild.config.mjs's REAL production
  // format exactly (not the "esm" format coordinationRenderContract.test.mjs uses for its
  // pure-render functions). nextTaskId calls a lexically-try-wrapped `require("fs")`, which
  // only survives esbuild's bundling AND has a real `require` available at load time when the
  // output is loaded as CommonJS -- an ESM bundle has no global `require`, so a require() call
  // would silently throw and mask the very wiring this file exists to prove (measured: this
  // was the first thing this file's own test run caught).
  const outfile = path.join(tmpDir, "bundle.cjs");
  const entryName = ".next-task-id-wiring-entry.ts";
  const entryPath = path.join(REPO_ROOT, entryName);

  fs.writeFileSync(stubPath, OBSIDIAN_STUB_SOURCE);
  const mainSource = fs.readFileSync(path.join(REPO_ROOT, "main.ts"), "utf8");
  fs.writeFileSync(entryPath, mainSource + EXPORT_APPEND);

  try {
    esbuild.buildSync({
      absWorkingDir: REPO_ROOT,
      entryPoints: [entryName],
      bundle: true,
      format: "cjs",
      target: "es2018",
      treeShaking: false,
      outfile,
      // Keep in sync with esbuild.config.mjs's `external` list (minus "obsidian",
      // which is aliased to the stub above). The node:* entries are required because
      // main.ts imports agent-models-write.mjs, which statically imports node:fs and
      // node:path; without them this bundle fails to resolve while production builds fine.
      external: [
        "electron",
        "child_process",
        "node:crypto",
        "node:fs",
        "node:path",
        "@codemirror/*",
        "@lezer/*",
      ],
      alias: { obsidian: stubPath },
      logLevel: "warning",
    });
  } finally {
    fs.rmSync(entryPath, { force: true });
  }

  return { tmpDir, outfile };
}

const requireFromHere = createRequire(import.meta.url);

// Plain CommonJS require(), not a dynamic ESM import: this is genuinely a CJS bundle (matches
// the real esbuild.config.mjs output format), and require() gives the real module.exports
// object directly rather than depending on Node's cjs-module-lexer static named-export
// detection guessing right for esbuild's generated export shape (measured: it didn't).
function loadWiringModule() {
  const { tmpDir, outfile } = buildWiringBundle();
  try {
    return requireFromHere(outfile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeFakeApp(basePath) {
  return {
    vault: {
      getMarkdownFiles: () => [],
      adapter: {
        getBasePath: () => basePath,
      },
    },
  };
}

const mod = loadWiringModule();
const {
  __nextTaskId: nextTaskId,
  __createQuickTask: createQuickTask,
  __isoDate: isoDate,
  __getNoticeLog: getNoticeLog,
  __clearNoticeLog: clearNoticeLog,
  __setIsDesktop: setIsDesktop,
} = mod;

async function makeVaultDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "nextTaskIdWiring-vault-"));
}

function makeFakeAppForQuickTask(vaultDir) {
  const created = [];
  return {
    _created: created,
    vault: {
      getMarkdownFiles: () => [],
      adapter: {
        getBasePath: () => vaultDir,
        exists: async () => true, // pretend every ensureFolder segment already exists
      },
      createFolder: async () => {},
      create: async (p, content) => {
        created.push({ path: p, content });
        return { path: p };
      },
    },
  };
}

// --- The caller's tasksRoot argument is actually used as the claim root, not a hardcoded one -
{
  clearNoticeLog();
  const vault = await makeVaultDir();
  const id = await nextTaskId(makeFakeApp(vault), "Operations/tasks", "2026-09-17");
  assert.equal(id, "tsk-2026-09-17-001");
  assert.ok(
    fs.existsSync(path.join(vault, "Operations/tasks/.id-claims/2026-09-17/001")),
    "must claim under <basePath>/<the exact tasksRoot argument>/.id-claims/<day>/<NNN>"
  );
  assert.equal(getNoticeLog().length, 0, "the happy path must not raise a Notice");
}

// --- A DIFFERENT tasksRoot argument claims under a DIFFERENT root (proves it is threaded, --
// --- not hardcoded: Important-3). A hardcoded "Operations/tasks" would fail this. -----------
{
  clearNoticeLog();
  const vault = await makeVaultDir();
  const id = await nextTaskId(makeFakeApp(vault), "Custom/TasksRoot", "2026-09-17");
  assert.equal(id, "tsk-2026-09-17-001");
  assert.ok(
    fs.existsSync(path.join(vault, "Custom/TasksRoot/.id-claims/2026-09-17/001")),
    "must claim under the caller's own tasksRoot setting, not a hardcoded Operations/tasks"
  );
  assert.ok(
    !fs.existsSync(path.join(vault, "Operations/tasks")),
    "must NOT also (or instead) claim under Operations/tasks when the caller's setting is different"
  );
}

// --- getBasePath() resolving to nothing (mobile-shaped adapter) still returns an id, quietly -
{
  clearNoticeLog();
  setIsDesktop(false); // genuinely mobile-shaped for this test; restored below
  const id = await nextTaskId(
    {
      vault: {
        getMarkdownFiles: () => [],
        adapter: {
          getBasePath: () => undefined,
          async list() {
            return { files: [], folders: [] };
          },
          async mkdir() {},
        },
      },
    },
    "Operations/tasks",
    "2026-09-17"
  );
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(getNoticeLog().length, 0, "no base path is expected (mobile), must stay quiet");
  setIsDesktop(true); // restore default for the tests below
}

// --- A real fs failure on the atomic path raises a real Notice via main.ts's own wiring -----
{
  clearNoticeLog();
  const vault = await makeVaultDir();
  // Make the claim root itself a FILE, not a directory: fs.mkdir(..., {recursive:true}) on
  // .../Blocked/.id-claims/<day> then fails with ENOTDIR, not EEXIST -- a genuine fs error the
  // atomic path cannot swallow into a retry.
  fs.writeFileSync(path.join(vault, "Blocked"), "not a directory");
  const id = await nextTaskId(
    {
      vault: {
        getMarkdownFiles: () => [],
        adapter: {
          getBasePath: () => vault,
          async list() {
            return { files: [], folders: [] };
          },
          async mkdir() {},
        },
      },
    },
    "Blocked",
    "2026-09-17"
  );
  assert.equal(id, "tsk-2026-09-17-001", "must still return an id via the adapter fallback, never block task creation");
  const notices = getNoticeLog();
  assert.equal(notices.length, 1, "a real fs failure with fs genuinely present must raise exactly one Notice");
  assert.match(notices[0], /could not claim a task id atomically/i, "the Notice must name what failed");
  assert.match(notices[0], /ENOTDIR|ENOENT|EEXIST|not a directory/i, "the Notice must surface the underlying fs error");
}

// --- Platform.isDesktop wiring: main.ts's own nextTaskId reads Platform.isDesktop (I-4) -----
{
  clearNoticeLog();
  setIsDesktop(true);
  const id = await nextTaskId(
    {
      vault: {
        getMarkdownFiles: () => [],
        adapter: {
          getBasePath: () => undefined,
          async list() {
            return { files: [], folders: [] };
          },
          async mkdir() {},
        },
      },
    },
    "Operations/tasks",
    "2026-09-17"
  );
  assert.equal(id, "tsk-2026-09-17-001");
  const notices = getNoticeLog();
  assert.equal(notices.length, 1, "main.ts must pass Platform.isDesktop=true through: a desktop probe failure must be loud");
  assert.match(notices[0], /expected an atomic task-id claim on desktop/i);
  setIsDesktop(true); // restore default for later tests in this file
}

{
  clearNoticeLog();
  setIsDesktop(false);
  const id = await nextTaskId(
    {
      vault: {
        getMarkdownFiles: () => [],
        adapter: {
          getBasePath: () => undefined,
          async list() {
            return { files: [], folders: [] };
          },
          async mkdir() {},
        },
      },
    },
    "Operations/tasks",
    "2026-09-17"
  );
  assert.equal(id, "tsk-2026-09-17-001");
  assert.equal(getNoticeLog().length, 0, "main.ts must pass Platform.isDesktop=false through: the same probe failure on mobile stays quiet");
  setIsDesktop(true); // restore default
}

// --- createQuickTask: claim root and write root are the SAME setting (round 2 Important-5) --
// Round 1 proved the module (resolveNextTaskId) never diverges when given the right root.
// Round 2 Reviewer's point: nothing proved main.ts:1270-1272 (createQuickTask's own call to
// nextTaskId, and its own `${tasksRoot}/open` write) actually pass the SAME root to both.
// Reviewer's own reproduction: hardcoding nextTaskId's second argument to "Operations/tasks"
// there while the write path kept using the real `tasksRoot` parameter left `npm test` green.
{
  clearNoticeLog();
  const vault = await makeVaultDir();
  const app = makeFakeAppForQuickTask(vault);
  const today = new Date().toISOString().slice(0, 10); // createQuickTask uses the real clock
  const result = await createQuickTask(app, "Custom/Root", {
    title: "Wiring test task",
    project: null,
    phase: null,
    keyElement: null,
  });
  assert.ok(result, "createQuickTask must succeed against a fake vault.create");
  assert.equal(app._created.length, 1, "exactly one file must be created");
  const writtenPath = app._created[0].path;
  assert.match(writtenPath, /^Custom\/Root\/open\/tsk-\d{4}-\d{2}-\d{2}-\d{3}-wiring-test-task\.md$/, "sanity: written under the caller's own tasksRoot");
  assert.ok(
    fs.existsSync(path.join(vault, "Custom/Root/.id-claims", today, "001")),
    "the claim must be filed under the SAME root the file was written under (Custom/Root), not a hardcoded one"
  );
  assert.ok(
    !fs.existsSync(path.join(vault, "Operations/tasks")),
    "must not also (or instead) claim under Operations/tasks when the real tasksRoot setting is different"
  );
}

// --- isoDate() must stay converged with todayUTCDay() (Reviewer round 2, M-6) ---------------
// Before the M-6 fix, isoDate() (main.ts) and todayUTCDay() (taskIdClaim.mjs) were two
// independent implementations of the same UTC-day fact, only one of which was pinned by a
// test; main.ts's isoDate() now just delegates. isoDate() takes no injectable clock, so this
// pins the PROCESS's timezone (Node re-reads process.env.TZ for local Date getters, measured
// earlier in this task) far from UTC and calls both back-to-back at real "now": a reintroduced
// independent, locally-clocked isoDate() would disagree with todayUTCDay() at this instant.
{
  const originalTZ = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati"; // UTC+14
  try {
    const gotIsoDate = isoDate();
    const gotTodayUTCDay = todayUTCDay();
    assert.equal(
      gotIsoDate,
      gotTodayUTCDay,
      "isoDate() and todayUTCDay() must never disagree -- isoDate() should delegate, not re-implement"
    );
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
}

console.log("nextTaskIdWiring: all assertions passed");
