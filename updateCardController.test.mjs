import "./testFileTimeout.mjs";
// Fix round 1 of the update card (review 2026-10-23): the check/apply wiring moved out of main.ts
// into createUpdateController so it is tested here. A fake engine stands in for the spawn; each run
// is a deferred promise the test settles by hand, so in-flight states can be observed.
import assert from "node:assert";
import {
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_APPLY_SLOW_MS,
  createUpdateController,
} from "./updateCard.mjs";

const SEEN = "1111111111111111111111111111111111111111";
const LATER = "2222222222222222222222222222222222222222";
const status = (over = {}) => ({
  schema: 3,
  template: { source: "/t", ref: "main", commit: SEEN, version: "0.2.0" },
  installed: { version: "0.1.0", commit: "x" },
  updateAvailable: true,
  changelog: "## 0.2.0\n- notes",
  files: [{ path: "AGENTS.md", action: "modify" }, { path: ".obsidian/plugins/aios-dashboard/main.js", action: "modify" }],
  codeChanges: { required: true, note: "x", paths: [".obsidian/plugins/aios-dashboard/main.js"] },
  plugin: { id: "aios-dashboard", installed: "1.0.0", incoming: "2.15.0", changes: true },
  blockers: [],
  ...over,
});
const ok = (s) => ({ started: true, exitCode: 0, stdout: JSON.stringify(s), stderr: "", spawnError: null, engineExists: true });
const applied = { started: true, exitCode: 0, stdout: JSON.stringify({ ...status(), committed: "a".repeat(40), refusals: [], refused: [], pluginChanged: true }), stderr: "", spawnError: null };

function harness({ isDesktop = true } = {}) {
  const runs = [];
  const timers = [];
  let changes = 0;
  const runEngine = (basePath, argv, opts) => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    runs.push({ basePath, argv, opts, resolve });
    return p;
  };
  const ctl = createUpdateController({
    runEngine,
    isDesktop,
    getBasePath: () => "/vault",
    onChange: () => { changes++; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  });
  const settle = async (i, raw) => { runs[i].resolve(raw); await new Promise((r) => setTimeout(r, 0)); };
  return { ctl, runs, timers, settle, changes: () => changes };
}
const kind = (run) => run.argv[1];

// ---------------------------------------------------------------- check wiring
{
  const h = harness();
  h.ctl.ensureChecked();
  assert.equal(h.runs.length, 1, "CTL-1 first render starts one check");
  assert.deepEqual(h.runs[0].argv, ["Operations/scripts/aios-update.mjs", "check", "--json"], "CTL-2 check argv");
  assert.equal(h.runs[0].basePath, "/vault", "CTL-3 runs from the vault root");
  assert.equal(h.runs[0].opts.timeoutMs, UPDATE_CHECK_TIMEOUT_MS, "CTL-4 check keeps its kill timeout");
  assert.equal(UPDATE_CHECK_TIMEOUT_MS, 120_000, "CTL-5 check timeout value");
  h.ctl.ensureChecked();
  h.ctl.checkNow();
  assert.equal(h.runs.length, 1, "CTL-6 never two checks at once");
  const v = h.ctl.view();
  assert.equal(v.headText, "Checking for AIOS updates...", "CTL-7 checking text");
  assert.equal(v.checkDisabled, true, "CTL-8 Check now disabled while checking");
  assert.equal(v.showUpdate, false, "CTL-9 no Update button before a result");
}
{
  const h = harness({ isDesktop: false });
  h.ctl.ensureChecked();
  assert.equal(h.runs.length, 0, "CTL-10 mobile never spawns");
  assert.equal(h.ctl.view().visible, false, "CTL-11 mobile shows no card");
}

