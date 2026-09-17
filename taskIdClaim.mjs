// Task-id claiming for the dashboard's quick-add path (tsk-2026-09-17-021).
//
// nextTaskId() in main.ts used to compute MAX(vault filename NNN for today)+1 and hand that
// straight back, never looking at Operations/tasks/.id-claims/<day>/<NNN>, the atomic claim
// directory agents and decompose-plan.mjs reserve through Operations/scripts/mint-task-id.mjs
// (tsk-2026-09-17-010). That let quick-add reissue a number an agent had already claimed but
// not yet written a file for.
//
// Two paths, by measured capability (see the task's Updates for how these were checked):
//
// 1. claimNextTaskIdFs -- desktop, Node fs available. Same primitive as mint-task-id.mjs's
//    claimTaskIds: a non-recursive fs.mkdir on the leaf claim folder is atomic at the
//    filesystem level (EEXIST means someone else holds that NNN, try the next one). Node's
//    `fs` module is already relied on at runtime from main.ts today via the same dynamic
//    `require("fs")` pattern `runLaunchCommand` already uses for `require("child_process")`;
//    the committed, esbuild-bundled main.js keeps that require call intact (verified from the
//    built artifact, not inferred), so this is the normal path, not a best-effort one.
//
// 2. claimNextTaskIdAdapter -- fs unavailable (or the fs path throws). Obsidian's own
//    FileSystemAdapter.mkdir is NOT a substitute atomic primitive: extracting
//    /Applications/Obsidian.app/Contents/Resources/obsidian.asar and reading the desktop
//    FileSystemAdapter's mkdir shows it calls `this.fsPromises.mkdir(path, {recursive: true})`
//    -- recursive:true means it silently no-ops on an already-existing directory instead of
//    throwing EEXIST, so it cannot detect a collision. This path only widens the starting
//    cursor past existing claim folders (via adapter.list) and writes a best-effort claim
//    folder; it does not retry on collision and two racing no-fs callers can still collide.
// That residual is intentional and documented, not silently accepted: see the task's "Return"
// section for the risk note.
//
// Never releases a claim (matches mint-task-id.mjs) and never prunes (the CLI owns pruning).

// No static "node:path" (or "node:fs") import here: this module is bundled by esbuild into
// main.ts (platform "browser", not "node"), which fails to resolve node built-ins that are
// statically imported. basePath (from adapter.getBasePath()) is already an absolute
// filesystem path, so plain "/"-joins are sufficient (Node's fs accepts forward slashes on
// every platform this plugin ships to). fsp is injected by the caller (main.ts's own
// runtime `require("fs").promises`, or a fake in tests), never imported here.
function joinPath(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, "") : String(p).replace(/^\/+|\/+$/g, "")))
    .join("/");
}

const MAX_RETRIES_PER_ID = 50;

export function pad3(n) {
  return String(n).padStart(3, "0");
}

