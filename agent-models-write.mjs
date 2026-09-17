// Desktop-only project settings writer. It serializes cooperative dashboard
// writes and rejects symlinked paths. It is not a full CAS against an
// uncooperative external writer between its final read and rename.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const digestText = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const settingsPathFor = (vaultRoot) => path.resolve(vaultRoot, ".pi", "settings.json");
async function lstatOptional(file) { try { return await fs.lstat(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function assertSafeProjectPath(vaultRoot) {
  const root = path.resolve(vaultRoot); const pi = path.join(root, ".pi"); const file = settingsPathFor(root);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("unsafe project settings path");
  if ((await lstatOptional(pi))?.isSymbolicLink()) throw new Error("unsafe project settings path: .pi must not be a symlink");
  if ((await lstatOptional(file))?.isSymbolicLink()) throw new Error("unsafe project settings path: settings.json must not be a symlink");
  return file;
}
export async function readProjectAgentSettings(vaultRoot) {
  const file = await assertSafeProjectPath(vaultRoot); let raw = "";
  try { raw = await fs.readFile(file, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  let value = {}; if (raw) { try { value = JSON.parse(raw); } catch { throw new Error("project Pi settings are malformed JSON"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project Pi settings must be a JSON object"); }
  return { raw, value, digest: digestText(raw), path: file };
}
async function acquireLock(settingsPath) {
  const lock = `${settingsPath}.aios-dashboard.lock`;
  try { return { lock, handle: await fs.open(lock, "wx", 0o600) }; }
  catch (error) { if (error?.code === "EEXIST") throw new Error("configuration save already in progress; if no dashboard save is active, verify the lock owner before removing it"); throw error; }
}
export async function writeProjectAgentOverride(vaultRoot, agent, model, fallbackModels, expectedDigest, hooks = {}) {
  const safePath = await assertSafeProjectPath(vaultRoot);
  await fs.mkdir(path.dirname(safePath), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(safePath);
  try {
    const before = await readProjectAgentSettings(vaultRoot);
    if (before.digest !== expectedDigest) throw new Error("configuration changed on disk, refresh and retry");
    const value = structuredClone(before.value); value.subagents ||= {};
    if (!value.subagents || typeof value.subagents !== "object" || Array.isArray(value.subagents)) throw new Error("project Pi settings subagents must be an object");
    value.subagents.agentOverrides ||= {};
    if (!value.subagents.agentOverrides || typeof value.subagents.agentOverrides !== "object" || Array.isArray(value.subagents.agentOverrides)) throw new Error("project Pi settings agentOverrides must be an object");
    const old = value.subagents.agentOverrides[agent]; const next = { ...(old && typeof old === "object" && !Array.isArray(old) ? old : {}), model, fallbackModels };
    value.subagents.agentOverrides[agent] = next; const output = JSON.stringify(value, null, 2) + "\n";
    // Absence differs from []: only an explicitly persisted empty array is a no-op clear.
    if (output === before.raw) return { status: "no-op", digest: before.digest };
    await hooks.beforeFinalRead?.(before.path);
    const current = await readProjectAgentSettings(vaultRoot);
    if (current.digest !== before.digest) throw new Error("configuration changed on disk, refresh and retry");
    const temporary = path.join(path.dirname(before.path), `.settings.${process.pid}.${randomUUID()}.tmp`); let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(output, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
      // Test-only canary exposes the final-check-to-rename boundary. It is not
      // an assertion of full external-writer CAS.
      await hooks.beforeRename?.(before.path);
      await fs.rename(temporary, before.path);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
    const verified = await readProjectAgentSettings(vaultRoot); if (verified.raw !== output) throw new Error("configuration write verification failed");
    return { status: "written", digest: verified.digest };
  } finally { await lock.handle.close().catch(() => {}); await fs.unlink(lock.lock).catch(() => {}); }
}
