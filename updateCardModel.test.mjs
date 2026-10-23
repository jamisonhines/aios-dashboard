import "./testFileTimeout.mjs";
// D-2026-10-23-01: the dashboard's AIOS update card. Pure model only: the impure spawn lives in
// main.ts. Every card state, the button rules (hidden on any refusal), the code confirm, and
// the exact engine argv (never --adopt, --accept-collisions or --allow-safety-config).
import assert from "node:assert";
import {
  UPDATE_ENGINE_PATH,
  buildCheckArgv,
  buildApplyArgv,
  computeUpdateCard,
  updateConfirmText,
  computeApplyOutcome,
  shortVersion,
} from "./updateCard.mjs";

// A check --json payload as the schema-2 engine prints it (Operations/scripts/aios-update.mjs).
const status = (over = {}) => ({
  schema: 2,
  checkedAt: "2026-10-23T10:00:00.000Z",
  template: { source: "/t", ref: "main", commit: "abc", version: "0.2.0" },
  installed: { version: "0.1.0", commit: "cc69ca40" },
  updateAvailable: true,
  changelog: "## 0.2.0\n\n- GL-012 and build-project templates.\n- The dashboard ships with AIOS.",
  files: [{ path: "AGENTS.md", action: "modify" }, { path: "Agents/Coder/AGENTS.md", action: "modify" }],
  collisions: [], unbaselined: [], localEdits: [], dirty: [],
  reviewerRequired: { required: false, paths: [] },
  codeChanges: { required: false, note: "x", paths: [] },
  plugin: { id: "aios-dashboard", installed: "2.14.0", incoming: "2.14.0", changes: false },
  blockers: [],
  ...over,
});
const ran = (s, code = 0) => ({ exitCode: code, stdout: JSON.stringify(s), stderr: "", spawnError: null, engineExists: true });
const withCode = (over = {}) => status({
  files: [...status().files, { path: ".obsidian/plugins/aios-dashboard/main.js", action: "modify" }],
  codeChanges: { required: true, note: "x", paths: [".obsidian/plugins/aios-dashboard/main.js"] },
  plugin: { id: "aios-dashboard", installed: "1.0.0", incoming: "2.15.0", changes: true },
  ...over,
});
const blocked = (kind, paths = [], message = "engine words") => status({ blockers: [{ kind, message, paths }] });
const allText = (card) => [card.headline, ...card.lines, card.next || ""].join("\n");

// ---------------------------------------------------------------- argv: the only flags the card may pass
assert.equal(UPDATE_ENGINE_PATH, "Operations/scripts/aios-update.mjs", "CARD-ARGV-1 the card runs the instance's own engine by its vault-relative path");
assert.deepEqual(buildCheckArgv(), ["Operations/scripts/aios-update.mjs", "check", "--json"], "CARD-ARGV-2 check is check --json, nothing else");
assert.deepEqual(buildApplyArgv({ allowCode: false }), ["Operations/scripts/aios-update.mjs", "apply", "--json"], "CARD-ARGV-3 apply without code consent carries no flag");
assert.deepEqual(buildApplyArgv({ allowCode: true }), ["Operations/scripts/aios-update.mjs", "apply", "--json", "--allow-code"], "CARD-ARGV-4 code consent adds only --allow-code");
for (const allowCode of [true, false]) {
  const argv = buildApplyArgv({ allowCode });
  for (const banned of ["--adopt", "--accept-collisions", "--allow-safety-config", "--template", "--ref", "--instance"]) {
    assert.ok(!argv.includes(banned), `CARD-ARGV-5 the card never passes ${banned}`);
  }
}

// ---------------------------------------------------------------- up to date: one quiet line
{
  const card = computeUpdateCard(ran(status({ updateAvailable: false, files: [], installed: { version: "0.2.0", commit: "x" } })));
  assert.equal(card.state, "up-to-date", "CARD-UP-1 state");
  assert.equal(card.quiet, true, "CARD-UP-2 up to date renders as one quiet line");
  assert.equal(card.headline, "AIOS 0.2 is up to date", "CARD-UP-3 quiet line text");
  assert.deepEqual(card.lines, [], "CARD-UP-4 nothing else is shown");
  assert.equal(card.showUpdate, false, "CARD-UP-5 no Update button when up to date");
}
{
  // Up to date beats a blocker: with nothing to apply there is nothing to be blocked from.
  const card = computeUpdateCard(ran(status({ updateAvailable: false, files: [], blockers: [{ kind: "dirty", message: "m", paths: ["AGENTS.md"] }] })));
  assert.equal(card.state, "up-to-date", "CARD-UP-6 nothing to apply stays quiet even with a dirty framework file");
}