// ---------------------------------------------------------------- the button follows the card, and go() carries the owner's consent
{
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status()));
  const v = h.ctl.view();
  assert.equal(v.showUpdate, true, "CTL-12 Update button after a clean check");
  assert.equal(v.headText, "AIOS update ready: 0.2 (you have 0.1)", "CTL-13 headline from the card");
  const req = h.ctl.requestUpdate();
  assert.equal(req.confirmLabel, "Update, including code", "CTL-14 the confirm names code");
  assert.match(req.body, /new dashboard code/, "CTL-15 confirm body from updateConfirmText");
  req.go();
  assert.equal(h.runs.length, 2, "CTL-16 go() starts apply");
  assert.deepEqual(h.runs[1].argv, ["Operations/scripts/aios-update.mjs", "apply", "--json", "--expect-commit", SEEN, "--allow-code"], "CTL-17 apply carries the checked commit and the code consent");
  assert.equal(h.runs[1].opts.timeoutMs, null, "CTL-18 apply has no kill timeout (review m-2)");
  assert.equal(h.ctl.view().headText, "Updating AIOS...", "CTL-19 updating text");
  assert.equal(h.ctl.view().showUpdate, false, "CTL-20 no Update button while applying");
  await h.settle(1, applied);
  assert.equal(h.runs.length, 3, "CTL-21 a re-check follows the apply");
  assert.equal(kind(h.runs[2]), "check", "CTL-22 the follow-up is a check");
  assert.match(h.ctl.view().outcome.headline, /AIOS updated to 0\.2\.0 in commit aaaaaaa/, "CTL-23 the outcome is shown");
  await h.settle(2, ok(status({ updateAvailable: false, files: [] })));
  h.ctl.recheck();
  assert.ok(h.ctl.view().outcome, "CTL-23b a dashboard re-open (recheck) keeps the commit and undo line on screen");
  h.ctl.checkNow();
  assert.equal(h.ctl.view().outcome, null, "CTL-23c Check now clears it");
}
{
  // No code in the update: the confirm passes no code flag.
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status({ codeChanges: { required: false, note: "x", paths: [] }, plugin: { id: "aios-dashboard", installed: "2.15.0", incoming: "2.15.0", changes: false } })));
  h.ctl.requestUpdate().go();
  assert.deepEqual(h.runs[1].argv, ["Operations/scripts/aios-update.mjs", "apply", "--json", "--expect-commit", SEEN], "CTL-24 a plain update passes no code flag");
}
{
  // Blocked card: no button and no request.
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status({ blockers: [{ kind: "safety", message: "m", paths: [".claude/hooks/x.py"] }] })));
  assert.equal(h.ctl.view().showUpdate, false, "CTL-25 blocked card has no Update button");
  assert.equal(h.ctl.requestUpdate(), null, "CTL-26 no update request on a blocked card");
}

// ---------------------------------------------------------------- REQ-F2: the consent stays tied to what the owner saw
{
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status()));
  const req = h.ctl.requestUpdate(); // the dialog opens on the SEEN result
  h.ctl.checkNow(); // another view re-checks while the dialog is open
  await h.settle(1, ok(status({ template: { source: "/t", ref: "main", commit: LATER, version: "0.3.0" } })));
  req.go();
  assert.ok(h.runs[2].argv.includes(SEEN), "CTL-F2-1 apply carries the commit the owner saw in the dialog");
  assert.ok(!h.runs[2].argv.includes(LATER), "CTL-F2-2 never the commit of a later check");
}

// ---------------------------------------------------------------- REQ-F4 (review m-3): a confirm during a check is queued, never dropped
{
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status()));
  const req = h.ctl.requestUpdate();
  h.ctl.checkNow();
  assert.equal(h.runs.length, 2, "CTL-Q-1 a check is running");
  req.go();
  assert.equal(h.runs.length, 2, "CTL-Q-2 apply waits for the check");
  const v = h.ctl.view();
  assert.equal(v.status, "Your update starts when the check finishes.", "CTL-Q-3 visible queued text");
  assert.equal(v.showUpdate, false, "CTL-Q-4 the Update button is hidden during a check");
  await h.settle(1, ok(status()));
  assert.equal(h.runs.length, 3, "CTL-Q-5 the queued update starts after the check");
  assert.equal(kind(h.runs[2]), "apply", "CTL-Q-6 it is the apply");
  assert.ok(h.runs[2].argv.includes("--allow-code"), "CTL-Q-7 with the consent given in the dialog");
}
{
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status()));
  const req = h.ctl.requestUpdate();
  req.go();
  req.go();
  assert.equal(h.runs.filter((r) => kind(r) === "apply").length, 1, "CTL-Q-8 a second confirm never starts a second apply");
  assert.equal(h.ctl.view().status, "An update is already running.", "CTL-Q-9 and says so");
}

// ---------------------------------------------------------------- REQ-F4 (review m-2): slow apply is reported, never killed
{
  const h = harness();
  h.ctl.ensureChecked();
  await h.settle(0, ok(status()));
  h.ctl.requestUpdate().go();
  const slow = h.timers.find((t) => t.ms === UPDATE_APPLY_SLOW_MS);
  assert.ok(slow, "CTL-T-1 a slow-apply notice timer is set");
  assert.equal(UPDATE_APPLY_SLOW_MS, 300_000, "CTL-T-2 after five minutes");
  slow.fn();
  assert.equal(h.ctl.view().status, "Still updating after 5 minutes. Leave Obsidian open. If it never finishes, ask Dispatch.", "CTL-T-3 slow text");
  assert.equal(h.ctl.view().headText, "Updating AIOS...", "CTL-T-4 still updating, nothing killed or reported as failed");
  await h.settle(1, applied);
  assert.equal(h.ctl.view().status, null, "CTL-T-5 slow notice clears when apply ends");
  assert.equal(slow.cleared, true, "CTL-T-6 timer cleared");
}

console.log("updateCardController.test.mjs: all assertions passed");
