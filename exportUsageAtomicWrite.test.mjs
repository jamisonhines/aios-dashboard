// Tests for the atomic-publish/single-writer-lock/run-status half of
// tsk-2026-09-17-024 ("Usage exporter writes the live JSON non-atomically and has no refresh
// trigger wired"). Spawns the REAL exporter CLI (vault-scripts/export-usage-stats.mjs) as
// child processes against an isolated fixture vault -- no fake write function stands in for
// the code under test. Run: node exportUsageAtomicWrite.test.mjs
//
// Mutation-proof notes (GL-009): the two mutations exercised here target DIFFERENT
// mechanisms, because the fix's two halves (atomic rename, single-writer lock) protect
// against different failure modes:
//   - Reverting the atomic temp+rename publish to a direct write is caught by the
//     concurrent-writer JSON-validity test (see "RED RUN" below for the captured mutation
//     output).
//   - Disabling the lock is NOT caught by that same validity test (measured) -- but IS caught
//     independently by TWO different assertions: the live-lock busy-exit test above, and the
//     lock-serialization critical-section-overlap test below. Reviewer round 1 corrected an
//     earlier draft of this comment that claimed only one of the two: running the WHOLE file
//     under the mutation halts at the live-lock test (the first of the two to appear in file
//     order), which made the serialization test look unreached/uncaught. Reviewer confirmed by
//     running a reduced copy with the live-lock block removed: the serialization test reds on
//     its own too. See the "lock mutation" section below for both pieces of evidence.
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPORTER_CLI = path.join(here, "vault-scripts", "export-usage-stats.mjs");
if (!existsSync(EXPORTER_CLI)) {
  throw new Error(`exportUsageAtomicWrite.test: exporter CLI not found at ${EXPORTER_CLI}`);
}

