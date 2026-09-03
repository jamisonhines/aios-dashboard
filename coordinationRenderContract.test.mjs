// Render-contract coverage for the Coordination panel's TWO render functions
// in main.ts: renderCoordinationPills (the always-visible card-head pills)
// and renderCoordinationBody (the expanded card body). tsk-2026-09-03-002
// step 5 follow-up -- closes the Reviewer's sign-off condition on 969cfa8.
//
// Why this file exists: coordinationModel.test.mjs (companion file) proves
// computeCoordinationView's OUTPUT is correct -- specifically that
// `stale: false` is forced on every session in an untrustworthy ledger's
// view. It does NOT prove main.ts's rendering ever reads that field, or
// that the "parse warning" affordance the model's `untrustworthy`/`warnings`
// fields exist to drive is actually rendered anywhere a human would see it.
// Before this file, main.ts had no test harness at all: a mutation that
// disabled the PARSE WARNING group, or the "parse warning" pill, changed
// nothing the repo suite could detect, while a ledger's stale badge stayed
// correctly suppressed -- i.e. a human would see "N active", no stale
// badge, no warning, and reasonably conclude the ledger is fresh, when the
// true state is "we cannot tell." Suppression without a visible reason is
// itself a silent wrong answer; this file is what stops that regressing
// silently.
//
// DO NOT DELETE coordinationModel.test.mjs on the belief that THIS file
// covers the same ground. Measured (Reviewer, 4ca6f7b): this file's render
// assertions stay GREEN under a mutation that breaks model.mjs's own
// suppression rule alone (i.e. `stale: false` on an untrustworthy ledger's
// sessions no longer forced) -- this file does not construct a fixture that
// would ever produce a true `stale` flag on an untrustworthy view in the
// first place, since it drives computeCoordinationView through the SAME
// path that fixture would take either way, so it cannot detect a broken
// model there. coordinationModel.test.mjs is what pins that specific
// invariant at its source. The two files check different layers
// (model output vs. what main.ts's render functions do with that output)
// and neither is a substitute for the other.
//
// APPROACH (esbuild bundling, chosen over re-exporting the two functions
// from a separate always-importable module): main.ts is a real Obsidian
// plugin entry point -- it imports the `obsidian` package, which does not
// exist outside Obsidian's own runtime, so it cannot be `import`ed directly
// by a plain Node test the way model.mjs can. esbuild is already a
// devDependency (see package.json) purely for this reason: bundle the
// ACTUAL shipped main.ts (byte-identical to what `npm run build` packages,
// this file never edits or copies-with-modifications the source it reads),
// with the `obsidian` import aliased to a minimal local stub covering only
// the classes/functions main.ts's top-level import list names, and with an
// export line appended so the two otherwise-private render functions (plus
// gatherCoordinationInputs and applyLedgerReadFailureNotice, for the
// gather-layer regression test below) become reachable from a plain Node
// script. This was chosen over "export them from main.ts permanently"
// because that would mean shipping test-only exports in the real plugin
// bundle; appending them to a disposable copy at test time keeps main.ts's
// shipped shape untouched while still exercising the REAL function bodies,
// not a hand-copied approximation of them that could silently drift.
//
// Every file this build step writes lives OUTSIDE this repo (os.tmpdir()),
// with exactly one narrow exception: esbuild's entryPoints must resolve
// main.ts's own `import ... from "./model.mjs"` correctly, which requires
// the entry file to sit in this repo's root (esbuild resolves relative
// specifiers against the importing file's own directory, not
// absWorkingDir). That one entry file is named with a leading dot,
// created immediately before the build call and removed in a `finally`
// immediately after -- see buildRenderContractBundle() below. Run this
// file's assertions in isolation with `node coordinationRenderContract.test.mjs`
// and confirm `git status` afterward if verifying this comment's claim.
//
// Run: node coordinationRenderContract.test.mjs
import assert from "node:assert";
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeCoordinationView } from "./model.mjs";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