// ---------------------------------------------------------------- update available
{
  const card = computeUpdateCard(ran(status()));
  assert.equal(card.state, "available", "CARD-AV-1 state");
  assert.equal(card.quiet, false, "CARD-AV-2 not quiet");
  assert.equal(card.headline, "AIOS update ready: 0.2 (you have 0.1)", "CARD-AV-3 headline names incoming and installed AIOS versions");
  assert.deepEqual(card.notes, ["0.2.0", "GL-012 and build-project templates.", "The dashboard ships with AIOS."], "CARD-AV-4 change notes as plain lines, markdown markers stripped");
  assert.ok(card.lines.includes("2 files change"), "CARD-AV-5 file count");
  assert.ok(card.lines.includes("Dashboard 2.14 (no change)"), "CARD-AV-6 dashboard line when the plugin does not change");
  assert.ok(!allText(card).includes("code"), "CARD-AV-7 no code note when the update has no code changes");
  assert.equal(card.showUpdate, true, "CARD-AV-8 Update button shown when there is no refusal");
  assert.equal(card.codeChanges, false, "CARD-AV-9 no code flag");
}
{
  const card = computeUpdateCard(ran(withCode()));
  assert.equal(card.state, "available", "CARD-CODE-1 code changes do not block");
  assert.ok(card.lines.includes("Dashboard 2.15 (you have 1.0)"), "CARD-CODE-2 incoming vs installed dashboard version");
  assert.ok(card.lines.includes("3 files change"), "CARD-CODE-3 file count includes the plugin");
  assert.ok(card.lines.includes("Includes new dashboard code. You will be asked to confirm, and Obsidian needs a reload after."), "CARD-CODE-4 plain code note");
  assert.equal(card.codeChanges, true, "CARD-CODE-5 code flag set");
  assert.equal(card.showUpdate, true, "CARD-CODE-6 Update button still shown");
}
{
  const card = computeUpdateCard(ran(withCode({ plugin: { id: "aios-dashboard", installed: null, incoming: "2.15.0", changes: true } })));
  assert.ok(card.lines.includes("Dashboard 2.15 (not installed yet)"), "CARD-CODE-7 no installed dashboard reads plainly");
}

// ---------------------------------------------------------------- the code confirm and its flag
{
  const plain = updateConfirmText(computeUpdateCard(ran(status())));
  assert.equal(plain.allowCode, false, "CARD-CONF-1 a plain update never passes the code flag");
  assert.match(plain.body, /Update AIOS to 0\.2\.0\?/, "CARD-CONF-2 confirm names the version");
  assert.match(plain.body, /git revert/, "CARD-CONF-3 confirm says how to undo");
  assert.doesNotMatch(plain.body, /code/i, "CARD-CONF-4 no code wording without code changes");
  const code = updateConfirmText(computeUpdateCard(ran(withCode())));
  assert.equal(code.allowCode, true, "CARD-CONF-5 code consent only when the update has code changes");
  assert.match(code.body, /This update includes new dashboard code \(the plugin itself, 2\.15\.0\)/, "CARD-CONF-6 the confirm says code is included");
  assert.equal(code.confirmLabel, "Update, including code", "CARD-CONF-7 the button names the code consent");
  assert.equal(plain.confirmLabel, "Update", "CARD-CONF-8 plain confirm button");
  assert.throws(() => updateConfirmText(computeUpdateCard(ran(blocked("unbaselined")))), /no update to confirm/, "CARD-CONF-9 no confirm exists for a refused card");
}

