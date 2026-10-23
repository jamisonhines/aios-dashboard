// AIOS update card (D-2026-10-23-01): pure model. main.ts spawns the vault's own update engine
// (Operations/scripts/aios-update.mjs) with the argv built here and hands the raw result back in;
// everything the card shows, and whether its Update button exists, is decided here.
//
// Rules this file owns:
// - The card only ever runs `check --json` and `apply --json`, plus `--allow-code` after the owner
//   confirmed an update that includes dashboard code. It never passes --adopt,
//   --accept-collisions or --allow-safety-config: those stay with Dispatch.
// - The Update button exists only when check reports an update and no blocker.
// - Refusals are plain sentences with a next step, never raw JSON.

export const UPDATE_ENGINE_PATH = "Operations/scripts/aios-update.mjs";
// The check --json shape this card understands (the engine's STATUS_SCHEMA).
export const UPDATE_STATUS_SCHEMA = 2;

export function buildCheckArgv() {
  return [UPDATE_ENGINE_PATH, "check", "--json"];
}

export function buildApplyArgv({ allowCode }) {
  const argv = [UPDATE_ENGINE_PATH, "apply", "--json"];
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

/** raw: {exitCode, stdout, stderr, spawnError} from running buildApplyArgv(). */
export function computeApplyOutcome(raw) {
  const out = (over) => ({ ok: false, headline: "", lines: [], next: null, undo: null, reload: false, ...over });
  if (raw?.spawnError) return out({ headline: "Could not run the update.", lines: [String(raw.spawnError)], next: "Ask Dispatch." });
  let r = null;
  try { r = JSON.parse(raw.stdout); } catch { r = null; }
  if (!r || typeof r !== "object") {
    const err = firstLine(raw?.stderr);
    if (/ROLLBACK INCOMPLETE/.test(err)) return out({ headline: "The update failed and could not fully undo itself.", lines: [err], next: "Do not edit anything. Ask Dispatch now." });
    if (/rolled back \(verified identical/.test(err)) return out({ headline: "The update failed and nothing was changed.", lines: [err], next: "Ask Dispatch." });
    return out({ headline: "The update failed.", lines: err ? [err] : [], next: "Ask Dispatch." });
  }
  if (raw.exitCode === 0 && typeof r.committed === "string" && /^[0-9a-f]{40}$/.test(r.committed)) {
    const reload = r.pluginChanged === true;
    const lines = reload ? ["The dashboard itself changed. Reload Obsidian to use the new version (Command palette: Reload app without saving)."] : [];
    return out({ ok: true, headline: `AIOS updated to ${r.template?.version ?? "the new version"} in commit ${r.committed.slice(0, 7)}.`, lines, undo: `To undo it: git revert ${r.committed}`, reload });
  }
  if (raw.exitCode === 0) return out({ ok: true, headline: "Nothing to update: AIOS is already up to date." });
  const refusals = Array.isArray(r.refusals) ? r.refusals : [];
  if (refusals.length) {
    const [first, ...rest] = refusals;
    const lines = [...blockerLines(first)];
    for (const b of rest) lines.push(`Also: ${wordsFor(b).says}.`, ...blockerLines(b));
    return out({ headline: `The update did not run: ${wordsFor(first).says}.`, lines, next: wordsFor(first).next });
  }
  return out({ headline: "The update did not run.", lines: (r.refused || []).filter((x) => typeof x === "string"), next: "Ask Dispatch." });
}
