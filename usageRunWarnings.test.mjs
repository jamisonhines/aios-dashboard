// tsk-2026-09-17-024 round 2, Important 3: the Usage tab's run-health warning (invalid/absent
// snapshot, last-export-failed) had no test at all -- Reviewer round 1 measured that mutating
// the gating condition at main.ts:3452 (`if (readState === "invalid" || lastRunFailed) {` ->
// `if (false) {`) left `npm test` at exit 0, all files passing.
//
// This file proves three things, each with a DIFFERENT test:
//   1. usageRunWarnings (model.mjs, pure) computes the right messages for every case --
//      "absent"/"invalid"/"ok"/undefined readState, and every lastRunFailed edge case.
//   2. renderUsageRunWarnings (main.ts) renders exactly those messages into the DOM, and
//      renders nothing when there is nothing to warn about.
//   3. renderUsageTab's draw() ACTUALLY WIRES the two together in a real, full runtime
//      execution of the shipped code -- not a source-text check. An earlier draft of this
//      file used a source-slice regex assertion instead (matching this codebase's convention
//      elsewhere, e.g. usageModel.test.mjs's `table = source.slice(...)` checks) and it was
//      WRONG: wrapping the real call in `if (false) renderUsageRunWarnings(...)` (textually
//      identical to Reviewer's own mutation) still contains the literal call text, so a regex
//      match on source stayed GREEN under that exact mutation -- caught only by actually
//      trying the mutation before trusting the test, not by reasoning about it. Getting a real
//      renderUsageTab render to completion required stubbing considerably more of Obsidian's
//      DOM extensions (setAttr/addClass/classList, document.createElementNS for the SVG
//      chart, ResizeObserver, ...) than usageTokenTableRender.test.mjs's lighter stub needs,
//      because draw() renders the whole tab, not one isolated table. Bundled from the REAL
//      shipped main.ts (same stub-obsidian approach as usageTokenTableRender.test.mjs and
//      nextTaskIdWiring.test.mjs), never a hand copy of any renderer.
//
// Mutation proof (GL-009): `if (false)`-wrapping the real call in main.ts's draw() reds test
// #3 below with the warning div genuinely absent from the rendered tree -- a real behavioral
// RED, not a text-match RED. Captured output recorded in the round-2 build log
// (~/AIOS/Projects/aios-dashboard/2026-09-18-usage-exporter-atomic-write-review.md).
// Run: node usageRunWarnings.test.mjs (part of the default `npm test` suite -- every mutation
// proof in this file, R2-I1's and R3-M1's, is deterministic and stays in the default suite; see
// exportUsageAtomicWrite.mutations.test.mjs / `npm run test:mutations` for the SEPARATE,
// opt-in, exporter-side mutation suite this file has nothing to do with).
//
// R3-M1 (round 4, Reviewer round 3 Minor): mutation proofs added here for the
// `refreshTriggeredForThisLoad` guard and the `lastRefreshWasBusy` flag NEVER touch the
// tracked main.ts on disk (same R3-I1 discipline as the exporter-side fix, applied here to the
// UI source) -- `renderUsageTabToCompletion`'s `mutateSource` option applies a string
// transform to main.ts's SOURCE TEXT before it is written into the temp file that gets
// bundled. `git status`/a file hash on main.ts is unaffected by running this file, including
// under a SIGINT.
import assert from "node:assert";
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { usageRunWarnings } from "./model.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

// --- 1. usageRunWarnings (pure, no bundling needed) -----------------------------------------
{
  assert.deepEqual(usageRunWarnings(undefined, null), [], "no readState, no runStatus -> no warnings");
  assert.deepEqual(usageRunWarnings("ok", null), [], "a healthy read with no runStatus -> no warnings");
  assert.deepEqual(
    usageRunWarnings("ok", { lastAttemptAt: "2026-09-18T10:00:00.000Z", lastSuccessAt: "2026-09-18T10:00:00.000Z", lastError: null }),
    [],
    "a healthy read with a clean run status -> no warnings"
  );
  assert.deepEqual(
    usageRunWarnings("invalid", null),
    ["The snapshot file on disk is unreadable or invalid; showing the last known-good snapshot from this session."],
    "invalid readState alone warns, identifying the invalid-snapshot condition by name (GL-009 rule 3)"
  );
  // Minor 6: "absent" must be surfaced, not silently treated the same as a healthy read.
  assert.deepEqual(
    usageRunWarnings("absent", null),
    ["No snapshot file exists on disk yet; showing the last known-good snapshot from this session."],
    "absent readState alone warns with its own distinct message, not the invalid-snapshot one"
  );
  assert.deepEqual(
    usageRunWarnings("ok", { lastAttemptAt: "2026-09-18T10:05:00.000Z", lastSuccessAt: null, lastError: "boom: disk full" }),
    ["The last export attempt failed: boom: disk full"],
    "a run status with an error and no prior success warns, naming the exact error (GL-009 rule 3)"
  );
  assert.deepEqual(
    usageRunWarnings("ok", { lastAttemptAt: "2026-09-18T10:05:00.000Z", lastSuccessAt: "2026-09-18T10:00:00.000Z", lastError: "boom: disk full" }),
    ["The last export attempt failed: boom: disk full"],
    "a failure AFTER the last success warns -- the failed attempt is newer"
  );
  assert.deepEqual(
    usageRunWarnings("ok", { lastAttemptAt: "2026-09-18T10:00:00.000Z", lastSuccessAt: "2026-09-18T10:05:00.000Z", lastError: "stale error from before the last success" }),
    [],
    "a lastError timestamped BEFORE the most recent success must not warn -- it is a stale record of an already-superseded failure, not the outcome of the LAST attempt"
  );
  assert.deepEqual(
    usageRunWarnings("invalid", { lastAttemptAt: "2026-09-18T10:05:00.000Z", lastSuccessAt: null, lastError: "boom" }),
    [
      "The snapshot file on disk is unreadable or invalid; showing the last known-good snapshot from this session.",
      "The last export attempt failed: boom",
    ],
    "both conditions can fire together, invalid-snapshot message first"
  );
  console.log("usageRunWarnings (pure): all cases correct");
}

// --- 2. renderUsageRunWarnings (main.ts, DOM) -----------------------------------------------
function el(tag = "div", options = {}) {
  const node = {
    tag,
    children: [],
    text: options.text ?? "",
    cls: options.cls ?? "",
    createDiv(o = {}) {
      const child = el("div", o);
      this.children.push(child);
      return child;
    },
    setText(t) {
      this.text = t;
    },
  };
  return node;
}

function buildStubbedBundle(exportLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-run-warnings-render-"));
  const stub = path.join(dir, "obsidian.mjs");
  const entryName = ".usage-run-warnings-render-entry.ts";
  const entry = path.join(root, entryName);
  const out = path.join(dir, "out.mjs");
  fs.writeFileSync(
    stub,
    [
      "export class App {}",
      "export class ItemView {}",
      "export class Menu {}",
      "export class Modal {}",
      "export class Notice {}",
      "export const Platform = { isDesktop: false };",
      "export class Plugin {}",
      "export class PluginSettingTab {}",
      "export class Scope {}",
      "export class Setting {}",
      "export class TFile {}",
      "export class TFolder {}",
      "export class WorkspaceLeaf {}",
      "export const normalizePath = (p) => p;",
      "export const setIcon = () => {};",
    ].join("\n")
  );
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, "main.ts"), "utf8") + exportLine);
  try {
    esbuild.buildSync({
      absWorkingDir: root,
      entryPoints: [entryName],
      bundle: true,
      format: "esm",
      outfile: out,
      treeShaking: false,
      external: ["electron", "child_process", "node:crypto", "node:fs", "node:path", "@codemirror/*", "@lezer/*"],
      alias: { obsidian: stub },
    });
  } finally {
    fs.rmSync(entry, { force: true });
  }
  return out;
}

{
  const out = buildStubbedBundle("\nexport { renderUsageRunWarnings as __renderUsageRunWarnings };\n");
  const { __renderUsageRunWarnings: renderUsageRunWarnings } = await import(pathToFileURL(out).href);

  const emptyHost = el();
  renderUsageRunWarnings(emptyHost, []);
  assert.equal(emptyHost.children.length, 0, "no messages -> nothing rendered");

  const oneHost = el();
  renderUsageRunWarnings(oneHost, ["The snapshot file on disk is unreadable or invalid; showing the last known-good snapshot from this session."]);
  assert.equal(oneHost.children.length, 1, "one message -> exactly one warning div");
  assert.equal(oneHost.children[0].cls, "aios-budget-warn", "reuses the existing warning style, no new CSS (round 1 design constraint)");
  assert.equal(
    oneHost.children[0].text,
    "The snapshot file on disk is unreadable or invalid; showing the last known-good snapshot from this session.",
    "renders the message verbatim"
  );

  const twoHost = el();
  renderUsageRunWarnings(twoHost, ["First.", "Second."]);
  assert.equal(twoHost.children.length, 1, "multiple messages still render as a single warning div");
  assert.equal(twoHost.children[0].text, "First. Second.", "multiple messages join with a space, same as the original inline implementation");
  console.log("renderUsageRunWarnings (DOM): all cases correct");
}

