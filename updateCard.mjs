// AIOS update card (D-2026-10-23-01): pure model. main.ts spawns the vault's own update engine
// (Operations/scripts/aios-update.mjs) with the argv built here and hands the raw result back in;
// everything the card shows, and whether its Update button exists, is decided here.
//
// Rules this file owns:
// - The card only ever runs `check --json` and `apply --json --expect-commit <the commit it checked>`,
//   plus `--allow-code` after the owner confirmed an update that includes dashboard code. It never
//   passes --adopt, --accept-collisions or --allow-safety-config: those stay with Dispatch.
// - The Update button exists only when check reports an update and no blocker.
// - Refusals are plain sentences with a next step, never raw JSON.
// - createUpdateController owns the check/apply wiring (in-flight state, a confirm queued behind a
//   running check, no kill timeout on apply); main.ts only draws its view().

export const UPDATE_ENGINE_PATH = "Operations/scripts/aios-update.mjs";
// The check --json shape this card understands (the engine's STATUS_SCHEMA). 3 = apply knows --expect-commit.
export const UPDATE_STATUS_SCHEMA = 3;
export const UPDATE_CHECK_TIMEOUT_MS = 120_000;
// apply is never killed (a kill mid-write skips the engine's verified rollback); after this long the card only says it is slow.
export const UPDATE_APPLY_SLOW_MS = 300_000;
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export function buildCheckArgv() {
  return [UPDATE_ENGINE_PATH, "check", "--json"];
}

export function buildApplyArgv({ allowCode, expectCommit }) {
  if (typeof expectCommit !== "string" || !FULL_SHA.test(expectCommit)) throw new Error("apply needs the checked template commit");
  const argv = [UPDATE_ENGINE_PATH, "apply", "--json", "--expect-commit", expectCommit];
  if (allowCode === true) argv.push("--allow-code");
  return argv;
}

/** "2.14.0" -> "2.14", "1.0.0" -> "1.0", "2.14.1" stays. */
export function shortVersion(v) {
  if (typeof v !== "string" || !v) return "unknown";
  const m = /^(\d+)\.(\d+)\.0$/.exec(v);
  return m ? `${m[1]}.${m[2]}` : v;
}

// One entry per blocker kind the engine reports: the headline clause and the next step.
const BLOCKER_WORDS = {
  unbaselined: { says: "this AIOS is not set up for updates yet", next: "Run the one-time setup: ask Dispatch." },
  collisions: { says: "this AIOS changed some of its files itself", next: "Ask Dispatch to merge them.", list: true },
  dirty: { says: "some AIOS files have unsaved changes", next: "Commit or undo them, or ask Dispatch.", list: true },
  safety: { says: "it changes safety settings that need a Reviewer first", next: "Ask Dispatch." },
  detached: { says: "this vault's git is not on a branch", next: "Ask Dispatch." },
  "plugin-newer": { says: "this AIOS already has a newer dashboard than the update brings", next: "Ask Dispatch." },
  "hidden-edits": { says: "git is set to ignore changes to some AIOS files, so the updater cannot prove they are clean", next: "Ask Dispatch to clear that git setting.", list: true },
  "unsafe-targets": { says: "some files it would write are not safe to write (a link, a folder or a locked file)", next: "Ask Dispatch.", list: true },
  code: { says: "the update now includes dashboard code you have not confirmed", next: "Press Check now, then confirm again." },
  moved: { says: "the update changed since you checked", next: "Press Check now and look at it again before updating." },
};
const UNKNOWN_BLOCKER = { says: "the updater found a problem it will not work around", next: "Ask Dispatch.", engineWords: true };
const wordsFor = (b) => BLOCKER_WORDS[b?.kind] || UNKNOWN_BLOCKER;

function blockerLines(b) {
  const w = wordsFor(b);
  const lines = [];
  if (w.list && Array.isArray(b.paths)) for (const p of b.paths) if (typeof p === "string") lines.push(p);
  if (w.engineWords && typeof b.message === "string" && b.message) lines.push(b.message);
  return lines;
}

