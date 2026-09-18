// Shared helpers for exportUsageAtomicWrite.test.mjs (default suite, npm test) and
// exportUsageAtomicWrite.mutations.test.mjs (opt-in, npm run test:mutations). Split out round 4
// (Reviewer round 3, R3-I1/R3-I2) so both files spawn the exporter and build fixtures the same
// way, without duplicating drift-prone scenario logic between a "real" and a "mutated" copy.
//
// R3-I1: every `runExporter` call here takes an optional `exporterCli` override (default: the
// real TRACKED_EXPORTER_CLI). The mutations script uses `makeMutatedExporterCopy` to write its
// mutated source into a FRESH TEMP FILE and passes that path in -- the tracked
// vault-scripts/export-usage-stats.mjs is only ever READ here, never written. This is the fix
// for Reviewer round 3's measured defect: the old in-suite mutation blocks wrote the mutated
// copy directly over the tracked file and relied on a `finally` to restore it, which a SIGINT,
// a session-limit kill, or any non-graceful exit skips entirely, leaving production source
// broken on disk (measured: the pre-publish ownership check silently deleted, `git status`
// showing the worktree modified, with nothing forcing anyone to look before the next deploy).
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TRACKED_EXPORTER_CLI = path.join(here, "vault-scripts", "export-usage-stats.mjs");
if (!existsSync(TRACKED_EXPORTER_CLI)) {
  throw new Error(`exportUsageAtomicWriteHelpers: exporter CLI not found at ${TRACKED_EXPORTER_CLI}`);
}

export async function makeFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `usage-atomic-e2e-${process.pid}-`));
  const vaultRoot = path.join(root, "vault");
  const projectsRoot = path.join(root, "claude-projects");
  const piRoot = path.join(root, "pi-sessions");
  const bbRoot = path.join(root, "bb-sessions");
  await fs.mkdir(vaultRoot, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.mkdir(piRoot, { recursive: true });
  await fs.mkdir(bbRoot, { recursive: true });
  // A handful of real-shaped transcript entries so the exporter has a real file to scan (not
  // just an empty transcripts root) before the write. Reviewer round 1, Minor 7 (corrected,
  // not just re-worded): these fixed 2026-09-18 timestamps land in the FUTURE relative to
  // whatever instant a test actually runs at, so the exporter's own upper-bound-vs-now check
  // (audit item 3, unrelated to this task) rejects every one of them -- every run genuinely
  // reports 0 message(s) and $0.00 cost, confirmed by inspecting actual test output, not
  // assumed. This is fine for what these tests need (write mechanics, locking, status
  // recording, none of which depend on the retained record COUNT being nonzero), but the
  // fixture is NOT "nontrivial" data the way the original comment here claimed.
  const projectDir = path.join(projectsRoot, "fixture-project");
  await fs.mkdir(projectDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: `2026-09-18T10:${String(i).padStart(2, "0")}:00.000Z`,
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          id: `resp-${i}`,
          content: "hello",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })
    );
  }
  await fs.writeFile(path.join(projectDir, "session.jsonl"), lines.join("\n") + "\n");
  return { root, vaultRoot, projectsRoot, piRoot, bbRoot };
}

export function outPaths(vaultRoot) {
  const outFile = path.join(vaultRoot, "Operations", "usage", "usage-stats.json");
  const statusFile = path.join(vaultRoot, "Operations", "usage", "usage-stats.status.json");
  const lockFile = `${outFile}.lock`;
  return { outFile, statusFile, lockFile };
}

// `killAfterMs`: a hard external watchdog, distinct from the exporter's own lockWaitMs. Used
// only by the hot-spin regression test (Important 2) -- a genuinely hung/spinning child must
// not be able to hang THIS TEST forever; if the process is still alive after killAfterMs, it
// is SIGKILLed and resolved with `timedOut: true`, mirroring exactly how Reviewer round 1
// reproduced the regression by hand (SIGKILLed at 8005ms).
//
// `exporterCli`: R3-I1 -- defaults to the real tracked file (used by every positive test in the
// default suite); the mutations script always passes an explicit temp-file path here instead.
export function runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot, env = {}, killAfterMs = null, exporterCli = TRACKED_EXPORTER_CLI }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [exporterCli, vaultRoot], {
      env: {
        ...process.env,
        USAGE_EXPORT_TEST_PROJECTS_ROOT: projectsRoot,
        USAGE_EXPORT_TEST_PI_ROOT: piRoot,
        USAGE_EXPORT_TEST_BB_ROOT: bbRoot,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const watchdog = killAfterMs
      ? setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
        }, killAfterMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      resolve({ code, stdout, stderr, signal, elapsedMs: Date.now() - startedAt, timedOut: signal === "SIGKILL" && killAfterMs !== null });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      resolve({ code: -1, stdout, stderr: String(err), elapsedMs: Date.now() - startedAt, timedOut: false });
    });
  });
}