const OBSIDIAN_STUB_SOURCE = [
  "export class App {}",
  "export class ItemView {}",
  "export class Menu {}",
  "export class Modal {}",
  "export class Notice {}",
  "export const Platform = { isMobile: false };",
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

// Appended verbatim to a disposable copy of main.ts's own source. Every name
// on the right of `as` is exactly the private function name main.ts
// declares; nothing here changes what those functions do.
const EXPORT_APPEND =
  "\nexport {\n" +
  "  renderCoordinationPills as __renderCoordinationPills,\n" +
  "  renderCoordinationBody as __renderCoordinationBody,\n" +
  "  gatherCoordinationInputs as __gatherCoordinationInputs,\n" +
  "  applyLedgerReadFailureNotice as __applyLedgerReadFailureNotice,\n" +
  "};\n" +
  'export { TFile as __TFile } from "obsidian";\n';

function buildRenderContractBundle() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-dashboard-render-contract-"));
  const stubPath = path.join(tmpDir, "obsidian-stub.mjs");
  const outfile = path.join(tmpDir, "bundle.mjs");
  const entryName = ".coordination-render-contract-entry.ts";
  const entryPath = path.join(REPO_ROOT, entryName);

  fs.writeFileSync(stubPath, OBSIDIAN_STUB_SOURCE);
  const mainSource = fs.readFileSync(path.join(REPO_ROOT, "main.ts"), "utf8");
  fs.writeFileSync(entryPath, mainSource + EXPORT_APPEND);

  try {
    esbuild.buildSync({
      absWorkingDir: REPO_ROOT,
      entryPoints: [entryName],
      bundle: true,
      format: "esm",
      target: "es2018",
      treeShaking: false,
      outfile,
      // child_process is `require()`d (desktop-Obsidian-only, launch-command
      // feature) inside a function this file never calls; electron and the
      // editor-extension packages are never imported by the coordination
      // code path at all. Marking them external means esbuild leaves the
      // reference alone rather than failing to resolve a package this
      // sandbox has no reason to install.
      external: ["electron", "child_process", "@codemirror/*", "@lezer/*"],
      alias: { obsidian: stubPath },
      logLevel: "warning",
    });
  } finally {
    fs.rmSync(entryPath, { force: true });
  }

  return { tmpDir, outfile };
}