// --- 3. Wiring: a REAL renderUsageTab render, executed to completion, shows the warning -----
// Minimal-but-sufficient fake DOM/Obsidian-extension surface for draw() to run all the way
// through (tiles, SVG chart, legend, models table, workflows, skills, projects, footer) without
// throwing. Broader than usageTokenTableRender.test.mjs's stub because that file only exercises
// one isolated table renderer; this one runs the whole tab.
// Module-level creation log (reset per test with resetCreationLog()): records {cls, tag, text}
// at the EXACT INSTANT each element is created, before any later .setText() mutates it in
// place. Needed because renderUsageTab's own auto-refresh-on-stale-load path
// (`if (stale && !refreshTriggeredForThisLoad) void doRefresh();`) runs SYNCHRONOUSLY inside
// the same draw() call that creates refreshStatus: doRefresh's first lines
// (`refreshStatus.setText("Refreshing usage snapshot...")`) execute before draw() even
// returns, so by the time any test can inspect the settled tree, a stale snapshot's
// "Generated ... (stale)" text has ALREADY been overwritten -- not a test race, a genuine
// synchronous same-tick overwrite in the real code path. The creation log sidesteps this by
// capturing what draw() actually COMPUTED and rendered at creation time, which is the
// structural property R2-I1 is about (were these elements created/populated correctly on
// every redraw, not wiped) rather than "did a fake stubbed refresh network call happen to
// lose a race," which is not what this task is testing.
let creationLog = [];
function resetCreationLog() {
  creationLog = [];
}