// Mirrors the exact scan nextTaskId() used to do inline: MAX(NNN) across every markdown
// basename for `day`, reading only the first 3 characters after the day prefix (same
// tolerance for trailing slug/junk the old inline loop had).
export function maxOnDiskFromBasenames(basenames, day) {
  const prefix = `tsk-${day}-`;
  let max = 0;
  for (const basename of basenames) {
    if (!basename.startsWith(prefix)) continue;
    const rest = basename.slice(prefix.length);
    const n = parseInt(rest.slice(0, 3), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max;
}

async function maxClaimedFs(fsp, claimsDayDir) {
  let entries;
  try {
    entries = await fsp.readdir(claimsDayDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let max = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const n = parseInt(e.name, 10);
    if (!Number.isNaN(n) && pad3(n) === e.name && n > max) max = n;
  }
  return max;
}

// Atomic path. fsp: an fs.promises-shaped object (real node:fs promises, or a fake in
// tests) exposing mkdir(path) and mkdir(path, {recursive}) and readdir(path, {withFileTypes}).
// basePath: absolute vault root (from adapter.getBasePath()). tasksRootRel: vault-relative
// tasks root, e.g. "Operations/tasks". diskMax: the day's highest on-disk NNN, supplied by
// the caller (main.ts already has the vault file listing; this module never re-walks it).
export async function claimNextTaskIdFs({ fsp, basePath, tasksRootRel, day, diskMax }) {
  const tasksRoot = joinPath(basePath, tasksRootRel);
  const claimsDayDir = joinPath(tasksRoot, ".id-claims", day);
  await fsp.mkdir(claimsDayDir, { recursive: true });
  const claimMax = await maxClaimedFs(fsp, claimsDayDir);
  let cursor = Math.max(diskMax, claimMax);
  for (let attempt = 0; attempt < MAX_RETRIES_PER_ID; attempt++) {
    cursor += 1;
    const candidate = pad3(cursor);
    try {
      await fsp.mkdir(joinPath(claimsDayDir, candidate));
      return `tsk-${day}-${candidate}`;
    } catch (err) {
      if (err && err.code === "EEXIST") continue; // someone else holds this NNN, try next
      throw err;
    }
  }
  throw new Error(
    `taskIdClaim: exhausted ${MAX_RETRIES_PER_ID} retries claiming an id for ${day} (started at cursor ${cursor - MAX_RETRIES_PER_ID})`
  );
}

// Best-effort, NON-atomic fallback for when Node fs is unavailable. adapter: an
// Obsidian-vault-adapter-shaped object exposing list(path) -> {files, folders} and
// mkdir(path). tasksRootRel + day + diskMax as above. Does not retry on collision: this path
// cannot detect a collision (see header), it can only avoid reissuing a NNN it can see.
export async function claimNextTaskIdAdapter({ adapter, tasksRootRel, day, diskMax }) {
  const claimsDayDir = `${tasksRootRel}/.id-claims/${day}`;
  let claimMax = 0;
  try {
    const listing = await adapter.list(claimsDayDir);
    for (const folder of listing?.folders || []) {
      const name = folder.split("/").pop();
      const n = parseInt(name, 10);
      if (!Number.isNaN(n) && pad3(n) === name && n > claimMax) claimMax = n;
    }
  } catch {
    // day folder doesn't exist yet (or listing failed); claimMax stays 0
  }
  const cursor = Math.max(diskMax, claimMax) + 1;
  const candidate = pad3(cursor);
  try {
    await adapter.mkdir(`${claimsDayDir}/${candidate}`);
  } catch {
    // best-effort only; still return the id since adapter.mkdir cannot report a real
    // collision here (see header: it is recursive and silently no-ops on EEXIST)
  }
  return `tsk-${day}-${candidate}`;
}

// UTC calendar day, YYYY-MM-DD, matching mint-task-id.mjs's todayUTC() exactly (both use
// getUTC* accessors, never local-time getters). `now` is injectable so tests can pin an
// instant instead of racing the real clock; main.ts always calls this with no argument.
// The plugin and the CLI MUST agree on what day it is: if one read local time and the other
// UTC, quick-add and an agent's mint-task-id.mjs call would file claims for different days for
// part of every day (four hours a day at UTC+4, tsk-2026-09-17-021 Minor M-4) with nothing to
// signal the split -- two claim spaces, duplicate ids return, no error anywhere.
export function todayUTCDay(now = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

// Full selection between the atomic fs path and the best-effort adapter path, with every
// environment probe injected so the whole decision -- not just the two claim primitives --
// is unit-testable (tsk-2026-09-17-021 Important-1: previously nothing exercised the claim
// root string, the getBasePath probe, or the fs-vs-adapter branch itself; a wrong root or a
// broken selection left the test suite green).
//
// adapter: the Obsidian vault adapter (passed straight through to claimNextTaskIdAdapter).
// tasksRootRel: the caller's OWN tasks-root setting, never hardcoded (Important-3: a claim
// root that diverges from where createQuickTask actually writes the file silently splits the
// claim space against both the CLI and any future write-path change).
// day / diskMax: as the two claim primitives.
// getBasePath: () => string | null | undefined, may throw. Absence (mobile, or any adapter
// without a resolvable filesystem base path) is EXPECTED and stays quiet -- there is nothing
// to alert on, the adapter path is simply correct here.
// requireFs: () => an object shaped like node's `fs` module (i.e. exposes `.promises`), may
// throw. Thrown here means "no Node fs in this environment despite a resolved base path": an
// unusual but still non-atomic-by-necessity situation, treated the same as "no fs" -- quiet.
// notice: (message: string) => void, called ONLY when the environment looked capable of the
// atomic path (basePath resolved AND fs required successfully) and the claim itself then threw
// -- e.g. EACCES/EPERM on the claim directory, or MAX_RETRIES_PER_ID exhausted under
// pathological contention. That is the case Important-2 named: silently reopening the exact
// defect this task closes must not be silent. May be omitted (tests that don't care about the
// Notice text can leave it undefined; the fallback still runs).
export async function resolveNextTaskId({
  adapter,
  tasksRootRel,
  day,
  diskMax,
  getBasePath,
  requireFs,
  notice,
}) {
  let basePath;
  try {
    basePath = getBasePath ? getBasePath() : undefined;
  } catch {
    basePath = undefined; // no usable base path; quiet, expected (e.g. mobile)
  }
  if (typeof basePath === "string" && basePath) {
    let fsp = null;
    try {
      const fsModule = requireFs ? requireFs() : null;
      fsp = fsModule ? fsModule.promises : null;
    } catch {
      fsp = null; // no Node fs despite a resolved base path; quiet, treated as "no fs here"
    }
    if (fsp) {
      try {
        return await claimNextTaskIdFs({ fsp, basePath, tasksRootRel, day, diskMax });
      } catch (err) {
        if (notice) {
          notice(
            `AIOS: could not claim a task id atomically (${err && err.message ? err.message : err}). ` +
              `Falling back to a non-atomic claim; if this repeats, check the tasks folder is writable.`
          );
        }
        // fall through to the adapter path deliberately: task creation must not block on this
      }
    }
  }
  return await claimNextTaskIdAdapter({ adapter, tasksRootRel, day, diskMax });
}
