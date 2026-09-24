import "./testFileTimeout.mjs";
// Tests for the atomic-publish/single-writer-lock/run-status half of
// tsk-2026-09-17-024 ("Usage exporter writes the live JSON non-atomically and has no refresh
// trigger wired"). Spawns the REAL exporter CLI (vault-scripts/export-usage-stats.mjs) as
// child processes against an isolated fixture vault -- no fake write function stands in for
// the code under test. Run: node exportUsageAtomicWrite.test.mjs (or `npm test`, part of the
// default suite).
//
// R3-I1/R3-I2 (Reviewer round 3, round 4 fix): this file used to ALSO contain six "MUTATION"
// blocks that overwrote the TRACKED vault-scripts/export-usage-stats.mjs with a mutated copy in
// place, guarded only by a `finally` to restore it -- a SIGINT, a session-limit kill, or any
// non-graceful exit skipped the restore and left production source broken on disk (measured:
// the pre-publish ownership check silently deleted). One of those six (the thundering-herd
// "the bug still reproduces" check) was also probabilistic and failed 3 of 5 `npm test` runs
// for no code reason, and because `npm test` is `&&`-chained, a red run there silently skipped
// every later test file too.
//
// Both defects are fixed the same way: every mutation proof now lives in
// exportUsageAtomicWrite.mutations.test.mjs (run with `npm run test:mutations`, NOT part of
// `npm test`), and every one of them mutates a copy written into a FRESH TEMP FILE
// (exportUsageAtomicWriteHelpers.mjs's makeMutatedExporterCopy) -- the tracked exporter is only
// ever read, never written, by any test file in this repo. This file keeps every POSITIVE
// regression test (the real fix, exercised against the real tracked exporter, with no mutation
// involved) in the default suite, deterministic, and green.
//
// Mutation-proof notes (GL-009): the mutation proofs for each fix below live in
// exportUsageAtomicWrite.mutations.test.mjs now. Run `npm run test:mutations` to see each one's
// real captured RED. This file only asserts the POSITIVE (fix-in-place) behavior.
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  makeFixtureRoot,
  outPaths,
  runExporter,
  pollWhile,
  runSlowHolderScenario,
  runWidenedGapScenario,
  runReleaseOwnershipScenario,
  runHerdIteration,
  TRACKED_EXPORTER_CLI,
} from "./exportUsageAtomicWriteHelpers.mjs";

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
    // M3 (Reviewer round 2): THIS is the one genuine "a live writer holds it" case -- a fresh
    // lock, never stale, never stolen. The message must actually say that (not a generic
    // catch-all), distinguishing it from the stale-but-unremovable-lock case below.
    assert.match(result.stdout, /a live writer holds the lock/, `a genuinely live (non-stale) lock must produce the honest "live writer" reason, not a generic busy message: ${JSON.stringify(result.stdout)}`);
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
// immediately below). The mutation was performed by hand against a throwaway copy (never the
// tracked file), per R3-I1.
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