// R3-M1 (Reviewer round 3): the render harness had no `basePath` on its fake adapter, so
// `refreshUsageSnapshot`'s own `if (typeof basePath !== "string") throw ...` guard rejected
// every refresh immediately -- neither the busy path nor the redraw-after-refresh path (where
// the `refreshTriggeredForThisLoad` and `lastRefreshWasBusy` guards actually do their work)
// ever ran under test. `spawnLog`/`installFakeChildProcess` below give the harness a
// controllable fake exporter launch that can return busy, success, or failure outcomes, so
// those paths can be driven and observed for real.
//
// Mechanism: main.ts's `refreshUsageSnapshot` calls `require("child_process").spawn(...)`.
// esbuild (even with "child_process" marked external) compiles a bare `require(...)` call
// into a small shim, `__require`, that checks `typeof require !== "undefined"` and falls back
// to the real global `require` if so -- confirmed by inspecting the actual bundled output, not
// assumed. Setting `globalThis.require` before the bundle runs makes that bare identifier
// resolve to this fake, since unqualified identifier lookup falls through to the global object.
let spawnLog = [];
function resetSpawnLog() {
  spawnLog = [];
}
function installFakeChildProcess(spawnOutcomeProvider, { fsExists = null } = {}) {
  globalThis.require = (id) => {
    // tsk-2026-09-18-020: refreshUsageSnapshot resolves a real node binary (resolveNodeForExporter
    // -> resolveExporterLaunch in model.mjs) BEFORE spawning. That resolution's own correctness
    // is unit-tested directly against model.mjs elsewhere (pure function, no fs); here it only
    // needs to succeed trivially so the fake child_process.spawn below is reached at all -- these
    // tests are about the launcher's WIRING (one launch, dedup, immediate re-render, error
    // surfacing), not about which real path gets picked on this machine. `fsExists`, when given,
    // overrides the default "everything exists" fake -- round 2's I3 wiring tests use this to
    // control exactly which candidate path resolveNodeForExporter picks, and to simulate "no
    // node found anywhere".
    if (id === "fs") {
      return {
        existsSync: fsExists || (() => true),
        readFileSync: () => "24.14.1",
        readdirSync: () => ["v24.14.1"],
      };
    }
    if (id === "os") {
      return { homedir: () => "/fake/home" };
    }
    if (id === "child_process") {
      return {
        spawn(command, args) {
          const callIndex = spawnLog.length;
          // Round 2, Reviewer Important I3 (Coder contract rule 2): the command and args are
          // RECORDED, not discarded -- a mock that drops the identifier argument makes the
          // identifier untested by construction. Every existing test that only reads
          // `callIndex`/`spawnLog.length` is unaffected by these extra fields.
          spawnLog.push({ callIndex, command, args });
          const listeners = { data: [], error: [], exit: [] };
          const errListeners = [];
          const child = {
            stdout: {
              on(event, cb) {
                if (event === "data") listeners.data.push(cb);
              },
            },
            // tsk-2026-09-18-020: real (not omitted) so a spawnOutcomeProvider can supply
            // `stderr` and exercise refreshUsageSnapshot's real first-stderr-line extraction,
            // same "test the real wiring" discipline as everything else in this stub.
            stderr: {
              on(event, cb) {
                if (event === "data") errListeners.push(cb);
              },
            },
            once(event, cb) {
              (listeners[event] ||= []).push(cb);
            },
            // Round 2, I1: refreshUsageSnapshot's timeout handler calls child.kill() -- a no-op
            // here is enough (the timeout tests below use their own dedicated fake, see I1
            // block) since production code already tolerates a throwing/missing kill via
            // try/catch.
            kill() {},
          };
          const outcome = spawnOutcomeProvider ? spawnOutcomeProvider(callIndex) : { code: 1, stdout: "" };
          // A `null`/`undefined` outcome means "never resolve this one" -- used as a
          // deterministic circuit breaker: once a runaway-loop test has observed enough
          // spawns to prove its point, later calls hang forever instead of continuing to
          // recurse, so the chain terminates without any timing-dependent cap.
          if (outcome) {
            queueMicrotask(() => {
              if (outcome.stdout) for (const cb of listeners.data) cb(Buffer.from(outcome.stdout));
              if (outcome.stderr) for (const cb of errListeners) cb(Buffer.from(outcome.stderr));
              for (const cb of listeners.exit) cb(outcome.code);
            });
          }
          return child;
        },
      };
    }
    throw new Error(`fake require: unsupported module "${id}"`);
  };
}
function fakeEl(tag = "div", options = {}) {
  const node = {
    tag,
    children: [],
    text: options.text ?? "",
    cls: options.cls ?? "",
    attrs: {},
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    // tsk-2026-09-18-020: real (not no-op'd) so the header refresh icon's spinning-class
    // toggling is actually observable by a test, same reasoning as click() above.
    addClass(c) { const parts = new Set((this.cls || "").split(/\s+/).filter(Boolean)); parts.add(c); this.cls = [...parts].join(" "); },
    removeClass(c) { this.cls = (this.cls || "").split(/\s+/).filter((x) => x && x !== c).join(" "); },
    toggleClass(c, on) { if (on) this.addClass(c); else this.removeClass(c); },
    hasClass(c) { return (this.cls || "").split(/\s+/).includes(c); },
    createDiv(o = {}) { const c = fakeEl("div", o); c.parent = this; this.children.push(c); creationLog.push({ tag: "div", cls: c.cls, text: c.text }); return c; },
    createSpan(o = {}) { const c = fakeEl("span", o); c.parent = this; this.children.push(c); creationLog.push({ tag: "span", cls: c.cls, text: c.text }); return c; },
    createEl(name, o = {}) { const c = fakeEl(name, o); c.parent = this; this.children.push(c); creationLog.push({ tag: name, cls: c.cls, text: c.text }); return c; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    // tsk-2026-09-18-020: unlike the rest of this stub, click listeners are actually stored (not
    // no-op'd) so new tests below can simulate a real click on the header refresh icon rather
    // than calling an internal handler function directly -- the same "test the real wiring, not
    // a hand-copy of it" discipline as the rest of this file. Harmless to every earlier test:
    // nothing before this task ever called element.click().
    __listeners: {},
    addEventListener(evt, cb) { (this.__listeners[evt] ||= []).push(cb); },
    removeEventListener(evt, cb) {
      if (!this.__listeners[evt]) return;
      this.__listeners[evt] = this.__listeners[evt].filter((f) => f !== cb);
    },
    click() { for (const cb of this.__listeners.click || []) cb({ preventDefault() {} }); },
    hide() {}, show() {}, isShown() { return false; },
    empty() { this.children = []; },
    setText(t) { this.text = t; },
    setAttr(k, v) { this.attrs[k] = v; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    getBoundingClientRect() { return { width: 800, height: 600 }; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return node;
}
// Token match, not exact-string match: main.ts creates elements with MULTIPLE space-separated
// classes (e.g. "aios-refresh aios-icon-btn"), same as a real DOM className. An exact-string
// findByClass would silently never find those.
function hasClass(node, cls) {
  return (node.cls || "").split(/\s+/).includes(cls);
}
function findByClass(node, cls) {
  if (hasClass(node, cls)) return node;
  for (const child of node.children) {
    const match = findByClass(child, cls);
    if (match) return match;
  }
  return undefined;
}

async function renderUsageTabToCompletion({
  statsPath = "Operations/usage/usage-stats.json",
  statusJson = null,
  generatedAt = null,
  // Round 2: an optional array of generatedAt values -- the fake adapter's `read` advances
  // through it (one step per read of the usage-stats.json path, sticking on the last entry once
  // exhausted) instead of returning a single fixed snapshot forever. Lets a test simulate "a
  // NEWER snapshot appears" (M4) without needing a real exporter run.
  generatedAtSequence = null,
  // R3-M1: when set, the fake adapter's `basePath` becomes a real string (satisfying
  // refreshUsageSnapshot's own `typeof basePath !== "string"` guard) and `spawnOutcomeProvider`
  // drives the fake `child_process.spawn` -- see installFakeChildProcess above. `null` (the
  // default) preserves every EXISTING test's behavior exactly: no basePath, every refresh
  // rejects immediately, same as before this round.
  basePath = null,
  spawnOutcomeProvider = null,
  // R3-M1: an optional string->string transform applied to the main.ts SOURCE TEXT before it
  // is written into the temp entry file that gets bundled -- never the tracked main.ts on
  // disk. This is how the guard-removal mutation tests below prove their point without ever
  // touching a tracked file (the same discipline as R3-I1's exporter fix, applied here to the
  // UI source).
  mutateSource = null,
  settleMs = 100,
} = {}) {
  resetCreationLog();
  resetSpawnLog();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-run-warnings-wiring-"));
  const stub = path.join(dir, "obsidian.mjs");
  const entryName = ".usage-run-warnings-wiring-entry.ts";
  const entry = path.join(root, entryName);
  const out = path.join(dir, "out.mjs");
  fs.writeFileSync(
    stub,
    [
      "export class App {}", "export class ItemView {}", "export class Menu {}", "export class Modal {}", "export class Notice {}",
      "export const Platform = { isDesktop: false };", "export class Plugin {}", "export class PluginSettingTab {}", "export class Scope {}",
      "export class Setting {}", "export class TFile {}", "export class TFolder {}", "export class WorkspaceLeaf {}",
      "export const normalizePath = (p) => p;", "export const setIcon = () => {};",
    ].join("\n")
  );
  const mainSource = fs.readFileSync(path.join(root, "main.ts"), "utf8");
  fs.writeFileSync(entry, (mutateSource ? mutateSource(mainSource) : mainSource) + "\nexport { renderUsageTab };\n");
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.getComputedStyle = () => ({ overflowY: "visible" });
  const docEl = fakeEl();
  globalThis.document = {
    body: docEl,
    documentElement: docEl,
    scrollingElement: docEl,
    createElementNS(_ns, tag) { return fakeEl(tag); },
    createElement(tag) { return fakeEl(tag); },
  };
  if (basePath !== null) installFakeChildProcess(spawnOutcomeProvider);
  try {
    esbuild.buildSync({
      absWorkingDir: root,
      entryPoints: [entryName],
      bundle: true,
      format: "esm",
      outfile: out,
      treeShaking: false,
      external: ["electron", "child_process", "node:crypto", "node:fs", "node:path", "@codemirror/*", "@lezer/*"],
      alias: { obsidian: stub },
    });
    const { renderUsageTab } = await import(pathToFileURL(out).href);
    const fixedStatsJson = JSON.stringify({ generatedAt: generatedAt ?? new Date().toISOString(), days: [], projects: [], windowDays: 35 });
    // Round 2 (M4 test support): each read of usage-stats.json advances one step through
    // generatedAtSequence when given, sticking on the last entry once exhausted; otherwise every
    // read returns the same fixedStatsJson forever, exactly as before this round. Entries may be
    // a string OR a `() => string` thunk, evaluated lazily at read time -- a plain string
    // captured before the test starts can end up EARLIER, in wall-clock terms, than
    // lastUsageRefreshResultAt (set inside the executor a moment after this test's own setup
    // ran), which would make M4's "newer than the failure" comparison silently false. A thunk
    // evaluated at the actual read instant is reliably later.
    let statsReadCount = 0;
    const statsJsonFor = () => {
      if (!generatedAtSequence || generatedAtSequence.length === 0) return fixedStatsJson;
      const idx = Math.min(statsReadCount, generatedAtSequence.length - 1);
      statsReadCount++;
      const entry = generatedAtSequence[idx];
      const generatedAtValue = typeof entry === "function" ? entry() : entry;
      return JSON.stringify({ generatedAt: generatedAtValue, days: [], projects: [], windowDays: 35 });
    };
    const app = {
      vault: {
        adapter: {
          basePath,
          async exists(p) {
            if (p.endsWith(".status.json")) return statusJson !== null;
            return p.endsWith("usage-stats.json");
          },
          async read(p) {
            if (p.endsWith(".status.json")) return statusJson;
            return statsJsonFor();
          },
        },
      },
    };
    const settings = { usageStatsPath: statsPath, dailyBudgetUsd: 0 };
    const viewState = { expanded: new Set(), usageRange: "7d", usageOffset: 0 };
    const container = fakeEl();
    const periodbarHost = fakeEl();
    // Round 2, Minor M1: renderUsageTab now takes a `refresh` callback (threaded from the real
    // renderDashboard) that its own settle-triggered doRefresh calls instead of a purely local
    // draw(). This harness's equivalent: empty the container and re-render the whole tab in
    // place, mirroring what the real full-dashboard rebuild does for this narrower scope.
    const refresh = () => {
      container.empty();
      periodbarHost.empty();
      renderUsageTab(app, container, periodbarHost, settings, viewState, refresh);
    };
    renderUsageTab(app, container, periodbarHost, settings, viewState, refresh);
    // renderUsageTab's own load is a real microtask chain (Promise.all -> .then); give it room
    // to settle before inspecting the tree.
    await new Promise((r) => setTimeout(r, settleMs));
    // Round 2 (I2 storm test support): `refresh` exposed so a caller can drive additional
    // re-renders manually, simulating a vault-change storm (scheduleRefresh firing repeatedly)
    // independent of doRefresh's own settle-triggered call.
    container.__refresh = refresh;
    return container;
  } finally {
    fs.rmSync(entry, { force: true });
  }
}

{
  // Each call bundles and dynamically imports a FRESH copy of main.ts into its own temp file,
  // so the two calls do not share the module-level usageReadState/usageLastGood maps despite
  // using the same statsPath -- deliberately kept identical here (rather than varied per call)
  // because the adapter fakes below match on a literal "usage-stats.json" suffix.
  const healthy = await renderUsageTabToCompletion({ statusJson: null });
  assert.equal(findByClass(healthy, "aios-budget-warn"), undefined, "a healthy read with no run-status file renders no warning");

  const failed = await renderUsageTabToCompletion({
    statusJson: JSON.stringify({ lastAttemptAt: new Date().toISOString(), lastSuccessAt: null, lastError: "boom: disk full" }),
  });
  const warnNode = findByClass(failed, "aios-budget-warn");
  assert.ok(warnNode, "a real, full renderUsageTab render with a failed run-status must produce a warning div somewhere in the rendered tree");
  assert.match(warnNode.text, /The last export attempt failed: boom: disk full/, "the rendered warning names the specific failure (GL-009 rule 3), not just that something is wrong");
  console.log("wiring: a real full renderUsageTab render shows the run-health warning exactly when the signals say it should, and not otherwise");
}

{
  // R2-I1 (Reviewer round 2): a 2-hour-old snapshot must show the Generated/age text and the
  // stale indicator, and the Refresh button must exist -- and must survive every redraw,
  // including the very first one, because draw() unconditionally empties `body` on every call.
  //
  // This asserts on the CREATION-TIME log rather than the settled tree on purpose. The real
  // code auto-triggers a refresh when stale (`if (stale && !refreshTriggeredForThisLoad) void
  // doRefresh();`), and doRefresh's own synchronous prefix
  // (`refreshStatus.setText("Refreshing usage snapshot...")`) overwrites the text before
  // draw() itself returns -- a genuine same-tick overwrite in the real code path, not a test
  // race. Inspecting the settled tree could never observe "Generated ... (stale)" for a
  // genuinely stale snapshot even on a fully correct implementation, so it is not the right
  // assertion for R2-I1's requirement. The creation log captures what draw() actually
  // computed and rendered the INSTANT it created the element, which is exactly the structural
  // property R2-I1 is about: was refreshStatus (re)created with the right stale text on this
  // draw(), not wiped or skipped.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const finalTree = await renderUsageTabToCompletion({ statusJson: null, generatedAt: twoHoursAgo });

  const refreshStatusEntries = creationLog.filter((e) => e.cls === "aios-usage-refresh-status");
  assert.ok(refreshStatusEntries.length > 0, "R2-I1: renderUsageTab must create a refresh-status element on every draw(), including the first");
  const firstRefreshStatus = refreshStatusEntries[0];
  assert.match(firstRefreshStatus.text, /Generated/, "R2-I1: a 2-hour-old snapshot's refresh-status text must show the Generated/age text at creation time");
  assert.match(firstRefreshStatus.text, /\(stale\)/, "R2-I1: a 2-hour-old snapshot's refresh-status text must show the stale indicator at creation time");

  // tsk-2026-09-18-020, D-2026-09-18-02 "one button": the Usage tab's own Refresh button is
  // gone. The header icon (tested separately below, renderDashboardToCompletion) is now the
  // only control that launches the exporter.
  // Round 2, Reviewer Minor M6: token match, not exact-string -- a reintroduced Usage button
  // with any extra class (e.g. "aios-refresh aios-usage-btn") would pass an exact-string check.
  const refreshButtonEntries = creationLog.filter((e) => (e.cls || "").split(/\s+/).includes("aios-refresh"));
  assert.equal(refreshButtonEntries.length, 0, "D-2026-09-18-02: the Usage tab must no longer create its own Refresh button");

  // The creation-log checks above prove draw() computed the right text at creation time, but
  // NOT that the elements are still attached anywhere by the time everything settles -- that
  // is precisely what the original R2-I1 bug got wrong: refreshStatus was created once,
  // outside/before draw(), and then draw()'s own body.empty() (running for the very first time
  // right after) permanently dropped it out of the tree with nothing left to ever re-add it. A
  // creation-log-only test cannot see that regression (the element WAS created, with correct
  // text, before being wiped), so this checks the SETTLED tree too.
  assert.ok(findByClass(finalTree, "aios-usage-refresh-status"), "R2-I1: the refresh-status element must still be present in the rendered tree after everything settles, not just created-then-wiped by draw()'s body.empty()");
  console.log("R2-I1: a 2-hour-old snapshot shows Generated/age + stale text and a Refresh button, at creation time, surviving draw()'s body.empty()");
}

{
  // R3-M1 (Reviewer round 3, Minor): the `refreshTriggeredForThisLoad` guard
  // (`if (stale && !refreshTriggeredForThisLoad) { refreshTriggeredForThisLoad = true; void
  // doRefresh(); }`) and the busy flag (`lastRefreshWasBusy`) were both untested -- Reviewer
  // measured 63 real exporter spawns in 2s (an endless refresh loop) with the guard removed,
  // and the busy suffix silently disappearing with the flag removed. Both require driving the
  // full busy-then-redraw cycle, which needs a real basePath and a controllable fake exporter
  // launch (see installFakeChildProcess above) -- the harness previously had neither.
  //
  // Deterministic circuit breaker, not a wall-clock race: `spawnOutcomeProvider` answers
  // "busy" for the first BUSY_CAP calls, then returns `null` (never resolves) for any call
  // beyond that -- so even a genuinely runaway loop (the mutated code) cannot spin forever or
  // race a timer; it always stops after exactly BUSY_CAP spawns, deterministically, and the
  // fixed settle wait below is comfortably longer than BUSY_CAP microtask-driven cycles need.
  const BUSY_CAP = 5;
  const busyOutcomeProvider = (callIndex) => (callIndex < BUSY_CAP ? { code: 0, stdout: "usage export busy; a live writer holds the lock" } : null);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // --- usageAutoRefreshAttempted (module-level, round 2): correct code must spawn exactly
  // --- once, even though every busy response leaves the snapshot just as stale and would
  // --- otherwise re-trigger. ------------------------------------------------------------------
  await renderUsageTabToCompletion({ statusJson: null, generatedAt: twoHoursAgo, basePath: "/fake/vault", spawnOutcomeProvider: busyOutcomeProvider, settleMs: 200 });
  assert.equal(spawnLog.length, 1, `with the guard intact, a persistently busy stale snapshot must trigger exactly ONE exporter launch per load, not one per busy response -- got ${spawnLog.length}`);

  console.log(`I2 (once per load, within one instance): intact -- 1 spawn despite ${BUSY_CAP} busy responses.`);
}

{
  // Round 2, Reviewer Important I2: the actual measured bug -- a FAILING exporter re-renders the
  // dashboard (its own status-sidecar rewrite is a vault write) which, with a per-render (not
  // per-load) guard, relaunches on EVERY re-render, AND doRefresh's own settle-triggered
  // refresh() (Minor M1's fix) feeds a FRESH render right back into that same loop on its own,
  // with no external trigger needed -- exactly Reviewer's "a failing run itself causes a
  // re-render, so the loop sustains itself." Deterministic circuit breaker, same pattern as the
  // busy-cap tests above: FAIL_CAP failing spawns, then `null` (never resolves) freezes the
  // chain -- a genuinely unbounded runaway (the mutated code) cannot OOM the test process; it
  // always stops after exactly FAIL_CAP spawns.
  const FAIL_CAP = 6;
  const failProvider = (callIndex) => (callIndex < FAIL_CAP ? { code: 1, stdout: "", stderr: "boom: disk full" } : null);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const container = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: twoHoursAgo,
    basePath: "/fake/vault",
    spawnOutcomeProvider: failProvider,
    settleMs: 300,
  });
  // Also simulate 4 EXTERNAL vault-change-storm re-renders (what scheduleRefresh's debounced
  // handler does on every create/modify/rename/delete) against the same still-stale snapshot
  // (a failed run never touches the data file, only its status sidecar).
  for (let i = 0; i < 4; i++) {
    container.__refresh();
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    spawnLog.length,
    1,
    `I2: with the guard intact, 1 initial load plus doRefresh's own settle-triggered redraws plus 4 simulated external re-renders must still show exactly 1 total exporter launch -- got ${spawnLog.length}`
  );
  console.log(`I2 (re-render storm + self-sustaining settle redraws, guard intact): -> ${spawnLog.length} total spawn(s).`);

  // --- MUTATION: move the guard back to RENDER scope (a per-renderUsageTab-instance `let`
  // --- reset on every fresh render -- the exact round-1 shape Reviewer's I2 finding identified
  // --- as the root cause -- main.ts source string transform, never the tracked file). ---------
  const moveGuardToRenderScope = (source) => {
    const declareNeedle = "    const STALE_THRESHOLD_MS = 15 * 60 * 1000;\n";
    assert.ok(source.includes(declareNeedle), "the STALE_THRESHOLD_MS declaration must be present verbatim (fixture drift guard)");
    const conditionNeedle =
      '      const autoRefreshKey = `${settings.usageStatsPath}|${stats.generatedAt || ""}`;\n      if (stale && !refreshing && !usageAutoRefreshAttempted.has(autoRefreshKey)) {\n        usageAutoRefreshAttempted.add(autoRefreshKey);\n        void doRefresh();\n      }';
    assert.ok(source.includes(conditionNeedle), "the module-level auto-refresh guard block must be present verbatim before mutating it (fixture drift guard)");
    let mutated = source.replace(declareNeedle, `${declareNeedle}    let mutatedRenderScopeGuard = false;\n`);
    mutated = mutated.replace(
      conditionNeedle,
      '      if (stale && !refreshing && !mutatedRenderScopeGuard) {\n        mutatedRenderScopeGuard = true;\n        void doRefresh();\n      }'
    );
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const mutatedContainer = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: twoHoursAgo,
    basePath: "/fake/vault",
    spawnOutcomeProvider: failProvider,
    mutateSource: moveGuardToRenderScope,
    settleMs: 300,
  });
  for (let i = 0; i < 4; i++) {
    mutatedContainer.__refresh();
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
  // FAIL_CAP + 1, not FAIL_CAP: the (FAIL_CAP+1)th spawn call IS still logged (the log push
  // happens before the outcome lookup) -- it is the one whose outcome comes back `null` and
  // never resolves, which is what actually freezes the chain (same accounting as the busy-cap
  // runaway proof above). Any count above 1 already proves the runaway.
  assert.equal(
    spawnLog.length,
    FAIL_CAP + 1,
    `MUTATION CHECK: with the guard moved back to render scope, the SAME storm must WRONGLY relaunch on every re-render and every settle-triggered redraw, proving the guard's MODULE-level scope (not something else) is what stops it -- got ${spawnLog.length} spawns`
  );
  console.log(`I2 (re-render storm, guard MUTATED to render scope): -> ${spawnLog.length} total spawn(s) (runaway, capped only by the test harness). Reverted (never touched the tracked file).`);
}

{
  // --- lastUsageRefreshResult (module-level, tsk-2026-09-18-020): a busy outcome must still
  // --- say so after the redraw it triggers, not silently look like a normal fresh Generated
  // --- line. Module-level (not a per-tab flag any more) so this same mechanism is what the
  // --- header-icon tests above rely on to surface a failure regardless of which control
  // --- triggered the run. ----------------------------------------------------------------
  const BUSY_CAP = 1;
  const busyOnceProvider = (callIndex) => (callIndex < BUSY_CAP ? { code: 0, stdout: "usage export busy; a live writer holds the lock" } : null);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const finalTree = await renderUsageTabToCompletion({ statusJson: null, generatedAt: twoHoursAgo, basePath: "/fake/vault", spawnOutcomeProvider: busyOnceProvider, settleMs: 200 });
  const refreshStatusNode = findByClass(finalTree, "aios-usage-refresh-status");
  assert.ok(refreshStatusNode, "a refresh-status node must exist after the busy redraw settles");
  assert.match(refreshStatusNode.text, /Another export was already in progress/, `with lastUsageRefreshResult intact, the settled text after a busy outcome must say another export was in progress -- got: ${JSON.stringify(refreshStatusNode.text)}`);

  // --- MUTATION: neutralize the busy branch of draw()'s refreshStatusText ternary (main.ts
  // --- source string transform, never the tracked file), rerun, capture the real RED. --------
  const removeBusyBranch = (source) => {
    const needle = "          : effectiveResult?.busy\n";
    assert.ok(source.includes(needle), "the effectiveResult?.busy branch must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "          : false\n");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const mutatedTree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: twoHoursAgo,
    basePath: "/fake/vault",
    spawnOutcomeProvider: busyOnceProvider,
    mutateSource: removeBusyBranch,
    settleMs: 200,
  });
  const mutatedNode = findByClass(mutatedTree, "aios-usage-refresh-status");
  assert.ok(mutatedNode, "sanity: a refresh-status node must still exist under the mutation");
  assert.doesNotMatch(
    mutatedNode.text,
    /Another export was already in progress/,
    `MUTATION CHECK: with the busy branch neutralized, the busy outcome's redraw must WRONGLY look like a normal fresh read, proving that branch (not something else) carries the distinction -- got: ${JSON.stringify(mutatedNode.text)}`
  );
  console.log(`lastUsageRefreshResult busy surfacing -- intact: busy text visible after redraw ("${refreshStatusNode.text}"). MUTATION (branch neutralized): busy text vanished ("${mutatedNode.text}"). Reverted (never touched the tracked file).`);
}

{
  // --- lastUsageRefreshResult error surfacing, same mechanism, isolated at the Usage-tab level
  // --- (the header-icon test above exercises this end-to-end through a real click; this proves
  // --- the draw()-side error branch specifically, mutated independently of the busy branch). ---
  const failOnceProvider = (callIndex) => (callIndex === 0 ? { code: 1, stdout: "", stderr: "" } : null);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const finalTree = await renderUsageTabToCompletion({ statusJson: null, generatedAt: twoHoursAgo, basePath: "/fake/vault", spawnOutcomeProvider: failOnceProvider, settleMs: 200 });
  const refreshStatusNode = findByClass(finalTree, "aios-usage-refresh-status");
  assert.ok(refreshStatusNode, "a refresh-status node must exist after the failed redraw settles");
  assert.match(refreshStatusNode.text, /Refresh failed \(exporter exited 1\)/, `a real (fake-spawned) exit-1 exporter must surface "exporter exited 1" -- got: ${JSON.stringify(refreshStatusNode.text)}`);

  const removeErrorBranch = (source) => {
    const needle = "        : effectiveResult?.error\n";
    assert.ok(source.includes(needle), "the effectiveResult?.error branch must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "        : false\n");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const mutatedTree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: twoHoursAgo,
    basePath: "/fake/vault",
    spawnOutcomeProvider: failOnceProvider,
    mutateSource: removeErrorBranch,
    settleMs: 200,
  });
  const mutatedNode = findByClass(mutatedTree, "aios-usage-refresh-status");
  assert.ok(mutatedNode, "sanity: a refresh-status node must still exist under the mutation");
  assert.doesNotMatch(
    mutatedNode.text,
    /Refresh failed/,
    `MUTATION CHECK: with the error branch neutralized, a real exporter failure must go WRONGLY unreported, proving that branch (not something else) surfaces it -- got: ${JSON.stringify(mutatedNode.text)}`
  );
  console.log(`lastUsageRefreshResult error surfacing -- intact: "${refreshStatusNode.text}". MUTATION (branch neutralized): "${mutatedNode.text}". Reverted (never touched the tracked file).`);
}

// --- 5. Header refresh icon (main.ts renderDashboard): tsk-2026-09-18-020, D-2026-09-18-02 ---
// "one button" -- a real, full renderDashboard render (not a hand-simulated click handler),
// same discipline as the Usage-tab wiring tests above. Exercises: exactly one exporter launch
// plus an immediate re-render on click, a second click while running not launching a second
// exporter, and the spinning-icon indicator.
async function renderDashboardToCompletion({
  spawnOutcomeProvider = null,
  mutateSource = null,
  fsExists = null,
  // esbuild's bare `require(...)` shim resolves `globalThis.require` ONCE, at module-EVAL time
  // (when the dynamic `import()` below first runs this module), not freshly on every call --
  // measured directly (a post-import reassignment of globalThis.require had no effect on an
  // already-imported module's own require() calls). So a caller that needs a CUSTOM
  // globalThis.require (not just a custom spawnOutcomeProvider/fsExists) must set it up BEFORE
  // calling this function and pass `installChildProcess: false` here to skip the default
  // installFakeChildProcess call that would otherwise clobber it before this module loads.
  installChildProcess = true,
  isDesktop = true,
} = {}) {
  resetCreationLog();
  resetSpawnLog();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-header-refresh-"));
  const stub = path.join(dir, "obsidian.mjs");
  const entryName = ".dashboard-header-refresh-entry.ts";
  const entry = path.join(root, entryName);
  const out = path.join(dir, "out.mjs");
  fs.writeFileSync(
    stub,
    [
      "export class App {}", "export class ItemView {}", "export class Menu {}", "export class Modal {}", "export class Notice {}",
      `export const Platform = { isDesktop: ${isDesktop} };`, "export class Plugin {}", "export class PluginSettingTab {}", "export class Scope {}",
      "export class Setting {}", "export class TFile {}", "export class TFolder {}", "export class WorkspaceLeaf {}",
      "export const normalizePath = (p) => p;", "export const setIcon = () => {};",
    ].join("\n")
  );
  const mainSource = fs.readFileSync(path.join(root, "main.ts"), "utf8");
  fs.writeFileSync(
    entry,
    (mutateSource ? mutateSource(mainSource) : mainSource) +
      "\nexport { renderDashboard as __renderDashboard, DEFAULT_SETTINGS as __DEFAULT_SETTINGS };\n"
  );
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.getComputedStyle = () => ({ overflowY: "visible" });
  // renderDashboard's captureCoordinationFocus checks `instanceof HTMLTextAreaElement` on
  // document.activeElement -- undefined in plain Node, unlike renderUsageTab's narrower stub
  // which never reaches that code path.
  globalThis.HTMLTextAreaElement = class {};
  const docEl = fakeEl();
  globalThis.document = {
    body: docEl,
    documentElement: docEl,
    scrollingElement: docEl,
    activeElement: docEl,
    createElementNS(_ns, tag) { return fakeEl(tag); },
    createElement(tag) { return fakeEl(tag); },
  };
  if (installChildProcess) installFakeChildProcess(spawnOutcomeProvider, { fsExists });
  try {
    esbuild.buildSync({
      absWorkingDir: root,
      entryPoints: [entryName],
      bundle: true,
      format: "esm",
      outfile: out,
      treeShaking: false,
      external: ["electron", "child_process", "node:crypto", "node:fs", "node:path", "node:os", "fs", "os", "@codemirror/*", "@lezer/*"],
      alias: { obsidian: stub },
    });
    const { __renderDashboard: renderDashboard, __DEFAULT_SETTINGS: DEFAULT_SETTINGS } = await import(pathToFileURL(out).href);
    const statsJson = JSON.stringify({ generatedAt: new Date().toISOString(), days: [], projects: [], windowDays: 35 });
    const app = {
      vault: {
        getMarkdownFiles() { return []; },
        getAbstractFileByPath() { return null; },
        adapter: {
          basePath: "/fake/vault",
          async exists(p) { return p.endsWith("usage-stats.json"); },
          async read(_p) { return statsJson; },
        },
      },
      metadataCache: { getFileCache() { return undefined; }, unresolvedLinks: {} },
      workspace: { openLinkText() {} },
    };
    const settings = { ...DEFAULT_SETTINGS, showHealthStrip: false, actionsEnabled: false };
    const viewState = {
      activeTab: "usage", activeStatus: null, activeCategory: "all", expanded: new Set(), openOff: new Set(),
      completeOn: new Set(), usageRange: "7d", usageOffset: 0, systemsOpen: false, systemSkillsFilter: "",
      systemSkillsExpandedGroups: new Set(), systemActiveSubTab: "agents", coordinationDrafts: new Map(),
      coordinationQuestionFilter: new Map(), scrollTops: new Map(),
    };
    const rootEl = fakeEl();
    let refreshCount = 0;
    const refresh = () => {
      refreshCount++;
      renderDashboard(app, rootEl, refresh, viewState, settings, {}, true);
    };
    renderDashboard(app, rootEl, refresh, viewState, settings, {}, true);
    await new Promise((r) => setTimeout(r, 150));
    return {
      getRoot: () => rootEl,
      getRefreshBtn: () => findByClass(rootEl, "aios-refresh"),
      getRefreshCount: () => refreshCount,
      settle: (ms = 150) => new Promise((r) => setTimeout(r, ms)),
    };
  } finally {
    fs.rmSync(entry, { force: true });
  }
}

{
  const BUSY_CAP = 0; // never busy: a normal successful run
  const successProvider = () => ({ code: 0, stdout: "usage-stats: 1 transcript(s) ..." });
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider });
  const btn = h.getRefreshBtn();
  assert.ok(btn, "the header must render a refresh icon button (cls aios-refresh)");
  assert.equal(spawnLog.length, 0, "sanity: no exporter launch before any click");

  const countBefore = h.getRefreshCount();
  btn.click();
  assert.equal(h.getRefreshCount(), countBefore + 1, "a click must trigger an immediate re-render (the vault re-read), synchronously, not waiting on the exporter");
  assert.equal(spawnLog.length, 1, "a click must launch exactly one exporter process");

  // Second click while the (still in-flight, since the fake spawn resolves on a microtask that
  // hasn't run yet) run is active must NOT launch a second exporter.
  h.getRoot(); // (no-op access, keeps this block symmetric with the one below)
  const refreshBtnAfterFirstClick = h.getRefreshBtn(); // refresh() rebuilt the header; get the CURRENT button
  refreshBtnAfterFirstClick.click();
  assert.equal(spawnLog.length, 1, `a second click while a run is already in flight must not launch a second exporter -- got ${spawnLog.length} spawns`);

  await h.settle(150);
  assert.equal(spawnLog.length, 1, "settling must not have launched any further exporter runs on its own");
  console.log(`header refresh icon: 1 click -> 1 immediate re-render + 1 exporter launch; a second click while running -> still 1 launch (${spawnLog.length} total spawns)`);
}