/** The changelog markdown as plain lines: headings and bullets without their markers, blanks dropped. */
function changeNotes(md) {
  if (typeof md !== "string") return [];
  return md
    .split("\n")
    .map((l) => l.trim().replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0);
}

function firstLine(text) {
  return String(text || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
}

const card = (over) => ({
  templateCommit: null,
  state: "error",
  quiet: false,
  headline: "",
  lines: [],
  notes: [],
  next: null,
  showUpdate: false,
  codeChanges: false,
  incoming: null,
  pluginIncoming: null,
  ...over,
});

/**
 * raw: {exitCode, stdout, stderr, spawnError, engineExists} from running buildCheckArgv() in the vault root.
 * Returns the card: {state, quiet, headline, lines, notes, next, showUpdate, codeChanges, incoming, pluginIncoming}.
 * state: up-to-date | available | blocked | old-engine | not-installed | error.
 */
export function computeUpdateCard(raw) {
  if (!raw || raw.engineExists === false) {
    return card({ state: "not-installed", quiet: true, headline: "Updates are not set up in this vault." });
  }
  if (raw.spawnError) {
    return card({ headline: "Could not run the update check.", lines: [String(raw.spawnError)], next: "Ask Dispatch." });
  }
  let s = null;
  try { s = JSON.parse(raw.stdout); } catch { s = null; }
  if (!s || typeof s !== "object") {
    const err = firstLine(raw.stderr);
    if (/no template source/.test(err)) {
      return card({ headline: "This AIOS is not connected to a template yet.", next: "Run the one-time setup: ask Dispatch." });
    }
    return card({ headline: "The update check failed.", lines: err ? [err] : [], next: "Ask Dispatch." });
  }
  if (raw.exitCode === 2 || typeof s.error === "string") {
    return card({ headline: "Could not reach the AIOS template to check for updates.", next: "Press Check now to try again. If it keeps failing, ask Dispatch." });
  }
  const incoming = s.template?.version ?? null;
  const ready = `AIOS ${shortVersion(incoming)} is ready`;
  if (!s.updateAvailable) {
    return card({ state: "up-to-date", quiet: true, headline: `AIOS ${shortVersion(incoming)} is up to date`, incoming });
  }
  if (s.schema !== UPDATE_STATUS_SCHEMA || !Array.isArray(s.blockers)) {
    return card({ state: "old-engine", headline: `${ready}, but this AIOS's updater is older than this card.`, next: "Ask Dispatch to run this one update by hand. After that the card works.", incoming });
  }
  const templateCommit = typeof s.template?.commit === "string" && FULL_SHA.test(s.template.commit) ? s.template.commit : null;
  if (!templateCommit) {
    return card({ headline: `${ready}, but the check did not say which version it checked.`, next: "Press Check now. If it keeps happening, ask Dispatch.", incoming });
  }
  if (s.blockers.length > 0) {
    const [first, ...rest] = s.blockers;
    const lines = [...blockerLines(first)];
    for (const b of rest) lines.push(`Also: ${wordsFor(b).says}.`, ...blockerLines(b));
    return card({ state: "blocked", headline: `${ready}, but ${wordsFor(first).says}.`, lines, next: wordsFor(first).next, incoming });
  }
  const codeChanges = Boolean(s.codeChanges?.required) && Array.isArray(s.codeChanges?.paths) && s.codeChanges.paths.length > 0;
  const plugin = s.plugin || {};
  const lines = [];
  const n = Array.isArray(s.files) ? s.files.length : 0;
  lines.push(`${n} file${n === 1 ? "" : "s"} change${n === 1 ? "s" : ""}`);
  if (plugin.changes) {
    lines.push(`Dashboard ${shortVersion(plugin.incoming)} (${plugin.installed ? `you have ${shortVersion(plugin.installed)}` : "not installed yet"})`);
  } else if (plugin.installed) {
    lines.push(`Dashboard ${shortVersion(plugin.installed)} (no change)`);
  }
  if (codeChanges) lines.push("Includes new dashboard code. You will be asked to confirm, and Obsidian needs a reload after.");
  const installed = s.installed?.version;
  return card({
    state: "available",
    headline: `AIOS update ready: ${shortVersion(incoming)}${installed ? ` (you have ${shortVersion(installed)})` : ""}`,
    lines,
    notes: changeNotes(s.changelog),
    showUpdate: true,
    codeChanges,
    incoming,
    pluginIncoming: plugin.incoming ?? null,
    templateCommit,
  });
}

/** The confirm dialog for an available update. allowCode is true only when the update includes code. */
export function updateConfirmText(c) {
  if (!c || c.state !== "available" || !c.showUpdate) throw new Error("no update to confirm");
  const parts = [`Update AIOS to ${c.incoming}?`];
  if (c.codeChanges) {
    parts.push(`This update includes new dashboard code (the plugin itself, ${c.pluginIncoming}). Obsidian runs it as part of the app. Only continue if you expected a dashboard update.`);
    parts.push("After the update, reload Obsidian to use the new dashboard.");
  }
  parts.push("The update is one git commit. To undo it later: git revert <that commit>.");
  return { body: parts.join("\n\n"), allowCode: c.codeChanges === true, confirmLabel: c.codeChanges ? "Update, including code" : "Update" };
}

const UNKNOWN_OUTCOME = { headline: "Update result unknown: ask Dispatch.", next: "Do not edit anything or press Update again. Ask Dispatch to check git log." };

/**
 * raw: {started, exitCode, stdout, stderr, spawnError} from running buildApplyArgv(). started is false only when the
 * engine was never launched. Once it started, any end the engine did not explain itself is "result unknown", never
 * "nothing ran": a write or a commit may have happened.
 */
export function computeApplyOutcome(raw) {
  const out = (over) => ({ ok: false, headline: "", lines: [], next: null, undo: null, reload: false, ...over });
  if (raw?.started === false) return out({ headline: "Could not start the update. Nothing was changed.", lines: raw.spawnError ? [String(raw.spawnError)] : [], next: "Ask Dispatch." });
  const unknown = (lines = []) => out({ ...UNKNOWN_OUTCOME, lines });
  if (raw?.spawnError || raw?.exitCode === null || raw?.exitCode === undefined) return unknown(raw?.spawnError ? [String(raw.spawnError)] : []);
  let r = null;
  try { r = JSON.parse(raw.stdout); } catch { r = null; }
  if (!r || typeof r !== "object") {
    const err = firstLine(raw.stderr);
    if (/ROLLBACK INCOMPLETE/.test(err)) return out({ headline: "The update failed and could not fully undo itself.", lines: [err], next: "Do not edit anything. Ask Dispatch now." });
    if (/rolled back \(verified identical/.test(err)) return out({ headline: "The update failed and nothing was changed.", lines: [err], next: "Ask Dispatch." });
    // The engine fetches the template before it writes anything, so a fetch failure (exit 2) changed nothing.
    if (raw.exitCode === 2) return out({ headline: "Could not reach the AIOS template. Nothing was changed.", lines: err ? [err] : [], next: "Press Check now to try again. If it keeps failing, ask Dispatch." });
    return unknown(err ? [err] : []);
  }
  if (raw.exitCode === 0 && typeof r.committed === "string" && /^[0-9a-f]{40}$/.test(r.committed)) {
    const reload = r.pluginChanged === true;
    const lines = reload ? ["The dashboard itself changed. Reload Obsidian to use the new version (Command palette: Reload app without saving)."] : [];
    return out({ ok: true, headline: `AIOS updated to ${r.template?.version ?? "the new version"} in commit ${r.committed.slice(0, 7)}.`, lines, undo: `To undo it: git revert ${r.committed}`, reload });
  }
  if (raw.exitCode === 0) return out({ ok: true, headline: "Nothing to update: AIOS is already up to date." });
  // Exit 3: the engine refuses before its first write, so "did not run" is true.
  const refusals = raw.exitCode === 3 && Array.isArray(r.refusals) ? r.refusals : [];
  if (refusals.length) {
    const [first, ...rest] = refusals;
    const lines = [...blockerLines(first)];
    for (const b of rest) lines.push(`Also: ${wordsFor(b).says}.`, ...blockerLines(b));
    return out({ headline: `The update did not run: ${wordsFor(first).says}.`, lines, next: wordsFor(first).next });
  }
  return unknown((r.refused || []).filter((x) => typeof x === "string"));
}

/**
 * The card's check/apply wiring, kept out of main.ts so it is tested.
 * deps: {runEngine(basePath, argv, {timeoutMs}) -> Promise<raw>, isDesktop, getBasePath() -> string|null,
 *        onChange(), setTimer(fn, ms), clearTimer(t)}.
 * timeoutMs is UPDATE_CHECK_TIMEOUT_MS for check and null (never kill) for apply.
 */
export function createUpdateController(deps) {
  const { runEngine, isDesktop, getBasePath, onChange = () => {} } = deps;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  let current = null; // the last check card
  let checking = false;
  let applying = false;
  let slow = false;
  let queued = null; // apply argv confirmed while a check was running
  let outcome = null;
  let notice = null;

  function startApply(argv) {
    const basePath = getBasePath();
    if (!basePath) return;
    applying = true;
    slow = false;
    notice = null;
    outcome = null;
    const slowTimer = setTimer(() => { slow = true; onChange(); }, UPDATE_APPLY_SLOW_MS);
    Promise.resolve(runEngine(basePath, argv, { timeoutMs: null }))
      .then((run) => { outcome = computeApplyOutcome(run); }, (err) => { outcome = computeApplyOutcome({ started: true, exitCode: null, spawnError: err?.message || String(err) }); })
      .finally(() => {
        clearTimer(slowTimer);
        applying = false;
        slow = false;
        // Re-check so the card shows the new installed version (or the refusal) right away.
        check();
        onChange();
      });
  }

  function check() {
    if (!isDesktop || checking || applying) return;
    const basePath = getBasePath();
    if (!basePath) return;
    checking = true;
    Promise.resolve(runEngine(basePath, buildCheckArgv(), { timeoutMs: UPDATE_CHECK_TIMEOUT_MS }))
      .then((run) => { current = computeUpdateCard(run); }, (err) => { current = computeUpdateCard({ engineExists: true, spawnError: err?.message || String(err) }); })
      .finally(() => {
        checking = false;
        if (queued) { const argv = queued; queued = null; startApply(argv); }
        onChange();
      });
  }

  return {
    ensureChecked() { if (!current && !checking) check(); },
    checkNow() { outcome = null; notice = null; check(); },
    /** A background re-check (dashboard open): keeps the last apply outcome on screen. */
    recheck() { check(); },
    /** The confirm for the card on screen now, or null. go() runs exactly what this dialog described. */
    requestUpdate() {
      const c = current;
      if (!isDesktop || !c || c.state !== "available" || !c.showUpdate || checking || applying) return null;
      const confirm = updateConfirmText(c);
      const argv = buildApplyArgv({ allowCode: confirm.allowCode, expectCommit: c.templateCommit });
      return {
        body: confirm.body,
        confirmLabel: confirm.confirmLabel,
        go: () => {
          if (applying || queued) { notice = "An update is already running."; onChange(); return; }
          if (checking) { queued = argv; onChange(); return; }
          startApply(argv);
          onChange();
        },
      };
    },
    view() {
      const c = current;
      const busy = checking || applying;
      const status = queued ? "Your update starts when the check finishes." : slow ? "Still updating after 5 minutes. Leave Obsidian open. If it never finishes, ask Dispatch." : notice;
      const showDetails = Boolean(c) && !c.quiet && !busy;
      return {
        visible: Boolean(isDesktop),
        quiet: !outcome && !status && (!c || c.quiet),
        headText: applying ? "Updating AIOS..." : !c ? "Checking for AIOS updates..." : c.headline,
        checkLabel: checking ? "Checking..." : "Check now",
        checkDisabled: busy,
        status,
        outcome,
        facts: showDetails ? c.lines : [],
        notes: showDetails ? c.notes : [],
        next: showDetails ? c.next : null,
        showUpdate: showDetails && c.showUpdate === true && !queued,
      };
    },
  };
}
