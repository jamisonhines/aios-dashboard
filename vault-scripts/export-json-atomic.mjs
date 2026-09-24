import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Test timing knobs require an explicit fixture gate. Production ignores inherited
// AIOS_EXPORT_TEST_* values, so a developer shell cannot shorten live lock leases.
const exportTestEnv = (name) => process.env.AIOS_EXPORT_TEST_MODE === "1" ? process.env[name] : undefined;
const staleMs = () => Number(exportTestEnv("AIOS_EXPORT_TEST_LOCK_STALE_MS")) || 120_000;
const holdMs = () => Number(exportTestEnv("AIOS_EXPORT_TEST_HOLD_MS")) || 0;
const chunkDelayMs = () => Number(exportTestEnv("AIOS_EXPORT_TEST_WRITE_CHUNK_DELAY_MS")) || 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerPath = (lockPath) => path.join(lockPath, "owner.json");

export async function isCurrentExportOwner(lockPath, token) {
  try {
    const owner = JSON.parse(await fs.readFile(ownerPath(lockPath), "utf8"));
    return owner?.pid === token.pid && owner?.nonce === token.nonce;
  } catch { return false; }
}

function lostLockError() {
  const error = new Error("export lock lost mid-run; refusing to publish over a newer snapshot");
  error.code = "AIOS_EXPORT_LOCK_LOST";
  return error;
}

export async function writeJsonAtomic(filePath, value, { beforeRename } = {}) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const json = JSON.stringify(value, null, 2) + "\n";
    const handle = await fs.open(tempPath, "wx");
    try {
      const delay = chunkDelayMs();
      if (delay > 0) {
        const width = Math.max(1, Math.ceil(json.length / 8));
        for (let start = 0; start < json.length; start += width) {
          await handle.write(json.slice(start, start + width), null, "utf8");
          await sleep(delay);
        }
      } else await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    if (beforeRename && !(await beforeRename())) throw lostLockError();
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withOwnedExportLock(filePath, work, { waitMs = 1000 } = {}) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + waitMs;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let token = null;
  while (!token) {
    try {
      await fs.mkdir(lockPath);
      token = { pid: process.pid, nonce: randomBytes(8).toString("hex") };
      try { await fs.writeFile(ownerPath(lockPath), JSON.stringify(token)); }
      catch (ownerError) { await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {}); throw ownerError; }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stat;
      try { stat = await fs.stat(lockPath); }
      catch (statError) { if (statError?.code !== "ENOENT") throw statError; }
      if (stat && Date.now() - stat.mtimeMs > staleMs()) {
        const coordPath = `${lockPath}.steal-coord`;
        try {
          const coordStat = await fs.stat(coordPath);
          if (Date.now() - coordStat.mtimeMs > staleMs()) await fs.rm(coordPath, { recursive: true, force: true });
        } catch (coordStatError) { if (coordStatError?.code !== "ENOENT") throw coordStatError; }
        try {
          await fs.mkdir(coordPath);
          try {
            const fresh = await fs.stat(lockPath);
            if (Date.now() - fresh.mtimeMs > staleMs()) {
              const tombstone = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
              await fs.rename(lockPath, tombstone);
              await fs.rm(tombstone, { recursive: true, force: true });
            }
          } catch (stealError) { if (stealError?.code !== "ENOENT") throw stealError; }
          finally { await fs.rm(coordPath, { recursive: true, force: true }).catch(() => {}); }
        } catch (coordError) { if (coordError?.code !== "EEXIST") throw coordError; }
      }
      if (Date.now() >= deadline) return { busy: true };
      await sleep(25);
    }
  }
  const isOwner = () => isCurrentExportOwner(lockPath, token);
  try {
    if (holdMs() > 0) await sleep(holdMs());
    if (!(await isOwner())) throw lostLockError();
    await work({ lockPath, token, isOwner });
    return { busy: false };
  } finally {
    if (token && await isOwner()) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