{
  // MUTATION PROOF (GL-009 rule 4): the guard that ACTUALLY prevents a second exporter process
  // is refreshUsageSnapshot's own `if (usageRefreshInFlight) return usageRefreshInFlight;`
  // dedupe, not the header click handler's `alreadyRunning` check (that one only avoids
  // attaching a redundant extra "redraw on settle" continuation -- refreshUsageSnapshot is
  // idempotent either way, so mutating the click handler's own check would NOT actually
  // increase spawnLog.length, and would be a false proof). This mutates the REAL guard, in
  // isolation, against the same two-click fixture used above (already confirmed to clear every
  // guard ahead of it -- the fixture is unchanged from the intact run above).
  const removeDedupeGuard = (source) => {
    const needle = "  if (usageRefreshInFlight) return usageRefreshInFlight;\n";
    assert.ok(source.includes(needle), "the refreshUsageSnapshot dedupe guard must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const successProvider = () => ({ code: 0, stdout: "usage-stats: 1 transcript(s) ..." });
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, mutateSource: removeDedupeGuard });
  const btn = h.getRefreshBtn();
  btn.click();
  assert.equal(spawnLog.length, 1, "sanity: first click still launches exactly one exporter under the mutation");
  const btnAfterFirstClick = h.getRefreshBtn();
  btnAfterFirstClick.click();
  assert.equal(
    spawnLog.length,
    2,
    `MUTATION CHECK: with refreshUsageSnapshot's own dedupe guard removed, a second click while the first run is still in flight must WRONGLY launch a second exporter process, proving THAT guard (not the click handler's own alreadyRunning check) is what stops it -- got ${spawnLog.length} spawns`
  );
  console.log(`header refresh icon dedupe: intact -- 2 clicks -> 1 spawn. MUTATION (refreshUsageSnapshot's own guard removed) -- 2 clicks -> ${spawnLog.length} spawns. Reverted (never touched the tracked file).`);
}

