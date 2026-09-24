import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const staleMs = () => Number(process.env.AIOS_EXPORT_TEST_LOCK_STALE_MS) || 120_000;
const holdMs = () => Number(process.env.AIOS_EXPORT_TEST_HOLD_MS) || 0;
const chunkDelayMs = () => Number(process.env.AIOS_EXPORT_TEST_WRITE_CHUNK_DELAY_MS) || 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerPath = (lockPath) => path.join(lockPath, "owner.json");

async function sameOwner(lockPath, token) {
  try {
    const owner = JSON.parse(await fs.readFile(ownerPath(lockPath), "utf8"));
    return owner?.pid === token.pid && owner?.nonce === token.nonce;
  } catch { return false; }
}

export async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
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
  try { await fs.rename(tempPath, filePath); }
  catch (error) { await fs.rm(tempPath, { force: true }).catch(() => {}); throw error; }
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
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs()) {
          const coordPath = `${lockPath}.steal-coord`;
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
      } catch (statError) { if (statError?.code !== "ENOENT") throw statError; }
      if (Date.now() >= deadline) return { busy: true };
      await sleep(25);
    }
  }
  try {
    if (holdMs() > 0) await sleep(holdMs());
    await work();
    return { busy: false };
  } finally {
    if (token && await sameOwner(lockPath, token)) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
