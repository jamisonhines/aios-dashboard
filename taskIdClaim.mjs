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
//    `fs` module is already used at runtime from main.ts today (agent-models-write.mjs is
//    imported there and calls node:fs directly, confirming the plugin already relies on Node
//    fs being present when it's imported this way), so this is the normal path, not a
//    best-effort one.
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