{
  // MUTATION PROOF: the immediate re-render (the vault re-read that must not wait on the
  // ~9s exporter) is the trailing, unconditional `refresh();` in the click handler, run
  // regardless of Platform.isDesktop or in-flight state. Removing it must leave the click
  // with NO visible effect until the exporter settles seconds later.
  const removeImmediateRefresh = (source) => {
    const needle = "      void refreshUsageSnapshot(app).finally(() => refresh());\n    }\n    refresh();\n  });";
    assert.ok(source.includes(needle), "the click handler's trailing refresh() call must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "      void refreshUsageSnapshot(app).finally(() => refresh());\n    }\n  });");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const successProvider = () => ({ code: 0, stdout: "usage-stats: 1 transcript(s) ..." });
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, mutateSource: removeImmediateRefresh });
  const countBefore = h.getRefreshCount();
  const btn = h.getRefreshBtn();
  btn.click();
  assert.equal(
    h.getRefreshCount(),
    countBefore,
    `MUTATION CHECK: with the click handler's immediate refresh() call removed, a click must WRONGLY produce no visible re-render until the exporter settles later, proving that call (not the exporter's own eventual redraw) is what makes the re-read immediate -- got refreshCount ${h.getRefreshCount()} vs before ${countBefore}`
  );
  console.log(`header refresh icon immediate re-render: intact -- click bumps refreshCount synchronously. MUTATION (trailing refresh() removed) -- refreshCount unchanged (${h.getRefreshCount()}) right after the click. Reverted (never touched the tracked file).`);
}