// ---------------------------------------------------------------- refusals: plain words, next step, no button, no JSON
const refusal = (kind, paths, expectHeadline, expectNext) => {
  const card = computeUpdateCard(ran(blocked(kind, paths)));
  assert.equal(card.state, "blocked", `CARD-REF ${kind} state`);
  assert.equal(card.showUpdate, false, `CARD-REF ${kind} hides the Update button`);
  assert.equal(card.headline, expectHeadline, `CARD-REF ${kind} headline`);
  assert.equal(card.next, expectNext, `CARD-REF ${kind} next step`);
  assert.doesNotMatch(allText(card), /[{}[\]]|"kind"/, `CARD-REF ${kind} never shows raw JSON`);
  return card;
};
refusal("unbaselined", ["AGENTS.md"], "AIOS 0.2 is ready, but this AIOS is not set up for updates yet.", "Run the one-time setup: ask Dispatch.");
{
  const card = refusal("collisions", ["AGENTS.md", "Agents/Coder/AGENTS.md"], "AIOS 0.2 is ready, but this AIOS changed some of its files itself.", "Ask Dispatch to merge them.");
  assert.ok(card.lines.includes("AGENTS.md") && card.lines.includes("Agents/Coder/AGENTS.md"), "CARD-REF collisions lists the files");
}
{
  const card = refusal("dirty", ["AGENTS.md"], "AIOS 0.2 is ready, but some AIOS files have unsaved changes.", "Commit or undo them, or ask Dispatch.");
  assert.ok(card.lines.includes("AGENTS.md"), "CARD-REF dirty lists the files");
}
refusal("safety", [".claude/hooks/x.py"], "AIOS 0.2 is ready, but it changes safety settings that need a Reviewer first.", "Ask Dispatch.");
refusal("detached", [], "AIOS 0.2 is ready, but this vault's git is not on a branch.", "Ask Dispatch.");
refusal("plugin-newer", [], "AIOS 0.2 is ready, but this AIOS already has a newer dashboard than the update brings.", "Ask Dispatch.");
{
  const card = refusal("hidden-edits", ["AGENTS.md"], "AIOS 0.2 is ready, but the updater found a problem it will not work around.", "Ask Dispatch.");
  assert.ok(card.lines.includes("engine words"), "CARD-REF an unknown-to-the-card kind shows the engine's own sentence");
}
{
  // Two blockers: both are shown, and the button stays hidden.
  const card = computeUpdateCard(ran(status({ blockers: [{ kind: "dirty", message: "m", paths: ["a.md"] }, { kind: "collisions", message: "m", paths: ["b.md"] }] })));
  assert.equal(card.showUpdate, false, "CARD-REF-MULTI no button");
  assert.ok(card.lines.includes("Also: this AIOS changed some of its files itself."), "CARD-REF-MULTI the second blocker is named");
}
{
  // A blocker plus code changes: still blocked, still no button.
  const card = computeUpdateCard(ran(withCode({ blockers: [{ kind: "unbaselined", message: "m", paths: [] }] })));
  assert.equal(card.showUpdate, false, "CARD-REF-CODE code changes never re-enable a blocked card");
}

// ---------------------------------------------------------------- failures of the check itself
{
  const card = computeUpdateCard({ exitCode: 2, stdout: JSON.stringify({ checkedAt: "x", error: "could not fetch template /t main: fatal", updateAvailable: false }), stderr: "", spawnError: null, engineExists: true });
  assert.equal(card.state, "error", "CARD-ERR-1 fetch failure");
  assert.equal(card.headline, "Could not reach the AIOS template to check for updates.", "CARD-ERR-2 fetch failure headline");
  assert.equal(card.next, "Press Check now to try again. If it keeps failing, ask Dispatch.", "CARD-ERR-3 fetch next step");
  assert.equal(card.showUpdate, false, "CARD-ERR-4 no button");
}
{
  const card = computeUpdateCard({ exitCode: null, stdout: "", stderr: "", spawnError: null, engineExists: false });
  assert.equal(card.state, "not-installed", "CARD-ERR-5 no engine in this vault");
  assert.equal(card.quiet, true, "CARD-ERR-6 a vault without the updater gets a quiet line");
  assert.equal(card.headline, "Updates are not set up in this vault.", "CARD-ERR-7 text");
}
{
  const card = computeUpdateCard({ exitCode: 1, stdout: "", stderr: "no template source: pass --template or set \"template\" in .aios-update/config.json\n", spawnError: null, engineExists: true });
  assert.equal(card.state, "error", "CARD-ERR-8 no template source");
  assert.equal(card.headline, "This AIOS is not connected to a template yet.", "CARD-ERR-9 text");
  assert.equal(card.next, "Run the one-time setup: ask Dispatch.", "CARD-ERR-10 next");
}
{
  const card = computeUpdateCard({ exitCode: null, stdout: "", stderr: "", spawnError: "no node binary found", engineExists: true });
  assert.equal(card.state, "error", "CARD-ERR-11 node could not start");
  assert.equal(card.headline, "Could not run the update check.", "CARD-ERR-12 text");
  assert.ok(card.lines.includes("no node binary found"), "CARD-ERR-13 the reason is shown");
}
{
  const card = computeUpdateCard({ exitCode: 0, stdout: "not json", stderr: "", spawnError: null, engineExists: true });
  assert.equal(card.state, "error", "CARD-ERR-14 unreadable output");
  assert.doesNotMatch(allText(card), /not json/, "CARD-ERR-15 the raw output is not dumped on the card");
}
{
  const legacy = status();
  delete legacy.schema;
  delete legacy.blockers;
  const card = computeUpdateCard(ran(legacy));
  assert.equal(card.state, "old-engine", "CARD-ERR-16 an engine without schema 2 cannot drive the button");
  assert.equal(card.showUpdate, false, "CARD-ERR-17 no button on an old engine");
  assert.equal(card.headline, "AIOS 0.2 is ready, but this AIOS's updater is older than this card.", "CARD-ERR-18 text");
  assert.equal(card.next, "Ask Dispatch to run this one update by hand. After that the card works.", "CARD-ERR-19 next");
}