// --- Owner-token write failure (Round 3, M4): a failed owner-token write must fail loudly with
// --- its real cause, not be swallowed and later misreported as a stolen lock. ------------------
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile, statusFile, lockFile } = outPaths(vaultRoot);
  try {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const result = await runExporter({
      vaultRoot,
      projectsRoot,
      piRoot,
      bbRoot,
      env: { USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL: "1" },
    });
    assert.notEqual(result.code, 0, `a run whose owner-token write fails must not exit 0: ${JSON.stringify(result)}`);
    assert.match(result.stderr, /failed to write lock owner token/, `the failure must name its REAL cause, not surface as a misleading "lock lost/stolen" error: ${JSON.stringify(result)}`);
    assert.doesNotMatch(result.stderr, /stolen|lock lost mid-run/, `must not be misreported as a stolen/lost lock -- that never happened here, the write itself failed: ${JSON.stringify(result)}`);
    const lockStillPresent = await fs.stat(lockFile).then(() => true).catch(() => false);
    assert.equal(lockStillPresent, false, "a run that fails to establish real ownership must not leave an unowned lock dir behind, blocking every future run");
    // No status write should have happened either -- this run never legitimately held the
    // lock (M1's "only the lock holder writes status" principle applies here too: a run that
    // never got a valid owner token is not a legitimate writer).
    const statusExists = await fs.stat(statusFile).then(() => true).catch(() => false);
    assert.equal(statusExists, false, "a run that never established ownership must not write the status sidecar either");
    console.log(`owner-token-write-failure test: failed loudly (stderr: "${result.stderr.trim().split("\n").pop()}"), lock dir cleaned up, no status written`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Slow-holder scenario (Important 1): a holder that outlives the stale threshold must not -
// --- publish over, or corrupt the status of, whoever legitimately took its lock. See
// --- exportUsageAtomicWriteHelpers.mjs's runSlowHolderScenario for the scenario's own comment.
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

// --- Widened-gap status race (Round 3, M1/R2-M1). See exportUsageAtomicWriteHelpers.mjs's -----
// --- runWidenedGapScenario for the scenario's own comment. ------------------------------------
{
  const { aResult, bResult, statusFile, root } = await runWidenedGapScenario();
  try {
    assert.notEqual(aResult.code, 0, `A (the slow, losing holder) must not exit 0: ${JSON.stringify(aResult)}`);
    assert.equal(bResult.code, 0, `B (the stealer) must succeed for real, not just be reported busy: ${JSON.stringify(bResult)}`);
    assert.match(bResult.stdout, /usage-stats: \d+ transcript\(s\)/, `B's own stdout must be a genuine success banner, not a busy one-liner, or this scenario is not testing what it claims: ${JSON.stringify(bResult)}`);
    const status = JSON.parse(await fs.readFile(statusFile, "utf8"));
    assert.ok(status.lastSuccessAt, `B's genuine success must survive A's later, slower, now-stale write -- lastSuccessAt must not go backwards to null: ${JSON.stringify(status)}`);
    assert.equal(status.lastError, null, `A's stale failure must not overwrite B's clean success: ${JSON.stringify(status)}`);
    console.log(`widened-gap test: B's genuine success (lastSuccessAt=${status.lastSuccessAt}) survived A's slower, later-landing status write`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Release ownership check (Round 3, M2). See exportUsageAtomicWriteHelpers.mjs's -----------
// --- runReleaseOwnershipScenario for the scenario's own comment. ------------------------------
{
  const { aResult, bResult, cResult, bLockPresentAfterAExit, root } = await runReleaseOwnershipScenario();
  try {
    assert.notEqual(aResult.code, 0, `A (stolen, losing holder) must not exit 0: ${JSON.stringify(aResult)}`);
    assert.ok(bLockPresentAfterAExit, "B's lock must still be present immediately after A's own exit -- A must not delete a lock it no longer owns");
    assert.match(cResult.stdout, /usage export busy/, `C, arriving while B still genuinely holds the lock, must be told busy, not silently acquire: ${JSON.stringify(cResult)}`);
    assert.equal(bResult.code, 0, `B must still complete normally and successfully once its own hold ends: ${JSON.stringify(bResult)}`);
    console.log("release-ownership test: A's exit left B's stolen lock present; C correctly found it busy while B still held it");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Thundering herd (Important 1): N processes against one pre-existing stale lock must -----
// --- never show more than 1 simultaneous holder, repeated (not a one-shot pass). This is the
// --- POSITIVE regression test (the correct code, run 12 times, must show max overlap 1 every
// --- time); the probabilistic "the OLD bug still reproduces at least once" check that used to
// --- sit here moved to exportUsageAtomicWrite.mutations.test.mjs (R3-I2: it failed 3 of 5
// --- npm test runs for no code reason, and a red run there silently skipped every later file
// --- in the `&&`-chained npm test script).
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
      // M3 (Reviewer round 2): there is NO writer here at all (the lock is stale, its would-be
      // steal was blocked by EACCES on the read-only parent) -- the message must say that, not
      // claim "existing writer retained" as it used to unconditionally, which was flatly false
      // in exactly this situation (status and snapshot both untouched, no process holds it).
      assert.match(result.stdout, /stale lock exists but could not be (removed|recovered)/, `a stale-but-unremovable lock must name the REAL cause, not claim a live writer exists: ${JSON.stringify(result.stdout)}`);
      assert.doesNotMatch(result.stdout, /existing writer retained/, `must not claim a writer exists when the real cause is a stuck stale lock: ${JSON.stringify(result.stdout)}`);
      console.log(`hot-spin test: unremovable stale lock (read-only parent) exited cleanly in ${result.elapsedMs}ms (limit ${lockWaitMs}ms + margin), no watchdog kill needed, honest cause reported`);
    } finally {
      await fs.chmod(outDir, 0o755);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- Round 3, Reviewer Minor N1: a real SIGTERM mid-run must release the lock, not orphan it. --
// Reviewer round 2, attack 2 measured: the plugin's own 60s hang timeout calls `child.kill()`
// (SIGTERM, no argument), Node's DEFAULT action for an unhandled SIGTERM ends the process
// immediately, so the exporter's own owner-checked lock release (main()'s finally) never ran --
// the next run then falsely reported "a live writer holds the lock" until the orphaned lock aged
// past LOCK_STALE_MS (~120s default, shortened here so this test does not itself take 2 minutes).
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { lockFile } = outPaths(vaultRoot);
  try {
    const child = spawn(
      process.execPath,
      [TRACKED_EXPORTER_CLI, vaultRoot],
      {
        env: {
          ...process.env,
          USAGE_EXPORT_TEST_PROJECTS_ROOT: projectsRoot,
          USAGE_EXPORT_TEST_PI_ROOT: piRoot,
          USAGE_EXPORT_TEST_BB_ROOT: bbRoot,
          // Holds the lock for a while AFTER acquiring it -- long enough that this test can
          // reliably observe the lock dir on disk and send SIGTERM well before the run would
          // finish on its own (simulating the plugin's timeout killing a genuinely hung run).
          USAGE_EXPORT_TEST_HOLD_MS: "5000",
          USAGE_EXPORT_TEST_LOCK_STALE_MS: "60000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

    // Poll for the real lock dir to appear on disk (acquired, then holding) before signalling --
    // no fixed sleep, so this is not a race against how fast the child happens to start.
    const deadline = Date.now() + 5000;
    let sawLock = false;
    while (Date.now() < deadline) {
      if (existsSync(lockFile)) { sawLock = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(sawLock, "sanity: the child must actually acquire and hold the lock before this test signals it");

    child.kill("SIGTERM");
    const { code, signal } = await exitPromise;
    // The handler calls process.exit(1) itself (not left to die by the raw signal), so `code`
    // is the deciding field, not `signal` -- a process that installs its own signal handler and
    // calls process.exit() exits with that code, not `null`/killed-by-signal.
    assert.equal(code, 1, `SIGTERM must exit non-zero (the handler's own process.exit(1)) -- got code=${code} signal=${signal}, stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    assert.equal(
      existsSync(lockFile),
      false,
      `SIGTERM mid-run must release the lock dir, not orphan it -- lock still present at ${lockFile} after exit`
    );
    console.log(`N1: real SIGTERM mid-run -> exit code ${code}, lock released (no longer present at ${lockFile})`);

    // The NEXT run must acquire the lock normally (not report busy), proving the release was
    // real and not merely absent from disk for some other reason (e.g. it was never created).
    const nextRun = await runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot });
    assert.equal(nextRun.code, 0, `the next run after a SIGTERM-released lock must succeed -- got: ${JSON.stringify(nextRun)}`);
    assert.doesNotMatch(nextRun.stdout, /usage export busy/, `the next run must acquire the lock normally, not find it still (falsely) held -- got: ${JSON.stringify(nextRun.stdout)}`);
    console.log(`N1: the next run after the SIGTERM acquired the lock normally -- "${nextRun.stdout.trim()}"`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- N6: an old holder signalled after its lock was stolen must not delete the new holder. ---
// This is deliberately a real three-process scenario: A owns the lock, B steals it after A
// exceeds the stale threshold, then SIGTERM signals A while B is still holding. The signal
// handler must use the same owner check as normal release. A generic "SIGTERM removes a lock"
// test cannot distinguish A removing its own lock from A wrongly removing B's replacement.
{
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { lockFile } = outPaths(vaultRoot);
  const spawnHolder = (env) => spawn(process.execPath, [TRACKED_EXPORTER_CLI, vaultRoot], {
    env: { ...process.env, USAGE_EXPORT_TEST_PROJECTS_ROOT: projectsRoot, USAGE_EXPORT_TEST_PI_ROOT: piRoot, USAGE_EXPORT_TEST_BB_ROOT: bbRoot, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const waitForOwnerChange = async (oldOwner) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const owner = JSON.parse(await fs.readFile(path.join(lockFile, "owner.json"), "utf8"));
        if (owner.nonce !== oldOwner.nonce) return owner;
      } catch { /* lock not acquired/replaced yet */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };
  try {
    const a = spawnHolder({ USAGE_EXPORT_TEST_HOLD_MS: "5000", USAGE_EXPORT_TEST_LOCK_STALE_MS: "80" });
    const aExit = new Promise((resolve) => a.once("exit", (code, signal) => resolve({ code, signal })));
    let aOwner = null;
    const ownerDeadline = Date.now() + 5000;
    while (Date.now() < ownerDeadline && !aOwner) {
      try { aOwner = JSON.parse(await fs.readFile(path.join(lockFile, "owner.json"), "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(aOwner, "N6 sanity: A must own the real lock before B can steal it");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const b = spawnHolder({ USAGE_EXPORT_TEST_HOLD_MS: "5000", USAGE_EXPORT_TEST_LOCK_STALE_MS: "80", USAGE_EXPORT_TEST_LOCK_WAIT_MS: "3000" });
    const bExit = new Promise((resolve) => b.once("exit", (code, signal) => resolve({ code, signal })));
    const bOwner = await waitForOwnerChange(aOwner);
    assert.ok(bOwner, "N6 sanity: B must steal A's stale lock and install a distinct owner token");
    a.kill("SIGTERM");
    const aResult = await aExit;
    assert.equal(aResult.code, 1, `N6: signalled old holder must run its handler and exit 1, got ${JSON.stringify(aResult)}`);
    const survivingOwner = JSON.parse(await fs.readFile(path.join(lockFile, "owner.json"), "utf8"));
    assert.equal(survivingOwner.nonce, bOwner.nonce, "N6: A's signal handler must not delete B's replacement lock");
    console.log("N6: steal-then-SIGTERM left B's real lock owner token intact");
    b.kill("SIGTERM");
    await bExit;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log("exportUsageAtomicWrite: all assertions passed");