{
  // Spinning-icon indicator: present while in flight (a spawn outcome provider that never
  // resolves for call 0 -- `null` -- keeps the promise pending deterministically, no timing
  // race), absent once settled.
  const neverResolveProvider = () => null;
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: neverResolveProvider });
  const btn = h.getRefreshBtn();
  assert.ok(!hasClass(btn, "aios-refresh-spinning"), "the icon must not be spinning before any click");
  btn.click();
  const btnAfterClick = h.getRefreshBtn(); // refresh() rebuilt the header synchronously
  assert.ok(hasClass(btnAfterClick, "aios-refresh-spinning"), "the icon must show it is spinning immediately after the click that started a run (the immediate re-render must reflect in-flight state)");
  assert.equal(btnAfterClick.disabled, true, "the button must be disabled while a run is in flight, so rapid re-clicks cannot pile up new listeners");
  console.log("header refresh icon: spinning class + disabled present immediately after a click starts a run (never resolves, by design, to prove this without a timing race)");
}

{
  // Real failure reason (GL-009 rule 3): a launch failure must surface a specific message, not
  // just "failed" -- driven all the way through a real exit-1 exporter with stderr, through
  // refreshUsageSnapshot, into the header's triggered run AND the Usage tab's status line (both
  // consumers of the same shared refreshUsageSnapshot result).
  const failProvider = () => ({
    code: 1,
    stdout: "",
    stderr: "usage export: failed to write lock owner token: EACCES",
  });
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: failProvider });
  const btn = h.getRefreshBtn();
  btn.click();
  await h.settle(150);
  const statusNode = findByClass(h.getRoot(), "aios-usage-refresh-status");
  assert.ok(statusNode, "the Usage tab status line must exist after a header-triggered refresh settles");
  assert.match(
    statusNode.text,
    /Refresh failed \(usage export: failed to write lock owner token: EACCES\)/,
    `the status line must name the SPECIFIC failure reason (GL-009 rule 3), not a bare "failed" -- got: ${JSON.stringify(statusNode.text)}`
  );
  console.log(`header-triggered refresh failure: Usage tab status line names the real cause -- "${statusNode.text}"`);
}

