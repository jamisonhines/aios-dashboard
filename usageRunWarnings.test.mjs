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
function installFakeChildProcess(spawnOutcomeProvider) {
  globalThis.require = (id) => {
    if (id === "child_process") {
      return {
        spawn() {
          const callIndex = spawnLog.length;
          spawnLog.push({ callIndex });
          const listeners = { data: [], error: [], exit: [] };
          const child = {
            stdout: {
              on(event, cb) {
                if (event === "data") listeners.data.push(cb);
              },
            },
            once(event, cb) {
              (listeners[event] ||= []).push(cb);
            },
          };
          const outcome = spawnOutcomeProvider ? spawnOutcomeProvider(callIndex) : { code: 1, stdout: "" };
          // A `null`/`undefined` outcome means "never resolve this one" -- used as a
          // deterministic circuit breaker: once a runaway-loop test has observed enough
          // spawns to prove its point, later calls hang forever instead of continuing to
          // recurse, so the chain terminates without any timing-dependent cap.
          if (outcome) {
            queueMicrotask(() => {
              if (outcome.stdout) for (const cb of listeners.data) cb(Buffer.from(outcome.stdout));
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
    createDiv(o = {}) { const c = fakeEl("div", o); c.parent = this; this.children.push(c); creationLog.push({ tag: "div", cls: c.cls, text: c.text }); return c; },
    createSpan(o = {}) { const c = fakeEl("span", o); c.parent = this; this.children.push(c); creationLog.push({ tag: "span", cls: c.cls, text: c.text }); return c; },
    createEl(name, o = {}) { const c = fakeEl(name, o); c.parent = this; this.children.push(c); creationLog.push({ tag: name, cls: c.cls, text: c.text }); return c; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    addEventListener() {},
    removeEventListener() {},
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
function findByClass(node, cls) {
  if (node.cls === cls) return node;
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
    const statsJson = JSON.stringify({ generatedAt: generatedAt ?? new Date().toISOString(), days: [], projects: [], windowDays: 35 });
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
            return statsJson;
          },
        },
      },
    };
    const settings = { usageStatsPath: statsPath, dailyBudgetUsd: 0 };
    const viewState = { expanded: new Set(), usageRange: "7d", usageOffset: 0 };
    const container = fakeEl();
    const periodbarHost = fakeEl();
    renderUsageTab(app, container, periodbarHost, settings, viewState);
    // renderUsageTab's own load is a real microtask chain (Promise.all -> .then); give it room
    // to settle before inspecting the tree.
    await new Promise((r) => setTimeout(r, settleMs));
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

  const refreshButtonEntries = creationLog.filter((e) => e.cls === "aios-refresh");
  assert.ok(refreshButtonEntries.length > 0, "R2-I1: the Refresh button must exist (be created) on every draw(), including the first");

  // The creation-log checks above prove draw() computed the right text at creation time, but
  // NOT that the elements are still attached anywhere by the time everything settles -- that
  // is precisely what the original R2-I1 bug got wrong: refreshStatus/refresh were created
  // once, outside/before draw(), and then draw()'s own body.empty() (running for the very
  // first time right after) permanently dropped them out of the tree with nothing left to
  // ever re-add them. A creation-log-only test cannot see that regression (the elements WERE
  // created, with correct text, before being wiped), so this checks the SETTLED tree too.
  assert.ok(findByClass(finalTree, "aios-usage-refresh-status"), "R2-I1: the refresh-status element must still be present in the rendered tree after everything settles, not just created-then-wiped by draw()'s body.empty()");
  assert.ok(findByClass(finalTree, "aios-refresh"), "R2-I1: the Refresh button must still be present in the rendered tree after everything settles, not just created-then-wiped by draw()'s body.empty()");
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

  // --- refreshTriggeredForThisLoad: correct code must spawn exactly once, even though every
  // --- busy response leaves the snapshot just as stale and would otherwise re-trigger. -------
  await renderUsageTabToCompletion({ statusJson: null, generatedAt: twoHoursAgo, basePath: "/fake/vault", spawnOutcomeProvider: busyOutcomeProvider, settleMs: 200 });
  assert.equal(spawnLog.length, 1, `R3-M1: with the guard intact, a persistently busy stale snapshot must trigger exactly ONE exporter launch per load, not one per busy response -- got ${spawnLog.length}`);

  // --- MUTATION: remove the guard (main.ts source string transform, never the tracked file --
  // --- see mutateSource on renderUsageTabToCompletion), rerun, capture the real RED. ----------
  const removeRefreshGuard = (source) => {
    const needle = "if (stale && !refreshTriggeredForThisLoad) {\n        refreshTriggeredForThisLoad = true;\n        void doRefresh();\n      }";
    assert.ok(source.includes(needle), "R3-M1: the refreshTriggeredForThisLoad guard must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "if (stale) {\n        void doRefresh();\n      }");
    assert.notEqual(mutated, source, "R3-M1: the mutation must actually change the source");
    return mutated;
  };
  await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: twoHoursAgo,
    basePath: "/fake/vault",
    spawnOutcomeProvider: busyOutcomeProvider,
    mutateSource: removeRefreshGuard,
    settleMs: 200,
  });
  // BUSY_CAP + 1, not BUSY_CAP: the (BUSY_CAP+1)th spawn call IS still logged (the log push
  // happens before the outcome lookup) -- it is the one whose outcome comes back `null` and
  // never resolves, which is what actually freezes the chain. Any count above 1 here already
  // proves the runaway; BUSY_CAP + 1 is the exact, deterministic value this circuit breaker
  // produces.
  assert.equal(
    spawnLog.length,
    BUSY_CAP + 1,
    `MUTATION CHECK: with refreshTriggeredForThisLoad removed, a persistently busy stale snapshot must WRONGLY keep re-triggering (capped here only by the test's own circuit breaker; Reviewer measured 63 spawns in 2s with no cap at all) -- proving the guard (not something else) was what stopped this. Got ${spawnLog.length} spawns.`
  );
  console.log(`R3-M1: refreshTriggeredForThisLoad guard -- intact: 1 spawn per load. MUTATION (guard removed): ${spawnLog.length}/${BUSY_CAP} spawns (runaway, capped only by the test harness). Reverted (never touched the tracked file).`);
}

{
  // --- lastRefreshWasBusy: a busy outcome must still say so after the redraw it triggers, not
  // --- silently look like a normal fresh Generated line. ----------------------------------
  const BUSY_CAP = 1;
  const busyOnceProvider = (callIndex) => (callIndex < BUSY_CAP ? { code: 0, stdout: "usage export busy; a live writer holds the lock" } : null);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const finalTree = await renderUsageTabToCompletion({ statusJson: null, generatedAt: twoHoursAgo, basePath: "/fake/vault", spawnOutcomeProvider: busyOnceProvider, settleMs: 200 });
  const refreshStatusNode = findByClass(finalTree, "aios-usage-refresh-status");
  assert.ok(refreshStatusNode, "R3-M1: a refresh-status node must exist after the busy redraw settles");
  assert.match(refreshStatusNode.text, /Another export was already in progress/, `R3-M1: with lastRefreshWasBusy intact, the settled text after a busy outcome must say another export was in progress -- got: ${JSON.stringify(refreshStatusNode.text)}`);

  // --- MUTATION: remove the `lastRefreshWasBusy = busy;` assignment (main.ts source string
  // --- transform, never the tracked file), rerun, capture the real RED. ----------------------
  const removeBusyFlag = (source) => {
    const needle = "            lastRefreshWasBusy = busy;\n";
    assert.ok(source.includes(needle), "R3-M1: the lastRefreshWasBusy assignment must be present verbatim before mutating it (fixture drift guard)");
    const mutated = source.replace(needle, "");
    assert.notEqual(mutated, source, "R3-M1: the mutation must actually change the source");
    return mutated;
  };
  const mutatedTree = await renderUsageTabToCompletion({
    statusJson: null,
    generatedAt: twoHoursAgo,
    basePath: "/fake/vault",
    spawnOutcomeProvider: busyOnceProvider,
    mutateSource: removeBusyFlag,
    settleMs: 200,
  });
  const mutatedNode = findByClass(mutatedTree, "aios-usage-refresh-status");
  assert.ok(mutatedNode, "sanity: a refresh-status node must still exist under the mutation");
  assert.doesNotMatch(
    mutatedNode.text,
    /Another export was already in progress/,
    `MUTATION CHECK: with lastRefreshWasBusy never set, the busy outcome's redraw must WRONGLY look like a normal fresh read, proving the flag (not something else) carries that distinction -- got: ${JSON.stringify(mutatedNode.text)}`
  );
  console.log(`R3-M1: lastRefreshWasBusy -- intact: busy text visible after redraw ("${refreshStatusNode.text}"). MUTATION (flag removed): busy text vanished ("${mutatedNode.text}"). Reverted (never touched the tracked file).`);
}

console.log("usageRunWarnings.test.mjs: all assertions passed");