// Poll `outFile` continuously while `work` runs, recording every distinct outcome observed:
// "absent" (ENOENT, expected before the first successful run), "valid" (parses as JSON with
// the expected top-level shape), or "invalid" (file existed and read but did NOT parse, or
// parsed into something that isn't a usage-stats shape -- this is the truncated/interleaved
// case the fix exists to prevent).
export async function pollWhile(outFile, work) {
  const outcomes = new Set();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      try {
        const raw = await fs.readFile(outFile, "utf8");
        try {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.days) && Array.isArray(parsed.projects)) {
            outcomes.add("valid");
          } else {
            outcomes.add("invalid:unexpected-shape");
          }
        } catch (parseErr) {
          outcomes.add(`invalid:${parseErr.message}`);
        }
      } catch (readErr) {
        if (readErr.code === "ENOENT") outcomes.add("absent");
        else outcomes.add(`invalid:read-error:${readErr.message}`);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const result = await work();
  polling = false;
  await poll;
  return { outcomes, result };
}

// R3-I1: reads the TRACKED exporter, applies `mutateFn(originalSource) -> mutatedSource`, and
// writes the result into a FRESH TEMP FILE -- never the tracked path. `mutateFn` should throw
// or the caller should assert on `changed` if the expected needle text is missing, so a
// reformatted tracked file disarms the mutation loudly instead of silently mutating nothing.
// Returns `{ exporterCli, changed, cleanup }`; the caller must always call `cleanup()` (a
// `finally` at the call site is fine -- there is nothing to restore, cleanup only removes a
// throwaway temp file, so even a SIGINT here leaves the tracked file untouched and merely
// strands a harmless temp file for the OS to reap).
export async function makeMutatedExporterCopy(mutateFn) {
  const original = await fs.readFile(TRACKED_EXPORTER_CLI, "utf8");
  const mutated = mutateFn(original);
  const dirRaw = await fs.mkdtemp(path.join(os.tmpdir(), "usage-exporter-mutation-"));
  // os.tmpdir() resolves through a symlink on macOS (/tmp -> /private/tmp). The exporter's own
  // `isDirectRun` guard compares `pathToFileURL(path.resolve(process.argv[1]))` against
  // `import.meta.url` -- Node resolves import.meta.url through the REAL (symlink-resolved)
  // path, but argv[1] is passed through as given, so spawning the exporter from the raw
  // (symlinked) tmp path makes that comparison silently fail and the exporter exits having run
  // NOTHING (measured: exit 0, empty stdout/stderr, 22ms -- looked like a trivial success until
  // checked). Resolving to the real path here, once, before ever building a exporterCli path
  // from it, avoids the mismatch entirely.
  const dir = await fs.realpath(dirRaw);
  const exporterCli = path.join(dir, "export-usage-stats.mjs");
  await fs.writeFile(exporterCli, mutated, "utf8");
  return {
    exporterCli,
    changed: mutated !== original,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

// --- Slow-holder scenario (Important 1): a holder that outlives the stale threshold must not -
// --- publish over, or corrupt the status of, whoever legitimately took its lock -------------
// Reproduces Reviewer's exact measured scenario: Holder A acquires and starts a long-running
// attempt; its lock ages past the (test-shortened) stale threshold while it is still "working"
// (USAGE_EXPORT_TEST_HOLD_MS); Holder B, a genuinely later/newer run, sees the stale lock,
// steals it, and completes normally; A then wakes up and must find it no longer owns the lock
// and REFUSE to publish or to stamp a stale status over B's newer one.
export async function runSlowHolderScenario({ exporterCli = TRACKED_EXPORTER_CLI } = {}) {
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, statusFile } = outPaths(vaultRoot);
  try {
    const staleMs = "80"; // USAGE_EXPORT_TEST_LOCK_STALE_MS
    const aHoldMs = 500; // A "holds" (post-acquire sleep) long enough for B to steal + finish
    const aPromise = runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_HOLD_MS: String(aHoldMs), USAGE_EXPORT_TEST_LOCK_WAIT_MS: "50" },
    });
    // Give A time to acquire, write its owner token, and enter its hold sleep, AND for its lock
    // dir's mtime to actually cross the (80ms) stale threshold before B starts looking.
    await new Promise((r) => setTimeout(r, 200));
    const bResult = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_LOCK_WAIT_MS: "3000" },
    });
    const aResult = await aPromise;
    return { aResult, bResult, outFile, statusFile, root };
  } catch (e) {
    await fs.rm(root, { recursive: true, force: true });
    throw e;
  }
}