// --- Round 2, Reviewer Important I3: the fix is not mutation-proven at the WIRING level -------
// Round 1's tests ran entirely under real node (process.execPath IS a working node binary), so
// resolveExporterLaunch's "already node" shortcut fired every time regardless of whether the
// downstream `spawn(launch.command, ...)` call actually used its answer -- putting the original
// bug back (`spawn(process.execPath, ...)`) or deleting the no-node guard both left `npm test`
// green, because the fake spawn also discarded its command argument (Coder contract rule 2).
// This block fixes BOTH problems: `process.execPath` is temporarily overridden to a fake
// Electron-shaped path (with `process.versions.electron` set, for realism) so the "already
// node" shortcut cannot fire and the REAL fs-candidate resolution logic runs; the fake spawn
// (updated above) now RECORDS the command it was actually given.
{
  const originalExecPath = process.execPath;
  const hadElectronVersion = Object.prototype.hasOwnProperty.call(process.versions, "electron");
  const originalElectronVersion = process.versions.electron;
  process.execPath = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  process.versions.electron = "39.8.3";
  try {
    // Only ONE candidate path "exists": /opt/homebrew/bin/node. This pins exactly which path
    // the resolver should pick, so the assertion below is meaningful (not just "spawn was
    // called with SOMETHING").
    const onlyHomebrewNode = (p) => p === "/opt/homebrew/bin/node";
    const successProvider = () => ({ code: 0, stdout: "usage-stats: 1 transcript(s) ..." });

    const h = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, fsExists: onlyHomebrewNode });
    h.getRefreshBtn().click();
    assert.equal(spawnLog.length, 1, "sanity: exactly one spawn");
    assert.equal(
      spawnLog[0].command,
      "/opt/homebrew/bin/node",
      `the ACTUAL spawned command must be the resolved node path, not process.execPath (the fake Electron path) -- got ${JSON.stringify(spawnLog[0].command)}`
    );
    assert.notEqual(spawnLog[0].command, process.execPath, "sanity: the spawned command must differ from the fake Electron execPath");
    console.log(`I3 wiring (intact): spawned command = ${spawnLog[0].command} (process.execPath was the fake Electron path ${process.execPath})`);

    // --- MUTATION D: put the ORIGINAL BUG back -- spawn(process.execPath, ...) instead of
    // --- spawn(launch.command, ...). Must go RED: the spawned command becomes the fake
    // --- Electron path, not the resolved node path. -----------------------------------------
    const restoreOriginalBug = (source) => {
      const needle =
        'const child = require("child_process").spawn(launch.command, ["Operations/scripts/export-usage-stats.mjs", basePath], { cwd: basePath, shell: false, stdio: ["ignore", "pipe", "pipe"] });';
      assert.ok(source.includes(needle), "the real spawn call must be present verbatim before mutating it (fixture drift guard)");
      const mutated = source.replace(needle, needle.replace("launch.command", "process.execPath"));
      assert.notEqual(mutated, source, "the mutation must actually change the source");
      return mutated;
    };
    const hD = await renderDashboardToCompletion({
      spawnOutcomeProvider: successProvider,
      fsExists: onlyHomebrewNode,
      mutateSource: restoreOriginalBug,
    });
    hD.getRefreshBtn().click();
    assert.equal(
      spawnLog[0].command,
      process.execPath,
      `MUTATION D CHECK: with spawn(launch.command,...) reverted to spawn(process.execPath,...) (the original bug), the spawned command must WRONGLY be the fake Electron path, proving the fix actually depends on using launch.command -- got ${JSON.stringify(spawnLog[0].command)}`
    );
    console.log(`I3 wiring, MUTATION D (original bug restored): spawned command WRONGLY = ${spawnLog[0].command}. Reverted (never touched the tracked file).`);

    // --- MUTATION E: delete the no-node guard. With NO candidate existing anywhere, intact
    // --- code must settle with a named error and spawn NOTHING; the mutation must wrongly
    // --- spawn a null/undefined command. --------------------------------------------------
    const nothingExists = () => false;
    const hIntactNoNode = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, fsExists: nothingExists });
    hIntactNoNode.getRefreshBtn().click();
    await hIntactNoNode.settle(150);
    assert.equal(spawnLog.length, 0, `sanity: with no candidate anywhere, intact code must never spawn -- got ${spawnLog.length} spawns`);
    const noNodeStatus = findByClass(hIntactNoNode.getRoot(), "aios-usage-refresh-status");
    assert.match(noNodeStatus.text, /Refresh failed \(no Node\.js binary found/, `the no-node case must surface its OWN named failure -- got: ${JSON.stringify(noNodeStatus.text)}`);

    const removeNoNodeGuard = (source) => {
      const needle = '      if (!launch.command) { settle({ busy: false, error: launch.reason }); return; }\n';
      assert.ok(source.includes(needle), "the no-node guard must be present verbatim before mutating it (fixture drift guard)");
      const mutated = source.replace(needle, "");
      assert.notEqual(mutated, source, "the mutation must actually change the source");
      return mutated;
    };
    const hMutatedNoNode = await renderDashboardToCompletion({
      spawnOutcomeProvider: successProvider,
      fsExists: nothingExists,
      mutateSource: removeNoNodeGuard,
    });
    hMutatedNoNode.getRefreshBtn().click();
    assert.equal(
      spawnLog.length,
      1,
      `MUTATION E CHECK: with the no-node guard removed, a run with no candidate anywhere must WRONGLY attempt to spawn a null/undefined command instead of settling with a named failure -- got ${spawnLog.length} spawns`
    );
    assert.equal(spawnLog[0].command, null, "MUTATION E CHECK: the wrongly-attempted spawn's command must be null (launch.command was never checked)");
    console.log(`I3 wiring, MUTATION E (no-node guard removed): WRONGLY spawned command=${JSON.stringify(spawnLog[0].command)} (intact: 0 spawns, named failure). Reverted (never touched the tracked file).`);
  } finally {
    process.execPath = originalExecPath;
    if (hadElectronVersion) process.versions.electron = originalElectronVersion;
    else delete process.versions.electron;
  }
}