async function loadRenderContractModule() {
  const { tmpDir, outfile } = buildRenderContractBundle();
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fakedom: a minimal recording stand-in for the Obsidian HTMLElement helpers
// the two render functions actually call (createDiv/createSpan/createEl/
// classList.toggle/addClass/setText/empty). Deliberately not jsdom -- this
// records the exact tree the shipped code builds via Obsidian's own DOM
// extension methods, which is what the step-5 contract is about, not
// generic HTML semantics.
// ---------------------------------------------------------------------------
function El(tag = "div") {
  const self = {
    tag,
    cls: [],
    text: "",
    children: [],
    classList: {
      toggle(c) {
        const i = self.cls.indexOf(c);
        if (i >= 0) {
          self.cls.splice(i, 1);
          return false;
        }
        self.cls.push(c);
        return true;
      },
      contains: (c) => self.cls.includes(c),
      add: (c) => self.cls.push(c),
    },
    empty() {
      self.children.length = 0;
      return self;
    },
    addClass(c) {
      self.cls.push(c);
      return self;
    },
    setText(t) {
      self.text = t;
      return self;
    },
    addEventListener() {},
    querySelectorAll() {
      return { forEach() {} };
    },
    _mk(tag, o = {}) {
      const c = El(tag);
      if (typeof o === "string") c.cls.push(...o.split(" ").filter(Boolean));
      else {
        if (o.cls) c.cls.push(...String(o.cls).split(" ").filter(Boolean));
        if (o.text != null) c.text = String(o.text);
      }
      self.children.push(c);
      return c;
    },
    createDiv(o) {
      return self._mk("div", o);
    },
    createSpan(o) {
      return self._mk("span", o);
    },
    createEl(tag, o) {
      return self._mk(tag, o);
    },
    setAttribute() {},
    removeAttribute() {},
    setAttr() {},
    focus() {},
    style: {},
  };
  return self;
}

function flatten(el, out = []) {
  out.push({ tag: el.tag, cls: el.cls.join(" "), text: el.text });
  for (const c of el.children) flatten(c, out);
  return out;
}

function findByCls(el, cls) {
  return flatten(el).filter((n) => n.cls.split(" ").includes(cls));
}

// ---------------------------------------------------------------------------
// Ledger fixtures. Same 8-column GL-011 table shape (Session | Session id |
// State | Branch | Worktree | Write-set | Started | Last update) the vault's
// own coordination-parse.mjs/coordination-accounting.mjs suite fixtures use.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-09-04T12:00:00Z");
const OLD = "2026-09-01T00:00:00Z"; // > 24h before NOW: genuinely stale
const H8 = "| Session | Session id | State | Branch | Worktree | Write-set | Started | Last update |";
const S8 = "|---|---|---|---|---|---|---|---|";
const row = (n, st, upd) => `| ${n} | id-${n} | ${st} | feat/${n} | ~/wt | app/${n}.ts | 2026-09-01 | ${upd} |`;
const FRONT_MATTER = ["---", "project: p", "updated: 2026-09-03", "---", "", "# Work Ledger", ""];
const TAIL = ["", "## Session notes", "", "### s1", "", "prose", "", "## Merge queue", "", "## WIP rules", ""];

// Control group: trustworthy parse, one genuinely stale claim. The panel
// SHOULD show the stale badge and MUST NOT show any warning.
const CLEAN_STALE_LEDGER = [...FRONT_MATTER, "## Active sessions", "", H8, S8, row("s-stale", "active", OLD), ...TAIL].join(
  "\n"
);

// Untrustworthy: a stray claim-shaped row sitting outside the recognized
// Active sessions span (Reviewer's Critical-1 shape -- findStrayClaimRows'
// own channel), alongside a claim that IS correctly parsed and would
// otherwise read as stale. The panel must suppress the stale badge on the
// parsed claim, keep rendering that claim (refuse the action, not the
// answer), and surface the parse warning loudly.
const UNTRUSTWORTHY_STRAY_ROW_LEDGER = [
  ...FRONT_MATTER,
  "## Active sessions",
  "",
  H8,
  S8,
  row("s-stale", "active", OLD),
  "",
  "## Session notes",
  row("s-LOST", "active", OLD),
  "",
  "### s1",
  "",
  "prose",
  "",
  "## Merge queue",
  "",
  "## WIP rules",
  "",
].join("\n");

function renderLedger(mod, ledgerContent, questionsContent = null) {
  const [view] = computeCoordinationView([{ slug: "p", ledgerContent, questionsContent }], NOW);
  const pills = El();
  mod.__renderCoordinationPills(pills, view);
  const body = El();
  mod.__renderCoordinationBody(
    {},
    { projectsRoot: "Projects" },
    body,
    view,
    { expanded: new Set(), coordinationQuestionFilter: new Map(), coordinationDrafts: new Map() },
    () => {},
    {}
  );
  return { view, pills, body };
}

const mod = await loadRenderContractModule();

// ---------------------------------------------------------------------------
// Call-site assertion (Reviewer's reproduction against 4ca6f7b): every
// assertion in this file below this point calls mod.__renderCoordinationPills
// / mod.__renderCoordinationBody DIRECTLY -- by construction that proves the
// two functions behave correctly, but NOT that the real panel still calls
// THEM. The Reviewer proved this gap for real: left renderCoordinationBody
// untouched, added a renderCoordinationBodyV2 that renders sessions but
// drops the PARSE WARNING group entirely, and pointed the one real caller
// (main.ts, ~line 2079) at V2. Every assertion in this file still passed --
// they were exercising a function nobody runs. tsc cannot catch this either:
// a well-typed V2 compiles fine. A plain rename is already caught loudly
// (EXPORT_APPEND above references the function by its old name, so the
// bundle build itself throws if that name is gone); only the "add new, keep
// old, switch the caller" shape is silent, and that is the one shape this
// check targets.
//
// assertRealCallSite reads main.ts's OWN source text (the same bytes the
// bundle above is built from, not a copy) and counts CALL sites of `name(`
// that are not the function's own declaration line, via a negative
// lookbehind on "function ". The word boundary immediately before the "("
// is doing the real work: a switched caller reading `renderCoordinationBodyV2(`
// does NOT match `\brenderCoordinationBody\(` at all -- the characters
// between "Body" and "(" are "V2", not nothing -- so the real-call count
// drops from 1 to 0 and this reds. This is deliberately a source-text
// check, not a black-box "does calling the exported function work" check
// (which is what every other assertion in this file already is, and which
// is exactly what stayed green under the Reviewer's mutation): the property
// under test IS the wiring between the call site and the definition, not
// either one's own behavior.
// ---------------------------------------------------------------------------
function assertRealCallSite(mainSource, name, expectedCount) {
  const re = new RegExp(`(?<!function )\\b${name}\\s*\\(`, "g");
  const matches = [...mainSource.matchAll(re)];
  assert.equal(
    matches.length,
    expectedCount,
    `main.ts must call ${name}(...) exactly ${expectedCount} time(s) outside its own declaration -- ` +
      `found ${matches.length}. If this dropped, the panel's real render call site was pointed at a ` +
      `different function (e.g. a "V2" you added) while ${name} itself still exists and still passes ` +
      `its own behavioral tests unchanged -- those tests call ${name} directly and cannot see what the ` +
      `real caller in main.ts actually invokes.`
  );
}

{
  const mainSourceForCallSiteCheck = fs.readFileSync(path.join(REPO_ROOT, "main.ts"), "utf8");
  assertRealCallSite(mainSourceForCallSiteCheck, "renderCoordinationPills", 1);
  assertRealCallSite(mainSourceForCallSiteCheck, "renderCoordinationBody", 1);
}

// --- control group: clean ledger renders its stale badge and NO warning ---
{
  const { view, pills, body } = renderLedger(mod, CLEAN_STALE_LEDGER);
  assert.equal(view.untrustworthy, false, "control fixture must actually be trustworthy");
  assert.equal(view.activeSessions[0].stale, true, "control fixture's claim must actually be stale");

  assert.equal(findByCls(pills, "aios-coord-stale-pill").length, 1, "clean+stale: head stale pill must render");
  assert.equal(findByCls(body, "aios-coord-stale-pill").length, 1, "clean+stale: row stale pill must render");
  assert.equal(findByCls(body, "aios-coord-session-stale").length, 1, "clean+stale: stale row class must render");

  assert.equal(findByCls(pills, "aios-coord-warning-pill").length, 0, "clean ledger: no warning pill");
  assert.equal(findByCls(body, "aios-coord-group-warning").length, 0, "clean ledger: no PARSE WARNING group");
  assert.equal(findByCls(body, "aios-coord-warning-line").length, 0, "clean ledger: no warning lines");
}

// --- untrustworthy ledger: every required contract at once ---
{
  const { view, pills, body } = renderLedger(mod, UNTRUSTWORTHY_STRAY_ROW_LEDGER);
  assert.equal(view.untrustworthy, true, "stray-row fixture must actually be untrustworthy");

  // M-C: PARSE WARNING group renders in the body, listing the warning lines.
  const warnGroup = findByCls(body, "aios-coord-group-warning");
  assert.equal(warnGroup.length, 1, "untrustworthy: PARSE WARNING group must render");
  const warnLines = findByCls(body, "aios-coord-warning-line");
  assert.ok(warnLines.length >= 1, "untrustworthy: at least one warning line must render");
  assert.deepEqual(
    warnLines.map((l) => l.text),
    view.warnings,
    "every warnings[] entry from the model must render as its own warning line, in order"
  );
  assert.ok(
    warnLines.some((l) => l.text.includes("stray claim-shaped row")),
    "the specific stray-row warning text must be visible in the panel, not just present in the model"
  );

  // M-D: "parse warning" pill renders in the always-visible card head.
  const warnPill = findByCls(pills, "aios-coord-warning-pill");
  assert.equal(warnPill.length, 1, "untrustworthy: head 'parse warning' pill must render");
  assert.equal(warnPill[0].text, "parse warning");

  // Stale affordance completely absent: head pill, row pill, row class -- all three.
  assert.equal(findByCls(pills, "aios-coord-stale-pill").length, 0, "untrustworthy: no head stale pill");
  assert.equal(findByCls(body, "aios-coord-stale-pill").length, 0, "untrustworthy: no row stale pill");
  assert.equal(findByCls(body, "aios-coord-session-stale").length, 0, "untrustworthy: no stale row class");

  // Sessions are still rendered -- refuse the ACTION (trusting the stale
  // badge), never the ANSWER (the session list itself).
  const sessionRows = findByCls(body, "aios-coord-session-row");
  assert.equal(sessionRows.length, 1, "untrustworthy: the correctly-parsed claim must still render");
  assert.deepEqual(
    findByCls(body, "aios-coord-session-name").map((n) => n.text),
    ["s-stale"],
    "the session name itself must still be visible"
  );

  // main.ts:3867-3873 states, in its own comment, that PARSE WARNING renders
  // FIRST, above ACTIVE SESSIONS, "so it is the first thing visible once a
  // card expands rather than sitting below a session list that itself looks
  // perfectly normal." That is a claimed contract property, not just a
  // presence check -- assert the ORDER of the two top-level groups in the
  // body's own DOM tree, not merely that both exist somewhere in it.
  // Measured: swapping the two blocks in main.ts passed every assertion
  // above this one green.
  const topLevelGroups = body.children;
  const warningIdx = topLevelGroups.findIndex((c) => c.cls.includes("aios-coord-group-warning"));
  // "aios-coord-group" with NO other class is the ACTIVE SESSIONS group
  // specifically -- the warning group and the questions group both carry a
  // second class alongside it (see renderCoordinationBody), so an exact
  // match is unambiguous.
  const activeIdx = topLevelGroups.findIndex((c) => c.cls.join(" ") === "aios-coord-group");
  assert.ok(warningIdx !== -1, "PARSE WARNING group must be a top-level child of the body");
  assert.ok(activeIdx !== -1, "ACTIVE SESSIONS group must be a top-level child of the body");
  assert.ok(
    warningIdx < activeIdx,
    `PARSE WARNING group must render BEFORE ACTIVE SESSIONS (main.ts:3867 order contract) -- got warning at index ${warningIdx}, active sessions at index ${activeIdx}`
  );
}

// ---------------------------------------------------------------------------
// Pill-count fidelity (Reviewer round on 4ca6f7b, Important 1): the
// pre-d1611c9 panel filtered on status === "active" and silently rendered
// "0 active" against a fully-populated, correctly-migrated ledger -- this
// whole branch exists to fix that. model.mjs pins the underlying counts
// (coordinationModel.test.mjs); nothing before this block pinned that
// renderCoordinationPills actually SHOWS them on screen. Measured: ten
// mutations against the harness as it stood on 4ca6f7b, six survived,
// including all three pill counts hardcoded to 0.
//
// Fixture uses three counts that are PAIRWISE DISTINCT and neither 0 nor 1,
// so every relevant mutation shape reds: a hardcoded 0 (the real count
// isn't 0), a hardcoded 1 (the real count isn't 1), and a swapped pair (the
// three values differ, so showing count B behind label A is visible). Pills
// are matched by their rendered text suffix (" active" / " unlanded" /
// " questions"), not by position in the container, so this also catches a
// mutation that renders the three pills in a different order.
// ---------------------------------------------------------------------------
const DISTINCT_COUNTS_LEDGER = [
  ...FRONT_MATTER,
  "## Active sessions",
  "",
  H8,
  S8,
  row("s-one", "active", "2026-09-04T11:00:00Z"),
  row("s-two", "active", "2026-09-04T11:30:00Z"),
  "",
  "## Merge queue",
  "",
  "### Landing order",
  "",
  "1. feat/a - landed",
  "2. feat/b - ready",
  "3. feat/c - ready",
  "4. feat/d - ready",
  "",
  "## WIP rules",
  "",
].join("\n");

const DISTINCT_COUNTS_QUESTIONS = [
  "---",
  "project: p",
  "updated: 2026-09-03",
  "---",
  "",
  "# Questions for Jaymo",
  "",
  "## Open",
  "",
  "### Q-2026-09-01-01 Q one",
  "- Context: c",
  "- Answer:",
  "",
  "### Q-2026-09-01-02 Q two",
  "- Context: c",
  "- Answer:",
  "",
  "### Q-2026-09-01-03 Q three",
  "- Context: c",
  "- Answer:",
  "",
  "### Q-2026-09-01-04 Q four",
  "- Context: c",
  "- Answer:",
  "",
  "## Answered",
  "",
  "(none)",
  "",
].join("\n");

{
  const { view, pills } = renderLedger(mod, DISTINCT_COUNTS_LEDGER, DISTINCT_COUNTS_QUESTIONS);

  // Fixture sanity: prove the three counts are what this block's own
  // reasoning depends on before trusting anything derived from them.
  assert.equal(view.activeSessions.length, 2, "fixture sanity: 2 active sessions");
  assert.equal(view.unlanded, 3, "fixture sanity: 3 unlanded landing-order items");
  assert.equal(view.questions.length, 4, "fixture sanity: 4 open questions");
  const counts = [view.activeSessions.length, view.unlanded, view.questions.length];
  assert.equal(new Set(counts).size, 3, "fixture sanity: the three counts must be pairwise distinct");
  for (const c of counts) {
    assert.ok(c !== 0 && c !== 1, "fixture sanity: no count may be 0 or 1, or a hardcode/off-by-one mutation could hide behind it");
  }

  const pillTextFor = (label) => {
    const matches = findByCls(pills, "aios-pill").filter((p) => p.text.endsWith(` ${label}`));
    assert.equal(matches.length, 1, `exactly one rendered pill must end with " ${label}"`);
    return matches[0].text;
  };
  assert.equal(
    pillTextFor("active"),
    `${view.activeSessions.length} active`,
    "active pill must render the real activeSessions.length, not a hardcoded value"
  );
  assert.equal(
    pillTextFor("unlanded"),
    `${view.unlanded} unlanded`,
    "unlanded pill must render the real view.unlanded, not a hardcoded value"
  );
  assert.equal(
    pillTextFor("questions"),
    `${view.questions.length} questions`,
    "questions pill must render the real view.questions.length, not a hardcoded value"
  );
}

// ---------------------------------------------------------------------------
// Gather-layer regression test (Reviewer's Minor on 969cfa8): distinguishes
// "could not read work-ledger.md at all" from "read it fine, no Active
// sessions heading yet" -- both degraded to the exact same ledgerContent=""
// before this fix, both producing the identical, and for the first case
// FALSE, "no '## Active sessions' heading found in this file at all"
// wording. Fixed at the gather layer only (gatherCoordinationInputs's new
// ledgerReadFailed flag, consumed by applyLedgerReadFailureNotice at the
// render call site) -- describeActiveSessionsWarnings itself, shared
// verbatim with coordination-report.mjs and aios-health.mjs, is untouched;
// this asserts that directly by re-computing the "read fine, no heading
// yet" case's warnings straight from the untouched model and confirming
// the wording did not change for that shape.
// ---------------------------------------------------------------------------
{
  const FRESHLY_ADOPTED_LEDGER = [
    "---",
    "project: p",
    "convention: session-coordination v1",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Merge queue",
    "",
    "## WIP rules",
    "",
  ].join("\n");
  const MISLEADING_LINE =
    "ACCOUNTING CONTROL COULD NOT RUN (Projects/p/work-ledger.md): no '## Active sessions' " +
    "heading found in this file at all";

  // Shape 1: gatherCoordinationInputs when the ledger file does not exist at all.
  const fileMissingApp = {
    vault: {
      getAbstractFileByPath() {
        return null;
      },
      async cachedRead() {
        throw new Error("must not be called: no TFile was returned");
      },
    },
  };
  const [missingInput] = await mod.__gatherCoordinationInputs(fileMissingApp, "Projects", ["p"]);
  assert.equal(missingInput.ledgerReadFailed, true, "missing file: ledgerReadFailed must be true");
  assert.equal(missingInput.ledgerContent, "", "missing file: ledgerContent still degrades to \"\"");

  // Shape 1b: gatherCoordinationInputs when the file exists but cachedRead throws.
  const readThrowsApp = {
    vault: {
      getAbstractFileByPath() {
        const f = new mod.__TFile();
        f.path = "Projects/p/work-ledger.md";
        return f;
      },
      async cachedRead() {
        throw new Error("simulated vault read failure");
      },
    },
  };
  const [throwsInput] = await mod.__gatherCoordinationInputs(readThrowsApp, "Projects", ["p"]);
  assert.equal(throwsInput.ledgerReadFailed, true, "cachedRead throws: ledgerReadFailed must be true");

  // Shape 2: gatherCoordinationInputs when the file exists and reads fine,
  // but is a freshly-adopted ledger with no Active sessions heading yet.
  const readsFineApp = {
    vault: {
      getAbstractFileByPath() {
        const f = new mod.__TFile();
        f.path = "Projects/p/work-ledger.md";
        return f;
      },
      async cachedRead() {
        return FRESHLY_ADOPTED_LEDGER;
      },
    },
  };
  const [readFineInput] = await mod.__gatherCoordinationInputs(readsFineApp, "Projects", ["p"]);
  assert.equal(readFineInput.ledgerReadFailed, false, "read succeeded: ledgerReadFailed must be false");
  assert.equal(readFineInput.ledgerContent, FRESHLY_ADOPTED_LEDGER);

  // The model layer genuinely cannot tell these two shapes apart on its own
  // -- both a read failure (ledgerContent "") and a freshly-adopted ledger
  // (no heading, but real content) hit the exact same
  // checkActiveSessionsAccounting `ran:false` branch and produce identical
  // wording. This is the bug: prove it's still true of the untouched model
  // layer, then prove the gather-layer fix corrects only the read-failure
  // case's OWN warnings, leaving the freshly-adopted case exactly as-is.
  const [emptyView] = computeCoordinationView([{ slug: "p", ledgerContent: "", questionsContent: null }], NOW);
  const [freshView] = computeCoordinationView(
    [{ slug: "p", ledgerContent: FRESHLY_ADOPTED_LEDGER, questionsContent: null }],
    NOW
  );
  assert.deepEqual(
    emptyView.warnings,
    freshView.warnings,
    "model layer alone cannot distinguish the two shapes -- this is exactly why the fix has to live at the gather layer"
  );
  assert.ok(
    emptyView.warnings.includes(MISLEADING_LINE),
    "CROSS-REPO COUPLING BROKE: this dashboard repo's MISLEADING_LINE constant (above, in this file) is a " +
      "hardcoded copy of the wording checkActiveSessionsAccounting produces in the VAULT repo's " +
      "~/AIOS/Operations/scripts/lib/coordination-accounting.mjs (model.mjs imports that file directly, not a " +
      "local copy). If you only just edited coordination-accounting.mjs and have no idea why an aios-dashboard " +
      "test failed, this is why: its wording changed. Fix by updating MISLEADING_LINE (and the `accurate` " +
      "replacement text in main.ts's applyLedgerReadFailureNotice, if that's what changed) to match the new " +
      "vault wording, not by weakening this assertion."
  );

  // applyLedgerReadFailureNotice: read-failure case gets the accurate line,
  // freshly-adopted case is untouched (still says exactly what
  // describeActiveSessionsWarnings said, unmodified).
  const fixedReadFailureView = mod.__applyLedgerReadFailureNotice(emptyView, "Projects/p/work-ledger.md");
  assert.ok(
    !fixedReadFailureView.warnings.includes(MISLEADING_LINE),
    "read-failure case: the misleading 'no heading found' line must be gone"
  );
  assert.ok(
    fixedReadFailureView.warnings.some((w) => w.startsWith("could not read Projects/p/work-ledger.md")),
    "read-failure case: an accurate 'could not read' line must be present"
  );
  assert.equal(fixedReadFailureView.untrustworthy, true, "read-failure case: still untrustworthy");

  assert.deepEqual(
    freshView.warnings,
    [MISLEADING_LINE, freshView.warnings[1]],
    "freshly-adopted case is a real, accurate finding and must NOT be touched by the read-failure fix"
  );
}

console.log("coordinationRenderContract.test.mjs: all assertions passed");