// --- Widened-gap status race (Round 3, M1/R2-M1): writeStatusMonotonic's read-merge-write is
// --- NOT atomic across processes -- a slow holder's status write, computed from a read taken
// --- BEFORE a genuinely newer holder's success write lands, can still commit to disk AFTER it,
// --- silently erasing the newer holder's clean success. Reviewer's own harness shape: a slow
// --- holder A (USAGE_EXPORT_TEST_WRITE_CHUNK_DELAY_MS widens A's own write duration well past
// --- the moment B's real write lands) loses its lock to a stealer B; B's genuine success must
// --- survive untouched -- lastSuccessAt must never go backwards to null.
export async function runWidenedGapScenario({ exporterCli = TRACKED_EXPORTER_CLI } = {}) {
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, statusFile } = outPaths(vaultRoot);
  try {
    const staleMs = "80";
    const aHoldMs = 100;
    // 8x-amplified internally (writeJsonAtomic splits into 8 chunks, one sleep of this length
    // between each) -- 150ms here means ~1200ms per write, comfortably longer than B's whole
    // real scan+publish (measured well under 200ms against this fixture), which is exactly
    // what widens the gap between A's read (early, before B has written anything) and A's
    // eventual commit (late, after B's real write has already landed).
    const aChunkDelayMs = "150";
    const aPromise = runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: {
        USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs,
        USAGE_EXPORT_TEST_HOLD_MS: String(aHoldMs),
        USAGE_EXPORT_TEST_LOCK_WAIT_MS: "50",
        USAGE_EXPORT_TEST_WRITE_CHUNK_DELAY_MS: aChunkDelayMs,
      },
    });
    // Give A's lock time to age past the (80ms) stale threshold before B starts looking.
    await new Promise((r) => setTimeout(r, 200));
    const bResult = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_LOCK_WAIT_MS: "5000" },
    });
    const aResult = await aPromise;
    return { aResult, bResult, outFile, statusFile, root };
  } catch (e) {
    await fs.rm(root, { recursive: true, force: true });
    throw e;
  }
}