// --- Round 2, Reviewer Important I1: a hung exporter must time out, kill the child, settle as a
// --- named failure, and clear usageRefreshInFlight -- not spin/disable the one refresh control
// --- forever. Uses a dedicated fake spawn whose fake child NEVER fires "exit" or "error" on its
// --- own (simulating a genuine hang) but DOES record whether kill() was called, and a
// --- source-mutated SHORT timeout (real 60s would make this test itself take a minute).
{
  const shortenTimeout = (source) => {
    const needle = "const USAGE_EXPORT_TIMEOUT_MS = 60_000;";
    assert.ok(source.includes(needle), "the timeout constant must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "const USAGE_EXPORT_TIMEOUT_MS = 50;");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  // Must be set BEFORE renderDashboardToCompletion's dynamic import() runs, not after: esbuild's
  // bare `require(...)` shim resolves globalThis.require ONCE at module-eval time (measured --
  // a post-import reassignment had no effect on an already-imported module's own require()
  // calls). `installChildProcess: false` stops the function's own default fake from clobbering
  // this one before the module loads.
  let killCalled = false;
  globalThis.require = (id) => {
    if (id === "fs") return { existsSync: () => true, readFileSync: () => "24.14.1", readdirSync: () => ["v24.14.1"] };
    if (id === "os") return { homedir: () => "/fake/home" };
    if (id === "child_process") {
      return {
        spawn() {
          spawnLog.push({ callIndex: spawnLog.length });
          return {
            stdout: { on() {} },
            stderr: { on() {} },
            once() { /* never fires exit or error -- a genuine hang */ },
            kill() { killCalled = true; },
          };
        },
      };
    }
    throw new Error(`fake require: unsupported module "${id}"`);
  };
  const h = await renderDashboardToCompletion({ mutateSource: shortenTimeout, settleMs: 0, installChildProcess: false });
  const btn = h.getRefreshBtn();
  btn.click();
  const btnAfterClick = h.getRefreshBtn();
  assert.ok(hasClass(btnAfterClick, "aios-refresh-spinning"), "sanity: spinning immediately after the click");
  // Wait comfortably past the shortened 50ms timeout.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(killCalled, "I1: the timeout must call kill() on the hung child");
  const settledBtn = h.getRefreshBtn();
  assert.ok(!hasClass(settledBtn, "aios-refresh-spinning"), "I1: the icon must stop spinning once the timeout settles the hung run");
  assert.equal(settledBtn.disabled, false, "I1: the icon must be re-enabled once the timeout settles the hung run");
  const statusNode = findByClass(h.getRoot(), "aios-usage-refresh-status");
  assert.match(statusNode.text, /Refresh failed \(exporter timed out after/, `I1: the status line must name the timeout specifically -- got: ${JSON.stringify(statusNode.text)}`);
  console.log(`I1 (hung exporter): kill() called, icon un-stuck, status = "${statusNode.text}"`);
}

// --- Round 2, Reviewer Minor M4: a failure message must clear once a NEWER snapshot appears,
// --- from ANY writer (not only this plugin's own refreshUsageSnapshot calls). ------------------
{
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  // A thunk, not a value captured now: evaluated lazily at the actual read instant (strictly
  // after the failure settles and records lastUsageRefreshResultAt), so it is reliably NEWER in
  // wall-clock terms, not a value that happened to be captured a few ms before this test's own
  // setup work ran. +1000ms (not just "now"): everything in this fake-timer test runs
  // synchronously/microtask-fast enough that "now" at read time can land on the EXACT SAME
  // millisecond as lastUsageRefreshResultAt's Date.now() a few lines earlier -- a real tie, not
  // a test bug -- and the production code's `generated > lastUsageRefreshResultAt` is a strict
  // inequality (correctly: equal timestamps are not "newer"). The 1s margin only exists to give
  // this synthetic test a real, unambiguous gap; it says nothing about real-world timing.
  const justNow = () => new Date(Date.now() + 1000).toISOString();
  const failOnceProvider = (callIndex) => (callIndex === 0 ? { code: 1, stdout: "", stderr: "boom: disk full" } : null);
  // First read (the initial load): stale, triggers the auto-refresh, which fails.
  // Second read (after the failed run's own reload inside doRefresh): a FRESH, non-stale
  // snapshot -- simulating another writer (e.g. the SessionStart hook) having produced a newer
  // snapshot in the meantime.
  const tree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAtSequence: [twoHoursAgo, justNow, justNow],
    basePath: "/fake/vault",
    spawnOutcomeProvider: failOnceProvider,
    settleMs: 250,
  });
  const statusNode = findByClass(tree, "aios-usage-refresh-status");
  assert.ok(statusNode, "a refresh-status node must exist after the newer snapshot settles in");
  assert.doesNotMatch(
    statusNode.text,
    /Refresh failed/,
    `M4: once a snapshot NEWER than the recorded failure appears, the old failure text must clear -- got: ${JSON.stringify(statusNode.text)}`
  );
  assert.doesNotMatch(statusNode.text, /\(stale\)/, "M4: the newer snapshot is fresh, so no stale suffix either");
  console.log(`M4: failure text cleared once a newer snapshot appeared -- final status: "${statusNode.text}"`);

  // --- MUTATION: remove the "newer snapshot clears it" check. ------------------------------
  const removeNewerClearsCheck = (source) => {
    const needle = "const effectiveResult = Number.isFinite(generated) && generated > lastUsageRefreshResultAt ? null : lastUsageRefreshResult;";
    assert.ok(source.includes(needle), "the effectiveResult computation must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "const effectiveResult = lastUsageRefreshResult;");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const mutatedTree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAtSequence: [twoHoursAgo, justNow, justNow],
    basePath: "/fake/vault",
    spawnOutcomeProvider: failOnceProvider,
    mutateSource: removeNewerClearsCheck,
    settleMs: 250,
  });
  const mutatedStatus = findByClass(mutatedTree, "aios-usage-refresh-status");
  assert.match(
    mutatedStatus.text,
    /Refresh failed/,
    `MUTATION CHECK: with the "newer snapshot clears it" check removed, the stale failure text must WRONGLY stick next to fresh data -- got: ${JSON.stringify(mutatedStatus.text)}`
  );
  console.log(`M4 MUTATION (clear-check removed): failure text WRONGLY stuck -- "${mutatedStatus.text}". Reverted (never touched the tracked file).`);
}

// --- Round 2, Reviewer Minor M5: a failed refresh must be visible even when generatedAt cannot
// --- be parsed at all -- base (9369edc) showed the failure text in this exact case; round 1
// --- accidentally hid it behind "Snapshot generation time unavailable". -----------------------
{
  const failOnceProvider = (callIndex) => (callIndex === 0 ? { code: 1, stdout: "", stderr: "boom: disk full" } : null);
  const tree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: "not-a-date",
    basePath: "/fake/vault",
    spawnOutcomeProvider: failOnceProvider,
    settleMs: 250,
  });
  const statusNode = findByClass(tree, "aios-usage-refresh-status");
  assert.ok(statusNode, "a refresh-status node must exist even with an unparseable generatedAt");
  assert.match(
    statusNode.text,
    /Refresh failed \(boom: disk full\)/,
    `M5: an unparseable generatedAt must not hide a real failure -- got: ${JSON.stringify(statusNode.text)}`
  );
  console.log(`M5: failure visible despite unparseable generatedAt -- "${statusNode.text}"`);

  // --- MUTATION: restore the round-1 regression (check !Number.isFinite(generated) FIRST,
  // --- before refreshing/error/busy, same shape as base's opposite bug). --------------------
  const restoreUnavailableFirst = (source) => {
    const needle = "      const refreshStatusText = refreshing\n";
    assert.ok(source.includes(needle), "the refreshStatusText ternary must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, '      const refreshStatusText = !generatedText\n        ? "Snapshot generation time unavailable"\n        : refreshing\n');
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const mutatedTree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: "not-a-date",
    basePath: "/fake/vault",
    spawnOutcomeProvider: failOnceProvider,
    mutateSource: restoreUnavailableFirst,
    settleMs: 250,
  });
  const mutatedStatus = findByClass(mutatedTree, "aios-usage-refresh-status");
  assert.doesNotMatch(
    mutatedStatus.text,
    /Refresh failed/,
    `MUTATION CHECK: with the unavailable-first regression restored, a real failure must go WRONGLY invisible behind "Snapshot generation time unavailable" -- got: ${JSON.stringify(mutatedStatus.text)}`
  );
  assert.match(mutatedStatus.text, /unavailable/i);
  console.log(`M5 MUTATION (unavailable-first restored): failure WRONGLY hidden -- "${mutatedStatus.text}". Reverted (never touched the tracked file).`);
}

// --- Round 2, Reviewer Minor M6 (post-settle header re-render, "I'" in round 1): the
// --- CONTINUATION attached to the run that STARTS on click (`.finally(() => refresh())`,
// --- distinct from the unconditional trailing refresh() proven above) was unpinned in round 1
// --- -- removing it left `npm test` green even though it is what un-sticks the icon after a
// --- normal (non-hung) run settles. -------------------------------------------------------
{
  const successProvider = () => ({ code: 0, stdout: "usage-stats: 1 transcript(s) ..." });
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider });
  h.getRefreshBtn().click();
  await h.settle(150);
  const settledBtn = h.getRefreshBtn();
  assert.ok(!hasClass(settledBtn, "aios-refresh-spinning"), "the icon must stop spinning once a normal run settles");
  assert.equal(settledBtn.disabled, false, "the icon must be re-enabled once a normal run settles");
  console.log("M6 (post-settle re-render): icon un-stuck after a normal run settles.");

  const removePostSettleRefresh = (source) => {
    const needle = "      void refreshUsageSnapshot(app).finally(() => refresh());\n";
    assert.ok(source.includes(needle), "the post-settle continuation must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "      void refreshUsageSnapshot(app);\n");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const hMutated = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, mutateSource: removePostSettleRefresh });
  hMutated.getRefreshBtn().click();
  await hMutated.settle(150);
  const mutatedBtn = hMutated.getRefreshBtn();
  assert.ok(
    hasClass(mutatedBtn, "aios-refresh-spinning"),
    "MUTATION CHECK: with the post-settle continuation removed, the icon must WRONGLY stay spinning forever after a normal run settles (nothing ever re-renders the header to pick up usageRefreshInFlight clearing)"
  );
  console.log("M6 MUTATION (post-settle continuation removed): icon WRONGLY stuck spinning after settle. Reverted (never touched the tracked file).");
}

// --- Round 2, Reviewer Minor M6 (mobile gate, "G" in round 1): on mobile the header click must
// --- re-read the vault but never touch the exporter. Unpinned in round 1 -- flipping the gate
// --- to always-true left `npm test` green. ------------------------------------------------
{
  const successProvider = () => ({ code: 0, stdout: "usage-stats: 1 transcript(s) ..." });
  const h = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, isDesktop: false });
  const countBefore = h.getRefreshCount();
  h.getRefreshBtn().click();
  assert.equal(h.getRefreshCount(), countBefore + 1, "mobile: a click must still trigger the immediate vault re-read");
  assert.equal(spawnLog.length, 0, `mobile: a click must never launch the exporter -- got ${spawnLog.length} spawns`);
  console.log("M6 (mobile gate): click re-reads the vault, 0 exporter launches.");

  const removeMobileGate = (source) => {
    const needle = "  refreshBtn.addEventListener(\"click\", () => {\n    if (Platform.isDesktop) {\n";
    assert.ok(source.includes(needle), "the mobile gate must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "  refreshBtn.addEventListener(\"click\", () => {\n    if (true) {\n");
    assert.notEqual(mutated, source, "the mutation must actually change the source");
    return mutated;
  };
  const hMutated = await renderDashboardToCompletion({ spawnOutcomeProvider: successProvider, isDesktop: false, mutateSource: removeMobileGate });
  hMutated.getRefreshBtn().click();
  assert.equal(
    spawnLog.length,
    1,
    `MUTATION CHECK: with the mobile gate removed, a click on mobile must WRONGLY launch the exporter -- got ${spawnLog.length} spawns`
  );
  console.log(`M6 MUTATION (mobile gate removed): mobile click WRONGLY launched the exporter (${spawnLog.length} spawn). Reverted (never touched the tracked file).`);
}

console.log("usageRunWarnings.test.mjs: all assertions passed");