async function makeFixtureRoot() {
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

function outPaths(vaultRoot) {
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
function runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot, env = {}, killAfterMs = null }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [EXPORTER_CLI, vaultRoot], {
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
async function pollWhile(outFile, work) {
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

// --- Concurrent-writer test: N real exporter processes, one reader loop -------------------
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile } = outPaths(vaultRoot);
  try {
    const N = 3;
    const { outcomes, result: results } = await pollWhile(outFile, () =>
      Promise.all(
        Array.from({ length: N }, () =>
          runExporter({
            vaultRoot,
            projectsRoot,
            piRoot,
            bbRoot,
            env: { USAGE_EXPORT_TEST_WRITE_CHUNK_DELAY_MS: "15", USAGE_EXPORT_TEST_LOCK_WAIT_MS: "5000" },
          })
        )
      )
    );
    const invalid = [...outcomes].filter((o) => o.startsWith("invalid"));
    assert.deepEqual(invalid, [], `reader must never observe truncated/invalid JSON, saw: ${JSON.stringify(invalid)}`);
    assert.ok(outcomes.has("valid"), "reader must observe at least one valid snapshot during the run");
    for (const r of results) {
      assert.equal(r.code, 0, `every concurrent exporter process must exit 0 (either it wrote, or it saw a live lock and exited cleanly): ${JSON.stringify(r)}`);
    }
    const finalRaw = await fs.readFile(outFile, "utf8");
    const finalParsed = JSON.parse(finalRaw);
    assert.ok(Array.isArray(finalParsed.days) && Array.isArray(finalParsed.projects), "final file is a valid, complete usage-stats snapshot");
    console.log(`concurrent-writer test: ${N} real exporter processes, ${outcomes.size} distinct read outcomes observed, all clean: ${[...outcomes].join(", ")}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Stale-lock recovery: an abandoned (old) lock dir does not block forever --------------
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, lockFile } = outPaths(vaultRoot);
  try {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.mkdir(lockFile);
    // Back-date the lock dir well past LOCK_STALE_MS (120_000ms in the exporter) by touching
    // its mtime into the past, simulating a crashed holder that never released it.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(lockFile, old, old);
    const result = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      env: { USAGE_EXPORT_TEST_LOCK_WAIT_MS: "3000" },
    });
    assert.equal(result.code, 0, `a run behind a stale lock must recover and succeed, got: ${JSON.stringify(result)}`);
    assert.ok(existsSync(outFile), "stale-lock recovery must still produce a snapshot");
    const parsed = JSON.parse(await fs.readFile(outFile, "utf8"));
    assert.ok(Array.isArray(parsed.days), "the recovered run's output is a valid snapshot");
    console.log("stale-lock test: a 10-minute-old lock dir was reclaimed and the run succeeded");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- A live (fresh) lock is respected: the waiting run exits 0 cleanly, prior snapshot intact
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, lockFile } = outPaths(vaultRoot);
  try {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify({ days: [], projects: [], marker: "prior-good-snapshot" }) + "\n");
    await fs.mkdir(lockFile); // fresh -- mtime is now
    const result = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      env: { USAGE_EXPORT_TEST_LOCK_WAIT_MS: "200" },
    });
    assert.equal(result.code, 0, "a run that finds a LIVE lock held must exit 0 cleanly, not fail the SessionStart hook step");
    assert.match(result.stdout, /usage export busy/, "the one-line busy message must be printed");
    const finalRaw = await fs.readFile(outFile, "utf8");
    assert.equal(JSON.parse(finalRaw).marker, "prior-good-snapshot", "the busy run must never touch the prior valid snapshot");
    console.log("live-lock test: busy run exited 0 with a one-line message, prior snapshot untouched");
  } finally {
    await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Failed run: previous snapshot survives, status records the error ---------------------
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, statusFile } = outPaths(vaultRoot);
  try {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify({ days: [], projects: [], marker: "prior-good-snapshot" }) + "\n");
    // Force a real thrown error inside the critical section (see USAGE_EXPORT_TEST_FORCE_FAIL
    // in the exporter -- every real failure mode, disk full, permissions, etc., is awkward to
    // reproduce deterministically from outside, so this exercises the actual catch/status
    // path with a genuine throw rather than faking any code under test). Notably: every
    // directory-scan helper the exporter calls swallows its own read errors (by design, so a
    // missing/unreadable projects root just means "zero transcripts found," not a hard
    // failure) -- confirmed by trying a broken projectsRoot first, which produced exit 0, not
    // a failure, before this hook was added.
    const result = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      env: { USAGE_EXPORT_TEST_LOCK_WAIT_MS: "1000", USAGE_EXPORT_TEST_FORCE_FAIL: "1" },
    });
    assert.notEqual(result.code, 0, `a genuinely broken scan root must fail, got: ${JSON.stringify(result)}`);
    const finalRaw = await fs.readFile(outFile, "utf8");
    assert.equal(JSON.parse(finalRaw).marker, "prior-good-snapshot", "a failed run must never touch the previous valid snapshot");
    assert.ok(existsSync(statusFile), "a failed run must still publish a status sidecar");
    const status = JSON.parse(await fs.readFile(statusFile, "utf8"));
    assert.ok(status.lastAttemptAt, "status records the attempt time even on failure");
    assert.ok(status.lastError, "status records a non-empty error message on failure");
    assert.equal(status.lastSuccessAt, null, "no prior success recorded for this fresh fixture, so lastSuccessAt stays null");
    console.log(`failed-run test: exporter exited ${result.code}, status.lastError="${status.lastError}", prior snapshot intact`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Successful run publishes a status sidecar with lastSuccessAt and no error -------------
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { statusFile } = outPaths(vaultRoot);
  try {
    const result = await runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot });
    assert.equal(result.code, 0, `expected a clean run: ${JSON.stringify(result)}`);
    const status = JSON.parse(await fs.readFile(statusFile, "utf8"));
    assert.ok(status.lastAttemptAt, "successful run records an attempt time");
    assert.ok(status.lastSuccessAt, "successful run records a success time");
    assert.equal(status.lastError, null, "successful run clears any prior error");
    console.log("success-status test: status sidecar has lastSuccessAt set and lastError cleared");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Lock mutation: what actually catches a disabled lock (measured, not assumed) ----------
// Real mutation performed against this exact worktree (`let acquired = false;` ->
// `let acquired = true;`, skipping the mkdir/EEXIST loop entirely so no process ever waits):
// running this whole file RED at the "live-lock" test above, not here --
//
//   AssertionError [ERR_ASSERTION]: the one-line busy message must be printed
//   actual: 'usage-stats: 1 transcript(s), 0 message(s), ... -> .../usage-stats.json\n'
//   expected: /usage export busy/
//
// i.e. a process that should have found a live lock and exited 0 with "busy" instead barreled
// straight through and overwrote the snapshot. The concurrent-writer JSON-validity test (top
// of this file) and the stale-lock test both stayed GREEN under this same mutation -- atomic
// rename alone already means a reader never observes a partial write, lock or no lock, so
// those two assertions genuinely tell you nothing about whether the lock exists. Confirmed
// honestly rather than assumed.
//
// For the mechanism itself (not just an assertion that happens to notice a symptom), a direct
// measurement: under this mutation, 3 concurrently spawned real exporter processes (each
// holding a 150ms USAGE_EXPORT_TEST_HOLD_MS window) showed a max of 3 simultaneous holders via
// the USAGE_EXPORT_TEST_MARK_DIR counter below -- vs. 1 with the lock intact (see the block
// immediately below). The mutation was reverted (`git checkout -- vault-scripts/export-usage-stats.mjs`)
// before this file was committed; the fix is back in place for the assertion below.
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const markDir = path.join(root, "marks");
  await fs.mkdir(markDir, { recursive: true });
  try {
    const N = 3;
    let maxObservedOverlap = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        try {
          const entries = await fs.readdir(markDir);
          maxObservedOverlap = Math.max(maxObservedOverlap, entries.length);
        } catch {
          // markDir briefly absent between mkdtemp cleanup steps; ignore
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    await Promise.all(
      Array.from({ length: N }, () =>
        runExporter({
          vaultRoot,
          projectsRoot,
          piRoot,
          bbRoot,
          env: {
            USAGE_EXPORT_TEST_MARK_DIR: markDir,
            USAGE_EXPORT_TEST_HOLD_MS: "150",
            USAGE_EXPORT_TEST_LOCK_WAIT_MS: "5000",
          },
        })
      )
    );
    polling = false;
    await poll;
    assert.equal(
      maxObservedOverlap,
      1,
      `with the lock intact, at most one exporter process may be inside the critical section at once; observed max overlap ${maxObservedOverlap}. ` +
        `(A lock-disabled mutation run of this same assertion, performed by hand, observed overlap of 2-3 -- see the comment above this block for the transcript.)`
    );
    console.log(`lock-serialization test: max observed concurrent holders = ${maxObservedOverlap} (must be 1)`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// =============================================================================================
// Round 2 (Reviewer CHANGES REQUIRED, Important 1-2 + Minor 4): lock ownership, race-safe
// steal, the unified deadline/sleep tail, and a lock-release regression test.
// =============================================================================================

// --- Minor 4: lock release is exercised, not just present -----------------------------------
// Reviewer round 1 measured: deleting the `fs.rm(lockFile)` release call left the WHOLE round-1
// suite green, because every concurrent test used a generous lock wait and accepted a busy
// exit-0 as fine. This test is SEQUENTIAL (not concurrent) specifically to be sensitive to
// that: run once, then run again immediately with a short wait. If release works, the second
// run acquires promptly and produces a normal success banner. If release is broken, the first
// run's lock is still fresh (not yet stale), so the second run waits out its short deadline and
// busy-exits instead.
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  try {
    const first = await runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot });
    assert.equal(first.code, 0, `first run must succeed: ${JSON.stringify(first)}`);
    const second = await runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot, env: { USAGE_EXPORT_TEST_LOCK_WAIT_MS: "300" } });
    assert.equal(second.code, 0, `second run must also succeed: ${JSON.stringify(second)}`);
    assert.doesNotMatch(second.stdout, /usage export busy/, "a released lock must let the very next run proceed immediately, not wait out its deadline and report busy");
    assert.match(second.stdout, /usage-stats: \d+ transcript\(s\)/, "the second run's own success banner must be the real one, not the busy one-liner");
    console.log("lock-release test: two sequential runs both succeeded normally, no busy exit");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Slow-holder scenario (Important 1): a holder that outlives the stale threshold must not -
// --- publish over, or corrupt the status of, whoever legitimately took its lock -------------
// Reproduces Reviewer's exact measured scenario: Holder A acquires and starts a long-running
// attempt; its lock ages past the (test-shortened) stale threshold while it is still "working"
// (USAGE_EXPORT_TEST_HOLD_MS); Holder B, a genuinely later/newer run, sees the stale lock,
// steals it, and completes normally; A then wakes up and must find it no longer owns the lock
// and REFUSE to publish or to stamp a stale status over B's newer one.
async function runSlowHolderScenario() {
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
      env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: staleMs, USAGE_EXPORT_TEST_LOCK_WAIT_MS: "3000" },
    });
    const aResult = await aPromise;
    return { aResult, bResult, outFile, statusFile, root };
  } catch (e) {
    await fs.rm(root, { recursive: true, force: true });
    throw e;
  }
}

{
  const { aResult, bResult, outFile, statusFile, root } = await runSlowHolderScenario();
  try {
    assert.equal(bResult.code, 0, `B (the stealer) must succeed: ${JSON.stringify(bResult)}`);
    assert.notEqual(aResult.code, 0, `A (the slow holder that lost its lock) must NOT exit 0 -- it must refuse to publish: ${JSON.stringify(aResult)}`);
    assert.match(aResult.stderr, /lock lost mid-run/i, "A's failure must name the specific reason (GL-009 rule 3): it lost the lock, not some other error");
    const status = JSON.parse(await fs.readFile(statusFile, "utf8"));
    assert.equal(status.lastError, null, "A's (older, refused) failure must never overwrite B's (newer, real) clean success in the status sidecar");
    assert.ok(status.lastSuccessAt, "B's success must be recorded");
    const data = JSON.parse(await fs.readFile(outFile, "utf8"));
    assert.ok(Array.isArray(data.days), "the published snapshot is B's valid one (A never got to publish)");
    console.log(`slow-holder test: A correctly refused to publish (stderr: "${aResult.stderr.trim().split("\n").pop()}"), B's status/data stand untouched`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- MUTATION (GL-009): disable the pre-publish ownership recheck, rerun the exact same slow-
// --- holder scenario, capture the real RED. ---------------------------------------------------
{
  const exporterPath = EXPORTER_CLI;
  const original = await fs.readFile(exporterPath, "utf8");
  const needle = `  if (!(await isCurrentOwner(lockFile, ownerToken))) {\n    const lost = new Error("usage export: lock lost mid-run (stolen after exceeding the stale threshold); refusing to publish over a possibly newer snapshot");\n    lost.code = "USAGE_EXPORT_LOCK_LOST";\n    throw lost;\n  }\n`;
  assert.ok(original.includes(needle), "the ownership-recheck block must be present verbatim before mutating it (fixture drift guard)");
  const mutated = original.replace(needle, "");
  await fs.writeFile(exporterPath, mutated, "utf8");
  let observed;
  try {
    const { aResult, bResult, root } = await runSlowHolderScenario();
    observed = { aCode: aResult.code, aStderr: aResult.stderr, bCode: bResult.code };
    await fs.rm(root, { recursive: true, force: true });
  } finally {
    await fs.writeFile(exporterPath, original, "utf8");
  }
  assert.equal(observed.bCode, 0, "B still succeeds regardless (sanity check on the mutated run)");
  assert.equal(
    observed.aCode,
    0,
    `MUTATION CHECK: with the ownership recheck removed, the slow holder A must now WRONGLY succeed and publish over B's snapshot (exit 0), proving the recheck (not something else) was what stopped this -- got exit ${observed.aCode}, stderr: ${observed.aStderr}`
  );
  console.log("MUTATION (ownership recheck removed): A wrongly succeeded and would have overwritten B's newer snapshot -- confirms the recheck is load-bearing. Reverted.");
}

// --- Thundering herd (Important 1): N processes against one pre-existing stale lock must -----
// --- never show more than 1 simultaneous holder, repeated (not a one-shot pass) -------------
async function runHerdIteration({ vaultRoot, projectsRoot, piRoot, bbRoot, markDir }) {
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

{
  const ITERATIONS = 12;
  const overlaps = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
    const markDir = path.join(root, "marks");
    await fs.mkdir(markDir, { recursive: true });
    try {
      overlaps.push(await runHerdIteration({ vaultRoot, projectsRoot, piRoot, bbRoot, markDir }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(
    overlaps,
    overlaps.map(() => 1),
    `every one of ${ITERATIONS} 8-waiter pile-up iterations against a pre-existing stale lock must show max overlap 1, got: ${JSON.stringify(overlaps)}`
  );
  console.log(`thundering-herd test: ${ITERATIONS}/${ITERATIONS} iterations of 8 waiters vs. one stale lock each showed max overlap 1`);
}

// --- MUTATION (GL-009): revert the race-safe rename-steal to the old stat-then-rm steal, -----
// --- rerun a handful of herd iterations, capture the real RED (overlap > 1). -----------------
{
  const exporterPath = EXPORTER_CLI;
  const original = await fs.readFile(exporterPath, "utf8");
  // Replace the ENTIRE steal block (coordination lock + rename) with the naive round-1 shape
  // Reviewer measured as buggy: an unconditional rm, no coordination, no rename-based single-
  // winner protection at all. Sliced by stable start/end anchors rather than a large literal
  // needle, so reformatting the block's comments doesn't silently disarm this mutation.
  const stealStart = original.indexOf("        const stealCoordDir = ");
  const tailAnchor = "      // Shared tail for every non-acquiring path above: respect the deadline, then sleep once.";
  const stealEnd = original.indexOf(tailAnchor);
  assert.ok(stealStart > -1 && stealEnd > stealStart, "the steal block and the shared-tail anchor must both be present before mutating (fixture drift guard)");
  const oldStyleSteal = `        await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});\n      }\n`;
  const mutated = original.slice(0, stealStart) + oldStyleSteal + original.slice(stealEnd);
  assert.notEqual(mutated, original, "the mutation must actually change the source");
  await fs.writeFile(exporterPath, mutated, "utf8");
  let overlaps = [];
  try {
    const ITERATIONS = 12;
    for (let i = 0; i < ITERATIONS; i++) {
      const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
      const markDir = path.join(root, "marks");
      await fs.mkdir(markDir, { recursive: true });
      try {
        overlaps.push(await runHerdIteration({ vaultRoot, projectsRoot, piRoot, bbRoot, markDir }));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.writeFile(exporterPath, original, "utf8");
  }
  const worstOverlap = Math.max(...overlaps);
  assert.ok(
    worstOverlap > 1,
    `MUTATION CHECK: reverting the race-safe rename-steal to unconditional stat-then-rm must reproduce overlap > 1 in at least one of 12 iterations (Reviewer round 1 measured 5/12) -- got: ${JSON.stringify(overlaps)}`
  );
  console.log(`MUTATION (race-safe steal reverted to stat-then-rm): overlaps observed = ${JSON.stringify(overlaps)}, worst = ${worstOverlap} (>1 confirms the race-safe rename was load-bearing). Reverted.`);
}

// --- Hot-spin regression (Important 2): a stale lock the process cannot remove must not -----
// --- spin forever; the run must exit (busy) within its own wait limit -----------------------
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, lockFile } = outPaths(vaultRoot);
  const outDir = path.dirname(outFile);
  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(lockFile);
    const old = new Date(Date.now() - 5000);
    await fs.utimes(lockFile, old, old);
    await fs.chmod(outDir, 0o555); // read+execute only: rename/rm of entries inside must fail EACCES
    const lockWaitMs = 500;
    try {
      const result = await runExporter({
        vaultRoot,
        projectsRoot,
        piRoot,
        bbRoot,
        env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: "20", USAGE_EXPORT_TEST_LOCK_WAIT_MS: String(lockWaitMs) },
        killAfterMs: 8000,
      });
      assert.equal(result.timedOut, false, `the run must exit on its own, not require the watchdog kill: ${JSON.stringify(result)}`);
      assert.ok(
        result.elapsedMs < lockWaitMs + 2000,
        `an unremovable stale lock must still respect the deadline (lockWaitMs=${lockWaitMs}); took ${result.elapsedMs}ms`
      );
      assert.equal(result.code, 0, `an unremovable stale lock is the same as "busy" from the caller's perspective, must exit 0: ${JSON.stringify(result)}`);
      assert.match(result.stdout, /usage export busy/, "must report busy, the same as any other contended lock");
      console.log(`hot-spin test: unremovable stale lock (read-only parent) exited cleanly in ${result.elapsedMs}ms (limit ${lockWaitMs}ms + margin), no watchdog kill needed`);
    } finally {
      await fs.chmod(outDir, 0o755);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- MUTATION (GL-009): reintroduce the old code's un-gated `continue` (no deadline check) on
// --- a stale lock that cannot be removed, capture the real RED (process must be SIGKILLed). --
{
  const exporterPath = EXPORTER_CLI;
  const original = await fs.readFile(exporterPath, "utf8");
  const needle = `      // Shared tail for every non-acquiring path above: respect the deadline, then sleep once.\n      if (Date.now() >= deadline) {`;
  assert.ok(original.includes(needle), "the shared deadline/sleep tail must be present verbatim before mutating it (fixture drift guard)");
  // Insert an unconditional `continue` immediately after the steal-attempt block, BEFORE the
  // shared deadline check -- exactly the old (pre-round-2) bug shape: any path that reaches
  // here loops straight back to the top with no sleep and no deadline check.
  const mutated = original.replace(needle, `      continue; // MUTATION: old un-gated continue, skips deadline/sleep entirely\n${needle}`);
  assert.notEqual(mutated, original, "the mutation must actually change the source");
  await fs.writeFile(exporterPath, mutated, "utf8");
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, lockFile } = outPaths(vaultRoot);
  const outDir = path.dirname(outFile);
  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(lockFile);
    const old = new Date(Date.now() - 5000);
    await fs.utimes(lockFile, old, old);
    await fs.chmod(outDir, 0o555);
    try {
      const result = await runExporter({
        vaultRoot,
        projectsRoot,
        piRoot,
        bbRoot,
        env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: "20", USAGE_EXPORT_TEST_LOCK_WAIT_MS: "500" },
        killAfterMs: 8000,
      });
      assert.equal(
        result.timedOut,
        true,
        `MUTATION CHECK: the old un-gated continue must reproduce the hot spin -- the process must need the watchdog SIGKILL, not exit on its own. Got: ${JSON.stringify(result)}`
      );
      console.log(`MUTATION (un-gated continue reintroduced): process spun and required SIGKILL after ${result.elapsedMs}ms (watchdog limit 8000ms), confirming the shared deadline/sleep tail is load-bearing. Reverted.`);
    } finally {
      await fs.chmod(outDir, 0o755);
    }
  } finally {
    await fs.writeFile(exporterPath, original, "utf8");
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log("exportUsageAtomicWrite: all assertions passed");