// --- Release ownership check (Round 3, M2): a slow holder A that has its lock stolen must
// --- never delete the NEW holder's lock out from under it on its own way out. Reviewer's
// --- harness shape: A is stolen and exits; the new holder B's lock must still be PRESENT
// --- (checked directly, not through A); and a third run C, arriving while B is still
// --- genuinely holding it, must be told busy (not find an absent lock and wrongly acquire).
export async function runReleaseOwnershipScenario({ exporterCli = TRACKED_EXPORTER_CLI } = {}) {
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { lockFile, statusFile } = outPaths(vaultRoot);
  try {
    // staleMs sits strictly between "how long B's start delay ages A's original lock" (must
    // exceed staleMs, so B correctly deems it stale and steals) and "how long the whole
    // A-wakes-and-exits-then-we-check window takes" (must stay under staleMs, so B's OWN
    // freshly re-created lock still reads as live, not stale, to both our direct check and to
    // C). B itself is held open (TEST_HOLD_MS) well past that whole window so it is still
    // genuinely inside its critical section when we check and when C runs.
    const staleMs = "1500";
    const bStartDelayMs = 1700; // > staleMs: A's original lock is unambiguously stale by then
    // aHoldMs needs a comfortable buffer past bStartDelayMs, not just "greater than" -- B's own
    // steal (detect stale -> coordinate -> rename away -> tail-sleep -> re-mkdir) takes a real,
    // if usually small, amount of wall time. Too thin a margin here made the MUTATION check
    // below flaky (measured): A's own finally could fire in the brief window BEFORE B's fresh
    // mkdir lands, so an unconditional (mutated) rm would hit ENOENT on nothing yet, and B's
    // lock would end up present anyway by sheer ordering, not because the removed check "still
    // worked" -- a false pass that would have hidden a real regression.
    const aHoldMs = 2000;
    const bHoldMs = 6000; // far longer than the whole scenario: B must still hold when C runs
    const aPromise = runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_HOLD_MS: String(aHoldMs), USAGE_EXPORT_TEST_LOCK_WAIT_MS: "50" },
    });
    await new Promise((r) => setTimeout(r, bStartDelayMs));
    const bPromise = runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_HOLD_MS: String(bHoldMs), USAGE_EXPORT_TEST_LOCK_WAIT_MS: "5000" },
    });
    const aResult = await aPromise;
    // A has now fully exited (including its finally-block release attempt). B is still deep
    // inside its own hold (well past whatever A's own path just took), so this is the exact
    // moment Reviewer's harness checks: is B's lock still present right after A's own exit?
    // Polled rather than checked once: B's own steal-then-reacquire sequence has a brief
    // (~tens of ms) window where no lock exists at all between renaming A's stale entry away
    // and B's own fresh mkdir landing, and child-process startup jitter can still be in that
    // window right when A exits -- polling for up to 300ms (B holds for 6000ms once acquired,
    // so this margin is not remotely close to racing B's own release) finds B's real, sustained
    // acquisition rather than an artifact of catching that transient gap.
    let bLockPresentAfterAExit = false;
    for (let i = 0; i < 10 && !bLockPresentAfterAExit; i++) {
      bLockPresentAfterAExit = await fs
        .stat(lockFile)
        .then(() => true)
        .catch(() => false);
      if (!bLockPresentAfterAExit) await new Promise((r) => setTimeout(r, 30));
    }
    const cResult = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      exporterCli,
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_LOCK_WAIT_MS: "200" },
    });
    const bResult = await bPromise;
    return { aResult, bResult, cResult, bLockPresentAfterAExit, lockFile, statusFile, root };
  } catch (e) {
    await fs.rm(root, { recursive: true, force: true });
    throw e;
  }
}

// --- Thundering herd (Important 1): N processes against one pre-existing stale lock must -----
// --- never show more than 1 simultaneous holder, repeated (not a one-shot pass) -------------
export async function runHerdIteration({ vaultRoot, projectsRoot, piRoot, bbRoot, markDir, exporterCli = TRACKED_EXPORTER_CLI }) {
  const { lockFile } = outPaths(vaultRoot);
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.mkdir(lockFile);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(lockFile, old, old);
  const N = 8;
  // STALE_MS must stay well ABOVE HOLD_MS here, mirroring production's real 14x margin
  // (LOCK_STALE_MS=120s vs. an 8.6s measured run): the first version of this test used
  // STALE_MS=20ms with HOLD_MS=30ms and got max overlap 2-4 on the UNMUTATED, correct code --
  // not a real bug, but every legitimate holder's OWN lock looked "stale" to its 7 rivals
  // partway through its own declared hold, so they correctly (by the staleness rule as
  // configured) stole a still-live lock out from under it. That is what LOCK_STALE_MS is
  // supposed to prevent when sized correctly; the test's parameters, not the mechanism, were
  // wrong. 1500ms vs. 30ms (50x) removes that self-steal risk while the ORIGINAL pre-existing
  // lock (backdated 5000ms, well past 1500ms) is still unambiguously stale from the start.
  const staleMs = "1500";
  const holdMs = "30";
  let maxOverlap = 0;
  let polling = true;
  const poll = (async () => {
    while (polling) {
      try {
        const entries = await fs.readdir(markDir);
        maxOverlap = Math.max(maxOverlap, entries.length);
      } catch {}
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
  await Promise.all(
    Array.from({ length: N }, () =>
      runExporter({
        vaultRoot,
        projectsRoot,
        piRoot,
        bbRoot,
        exporterCli,
        env: {
          USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs,
          USAGE_EXPORT_TEST_MARK_DIR: markDir,
          USAGE_EXPORT_TEST_HOLD_MS: holdMs,
          USAGE_EXPORT_TEST_LOCK_WAIT_MS: "5000",
        },
      })
    )
  );
  polling = false;
  await poll;
  return maxOverlap;
}

export { assert, fs, existsSync, os, path };