// ---------------------------------------------------------------- apply outcome
{
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const out = computeApplyOutcome({ exitCode: 0, stdout: JSON.stringify({ ...withCode(), committed: sha, refused: [], refusals: [], pluginChanged: true }), stderr: "", spawnError: null });
  assert.equal(out.ok, true, "CARD-APPLY-1 success");
  assert.equal(out.headline, "AIOS updated to 0.2.0 in commit 0123456.", "CARD-APPLY-2 names the commit");
  assert.equal(out.undo, `To undo it: git revert ${sha}`, "CARD-APPLY-3 how to undo, full sha");
  assert.equal(out.reload, true, "CARD-APPLY-4 reload asked when the plugin itself changed");
  assert.ok(out.lines.includes("The dashboard itself changed. Reload Obsidian to use the new version (Command palette: Reload app without saving)."), "CARD-APPLY-5 reload wording");
}
{
  const out = computeApplyOutcome({ exitCode: 0, stdout: JSON.stringify({ ...status(), committed: "a".repeat(40), refused: [], refusals: [], pluginChanged: false }), stderr: "", spawnError: null });
  assert.equal(out.reload, false, "CARD-APPLY-6 no reload when the plugin did not change");
  assert.ok(!out.lines.some((l) => /Reload/.test(l)), "CARD-APPLY-7 no reload wording");
}
{
  const out = computeApplyOutcome({ exitCode: 3, stdout: JSON.stringify({ ...status(), committed: null, refused: ["x"], refusals: [{ kind: "collisions", message: "x", paths: ["AGENTS.md"] }], pluginChanged: false }), stderr: "", spawnError: null });
  assert.equal(out.ok, false, "CARD-APPLY-8 refusal at apply time");
  assert.equal(out.headline, "The update did not run: this AIOS changed some of its files itself.", "CARD-APPLY-9 plain refusal");
  assert.equal(out.next, "Ask Dispatch to merge them.", "CARD-APPLY-10 next step");
  assert.equal(out.undo, null, "CARD-APPLY-11 nothing to undo");
}
{
  const out = computeApplyOutcome({ exitCode: 1, stdout: "", stderr: "update failed and was rolled back (verified identical to the pre-apply state): hook said no\n", spawnError: null });
  assert.equal(out.ok, false, "CARD-APPLY-12 engine error");
  assert.equal(out.headline, "The update failed and nothing was changed.", "CARD-APPLY-13 verified rollback reads plainly");
  assert.ok(out.lines.includes("update failed and was rolled back (verified identical to the pre-apply state): hook said no"), "CARD-APPLY-14 the engine sentence is kept");
}
{
  const out = computeApplyOutcome({ exitCode: 1, stdout: "", stderr: "update failed: x. ROLLBACK INCOMPLETE, the instance differs\n", spawnError: null });
  assert.equal(out.headline, "The update failed and could not fully undo itself.", "CARD-APPLY-15 incomplete rollback is never called clean");
  assert.equal(out.next, "Do not edit anything. Ask Dispatch now.", "CARD-APPLY-16 next step");
}

// ---------------------------------------------------------------- version display
assert.equal(shortVersion("2.14.0"), "2.14", "CARD-VER-1 trailing .0 patch dropped");
assert.equal(shortVersion("1.0.0"), "1.0", "CARD-VER-2 keeps major.minor");
assert.equal(shortVersion("2.14.1"), "2.14.1", "CARD-VER-3 a real patch is kept");
assert.equal(shortVersion(null), "unknown", "CARD-VER-4 missing version");

console.log("updateCardModel.test.mjs: all assertions passed");
