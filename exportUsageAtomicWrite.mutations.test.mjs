import "./testFileTimeout.mjs";
// Opt-in mutation-proof suite for the exporter fixes in exportUsageAtomicWrite.test.mjs.
// NOT part of `npm test` -- run explicitly with `npm run test:mutations`.
//
// Why this is separate (Reviewer round 3, R3-I1 and R3-I2, fixed round 4):
//   - R3-I1: every mutation below used to `fs.writeFile` a mutated copy directly over the
//     TRACKED vault-scripts/export-usage-stats.mjs, restoring the original only in a `finally`.
//     A SIGINT, a session-limit kill, or any non-graceful exit skips the restore and leaves
//     production source broken on disk (measured: the pre-publish ownership check silently
//     deleted). Every mutation here now runs against a copy written into a FRESH TEMP FILE
//     (exportUsageAtomicWriteHelpers.mjs's makeMutatedExporterCopy) -- the tracked file is only
//     ever read, never written, anywhere in this repo's test suite.
//   - R3-I2: the thundering-herd "the old bug still reproduces" check is genuinely
//     probabilistic under this harness (Reviewer measured 2 of 12 and 1 of 12 iterations over
//     the threshold in its two PASSING runs, and 0 of 12 in its three FAILING runs, out of a
//     5x `npm test` loop) -- not a regression gate, a one-time proof that the removed
//     protection used to be reachable at all. It does not belong in a suite that must be
//     deterministic and green every time. It lives here, run manually, its result reported
//     honestly (including when it is 0/12 -- see the block below for what that means).
//
// Every block here: builds (or reuses) a fixture, mutates a TEMP COPY of the tracked exporter,
// reruns the exact same scenario the positive test in exportUsageAtomicWrite.test.mjs uses,
// and asserts the mutation's specific, real, captured RED. Run: node
// exportUsageAtomicWrite.mutations.test.mjs (or `npm run test:mutations`).
import assert from "node:assert";
import { promises as fs, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  makeFixtureRoot,
  outPaths,
  runExporter,
  makeMutatedExporterCopy,
  runSlowHolderScenario,
  runWidenedGapScenario,
  runReleaseOwnershipScenario,
  runHerdIteration,
} from "./exportUsageAtomicWriteHelpers.mjs";

// --- MUTATION (GL-009, M4): re-swallow the owner-token write failure (round-1 behaviour: bare
// --- `.catch(() => {})`), rerun the exact same scenario, capture the real RED. -----------------
{
  const needle = `      try {\n        // Test-only failure injection, inert unless set (same pattern as\n        // USAGE_EXPORT_TEST_FORCE_FAIL): every real cause of this write failing (disk full,\n        // EACCES on a misconfigured Operations/usage dir) is awkward to reproduce\n        // deterministically from outside a real filesystem race, so a test can force it here\n        // to exercise the catch below with a real thrown error.\n        if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL")) {\n          throw new Error(\`synthetic owner-token write failure requested via USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL=\${process.env.USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL}\`);\n        }\n        await fs.writeFile(ownerFilePath(lockFile), JSON.stringify(ownerToken));\n      } catch (ownerWriteError) {\n        await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});\n        throw new Error(\`usage export: failed to write lock owner token: \${ownerWriteError?.message || ownerWriteError}\`, { cause: ownerWriteError });\n      }`;
  const swallowed = `      try {\n        if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL")) {\n          throw new Error(\`synthetic owner-token write failure requested via USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL=\${process.env.USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL}\`);\n        }\n        await fs.writeFile(ownerFilePath(lockFile), JSON.stringify(ownerToken));\n      } catch { /* round-1 behaviour: swallowed */ }`;
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "the owner-token write failure-handling block must be present verbatim before mutating it (fixture drift guard)");
    return original.replace(needle, swallowed);
  });
  assert.ok(changed, "the mutation must actually change the source");
  try {
    const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
    let observed;
    try {
      await fs.mkdir(vaultRoot + "/Operations/usage", { recursive: true });
      const result = await runExporter({
        vaultRoot,
        projectsRoot,
        piRoot,
        bbRoot,
        exporterCli,
        env: { USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL: "1", USAGE_EXPORT_TEST_LOCK_STALE_MS: "50000" },
      });
      observed = { code: result.code, stdout: result.stdout, stderr: result.stderr };
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    // With the write swallowed, ownerToken is still set locally but owner.json was never
    // actually written to disk -- so the LATER pre-publish isCurrentOwner recheck reads no
    // owner file at all, always disagrees with the in-memory token, and the run still fails,
    // but now with the WRONG, misleading cause: exactly the M4 defect Dispatch described
    // ("later reported as stolen" instead of surfacing the write failure itself).
    assert.match(
      observed.stderr,
      /stolen|lock lost mid-run/,
      `MUTATION CHECK: with the owner-token write failure re-swallowed, the run must be WRONGLY misreported as a stolen/lost lock instead of naming the real write failure, proving the loud failure (not something else) was what surfaced the correct cause -- got exit ${observed.code}, stderr: ${JSON.stringify(observed.stderr)}`
    );
    assert.doesNotMatch(observed.stderr, /failed to write lock owner token/, `with the write swallowed, the real cause must no longer be visible in the error at all -- got: ${JSON.stringify(observed.stderr)}`);
    console.log("MUTATION (owner-token write failure re-swallowed): the run's real cause vanished and it was misreported as a stolen lock instead -- confirms the loud failure is load-bearing.");
  } finally {
    await cleanup();
  }
}

// --- MUTATION (GL-009, M1a): disable the pre-publish ownership recheck, rerun the exact same
// --- slow-holder scenario, capture the real RED. ---------------------------------------------
{
  const needle = `  if (!(await isCurrentOwner(lockFile, ownerToken))) {\n    const lost = new Error("usage export: lock lost mid-run (stolen after exceeding the stale threshold); refusing to publish over a possibly newer snapshot");\n    lost.code = "USAGE_EXPORT_LOCK_LOST";\n    throw lost;\n  }\n`;
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "the ownership-recheck block must be present verbatim before mutating it (fixture drift guard)");
    return original.replace(needle, "");
  });
  assert.ok(changed, "the mutation must actually change the source");
  try {
    const { aResult, bResult, root } = await runSlowHolderScenario({ exporterCli });
    const observed = { aCode: aResult.code, aStderr: aResult.stderr, bCode: bResult.code };
    await fs.rm(root, { recursive: true, force: true });
    assert.equal(observed.bCode, 0, "B still succeeds regardless (sanity check on the mutated run)");
    assert.equal(
      observed.aCode,
      0,
      `MUTATION CHECK: with the ownership recheck removed, the slow holder A must now WRONGLY succeed and publish over B's snapshot (exit 0), proving the recheck (not something else) was what stopped this -- got exit ${observed.aCode}, stderr: ${observed.aStderr}`
    );
    console.log("MUTATION (ownership recheck removed): A wrongly succeeded and would have overwritten B's newer snapshot -- confirms the recheck is load-bearing.");
  } finally {
    await cleanup();
  }
}

// --- MUTATION (GL-009, M1b): disable the pre-rename ownership recheck (beforeRename) that
// --- closes the widened-gap race, rerun the exact same scenario, capture the real RED. --------
{
  const needle = `    if (beforeRename && !(await beforeRename())) {\n      await fs.rm(tempFile, { force: true }).catch(() => {});\n      return { skipped: true };\n    }\n`;
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "the pre-rename beforeRename check must be present verbatim before mutating it (fixture drift guard)");
    return original.replace(needle, "");
  });
  assert.ok(changed, "the mutation must actually change the source");
  try {
    const { statusFile, root } = await runWidenedGapScenario({ exporterCli });
    const observed = { status: JSON.parse(await fs.readFile(statusFile, "utf8")) };
    await fs.rm(root, { recursive: true, force: true });
    assert.equal(
      observed.status.lastSuccessAt,
      null,
      `MUTATION CHECK: with the pre-rename ownership recheck removed, A's slow, stale, now-unauthorized write must WRONGLY land after B's and erase B's real success (lastSuccessAt back to null), proving the recheck (not something else) was what stopped this -- got: ${JSON.stringify(observed.status)}`
    );
    console.log(`MUTATION (pre-rename ownership recheck removed): B's genuine success was wrongly erased back to lastSuccessAt=null by A's later write -- confirms the recheck is load-bearing.`);
  } finally {
    await cleanup();
  }
}

// --- MUTATION (GL-009, M2): remove the ownership check on release (round-1 behaviour:
// --- unconditional rm), rerun the exact same scenario, capture the real RED. ------------------
{
  const needle = "    if (ownerToken && (await isCurrentOwner(lockFile, ownerToken))) {\n      await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});\n    }";
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "the release ownership-check block must be present verbatim before mutating it (fixture drift guard)");
    return original.replace(needle, "    await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});");
  });
  assert.ok(changed, "the mutation must actually change the source");
  try {
    const { cResult, bLockPresentAfterAExit, root } = await runReleaseOwnershipScenario({ exporterCli });
    const observed = { cStdout: cResult.stdout, bLockPresentAfterAExit };
    await fs.rm(root, { recursive: true, force: true });
    assert.equal(
      observed.bLockPresentAfterAExit,
      false,
      `MUTATION CHECK: with the release ownership check removed, A's unconditional rm must WRONGLY delete B's still-live lock, proving the check (not something else) was what stopped this -- got present=${observed.bLockPresentAfterAExit}`
    );
    assert.doesNotMatch(
      observed.cStdout,
      /usage export busy/,
      `MUTATION CHECK: with B's lock wrongly deleted, C must no longer be told busy (it should find the path clear and acquire) -- got: ${JSON.stringify(observed.cStdout)}`
    );
    console.log("MUTATION (release ownership check removed): A's unconditional rm deleted B's still-live lock and C no longer saw busy -- confirms the check is load-bearing.");
  } finally {
    await cleanup();
  }
}

// --- MUTATION (GL-009, R3-I2): revert the race-safe rename-steal to the old stat-then-rm
// --- steal, rerun a handful of herd iterations, report whether overlap > 1 reproduced. --------
// R3-I2: this check is PROBABILISTIC under this harness -- Reviewer's own 5x loop saw the old
// bug reproduce (overlap > 1) in only 2 of 5 runs, at rates of 2/12 and 1/12 iterations; the
// other 3 runs saw 0/12. That is why this is NOT a regression gate in npm test: a positive
// "worst > 1" result here is confirmation the removed protection was reachable at all under
// this specific harness's timing, not a promise that every run of this script will show it.
// The POSITIVE test (12/12 iterations must show overlap 1 on the real, unmutated code) is the
// actual regression gate, and it lives in exportUsageAtomicWrite.test.mjs, in npm test, where
// it belongs and has passed every measured run.
{
  const stealStart = (await fs.readFile(new URL("./vault-scripts/export-usage-stats.mjs", import.meta.url), "utf8")).indexOf("        const stealCoordDir = ");
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    // Replace the ENTIRE steal block (coordination lock + rename) with the naive round-1 shape
    // Reviewer measured as buggy: an unconditional rm, no coordination, no rename-based
    // single-winner protection at all. Sliced by stable start/end anchors rather than a large
    // literal needle, so reformatting the block's comments doesn't silently disarm this
    // mutation.
    const start = original.indexOf("        const stealCoordDir = ");
    const tailAnchor = "      // Shared tail for every non-acquiring path above: respect the deadline, then sleep once.";
    const end = original.indexOf(tailAnchor);
    assert.ok(start > -1 && end > start, "the steal block and the shared-tail anchor must both be present before mutating (fixture drift guard)");
    const oldStyleSteal = `        await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});\n      }\n`;
    return original.slice(0, start) + oldStyleSteal + original.slice(end);
  });
  assert.ok(changed, "the mutation must actually change the source");
  assert.ok(stealStart > -1, "sanity check on the steal-block anchor (fixture drift guard)");
  try {
    let overlaps = [];
    const ITERATIONS = 12;
    for (let i = 0; i < ITERATIONS; i++) {
      const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
      const markDir = `${root}/marks`;
      await fs.mkdir(markDir, { recursive: true });
      try {
        overlaps.push(await runHerdIteration({ vaultRoot, projectsRoot, piRoot, bbRoot, markDir, exporterCli }));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
    const worstOverlap = Math.max(...overlaps);
    const reproduced = worstOverlap > 1;
    console.log(
      `MUTATION (race-safe steal reverted to stat-then-rm, R3-I2 PROBABILISTIC): overlaps observed = ${JSON.stringify(overlaps)}, worst = ${worstOverlap}. ` +
        (reproduced
          ? "Bug REPRODUCED this run (>1 confirms the race-safe rename is load-bearing when it is caught)."
          : "Bug did NOT reproduce this run -- expected some fraction of the time under this harness (Reviewer measured 3 of 5 runs at 0/12); this is informational, not a failure.")
    );
  } finally {
    await cleanup();
  }
}

// --- MUTATION (GL-009, Important 2): reintroduce the old code's un-gated `continue` (no
// --- deadline check) on a stale lock that cannot be removed, capture the real RED (process
// --- must be SIGKILLed). ------------------------------------------------------------------
{
  const needle = `      // Shared tail for every non-acquiring path above: respect the deadline, then sleep once.\n      if (Date.now() >= deadline) {`;
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "the shared deadline/sleep tail must be present verbatim before mutating it (fixture drift guard)");
    // Insert an unconditional `continue` immediately after the steal-attempt block, BEFORE the
    // shared deadline check -- exactly the old (pre-round-2) bug shape: any path that reaches
    // here loops straight back to the top with no sleep and no deadline check.
    return original.replace(needle, `      continue; // MUTATION: old un-gated continue, skips deadline/sleep entirely\n${needle}`);
  });
  assert.ok(changed, "the mutation must actually change the source");
  try {
    const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
    const { outFile, lockFile } = outPaths(vaultRoot);
    const outDir = vaultRoot + "/Operations/usage";
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
          exporterCli,
          env: { USAGE_EXPORT_TEST_LOCK_STALE_MS: "20", USAGE_EXPORT_TEST_LOCK_WAIT_MS: "500" },
          killAfterMs: 8000,
        });
        assert.equal(
          result.timedOut,
          true,
          `MUTATION CHECK: the old un-gated continue must reproduce the hot spin -- the process must need the watchdog SIGKILL, not exit on its own. Got: ${JSON.stringify(result)}`
        );
        console.log(`MUTATION (un-gated continue reintroduced): process spun and required SIGKILL after ${result.elapsedMs}ms (watchdog limit 8000ms), confirming the shared deadline/sleep tail is load-bearing.`);
      } finally {
        await fs.chmod(outDir, 0o755);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
  }
}

// --- MUTATION (Round 3, Reviewer Minor N1): remove the SIGTERM/SIGINT handler registration.
// --- A real SIGTERM mid-run must WRONGLY orphan the lock (Node's default signal action ends
// --- the process immediately, skipping main()'s own owner-checked release). --------------------
{
  const needle =
    '  process.on("SIGTERM", () => { void releaseOwnedLockAndExit(); });\n  process.on("SIGINT", () => { void releaseOwnedLockAndExit(); });\n';
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "the SIGTERM/SIGINT handler registration must be present verbatim before mutating it (fixture drift guard)");
    return original.replace(needle, "");
  });
  assert.ok(changed, "the mutation must actually change the source");
  try {
    const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
    const { lockFile } = outPaths(vaultRoot);
    try {
      const child = spawn(
        process.execPath,
        [exporterCli, vaultRoot],
        {
          env: {
            ...process.env,
            USAGE_EXPORT_TEST_PROJECTS_ROOT: projectsRoot,
            USAGE_EXPORT_TEST_PI_ROOT: piRoot,
            USAGE_EXPORT_TEST_BB_ROOT: bbRoot,
            USAGE_EXPORT_TEST_HOLD_MS: "5000",
            USAGE_EXPORT_TEST_LOCK_STALE_MS: "60000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 5000;
      let sawLock = false;
      while (Date.now() < deadline) {
        if (existsSync(lockFile)) { sawLock = true; break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(sawLock, "sanity: the mutated child must still acquire and hold the lock before this test signals it");
      child.kill("SIGTERM");
      const { code, signal } = await exitPromise;
      assert.equal(
        existsSync(lockFile),
        true,
        `MUTATION CHECK: with the signal handler removed, a real SIGTERM mid-run must WRONGLY leave the lock dir behind (Node's default SIGTERM action skips main()'s own finally) -- got code=${code} signal=${signal}, lock existsSync=${existsSync(lockFile)}`
      );
      console.log(`N1 MUTATION (signal handler removed): SIGTERM WRONGLY orphaned the lock (still present at ${lockFile}, exit code=${code} signal=${signal}). Reverted (never touched the tracked file).`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
  }
}

// --- MUTATION (N6): remove the signal handler's owner check. The old holder A is stolen by B,
// then receives SIGTERM. An unconditional release must wrongly delete B's live replacement.
{
  const needle = "    if (currentHeldLock && (await isCurrentOwner(currentHeldLock.lockFile, currentHeldLock.ownerToken))) {\n      await fs.rm(currentHeldLock.lockFile, { recursive: true, force: true }).catch(() => {});\n    }";
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((original) => {
    assert.ok(original.includes(needle), "N6 mutation anchor: signal-release owner check must be present in executable code");
    return original.replace(needle, "    if (currentHeldLock) {\n      await fs.rm(currentHeldLock.lockFile, { recursive: true, force: true }).catch(() => {});\n    }");
  });
  assert.ok(changed, "N6 mutation must change the executable signal-release guard");
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { lockFile } = outPaths(vaultRoot);
  const spawnHolder = (env) => spawn(process.execPath, [exporterCli, vaultRoot], {
    env: { ...process.env, AIOS_USAGE_EXPORT_TEST_MODE: "1", USAGE_EXPORT_TEST_PROJECTS_ROOT: projectsRoot, USAGE_EXPORT_TEST_PI_ROOT: piRoot, USAGE_EXPORT_TEST_BB_ROOT: bbRoot, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const children = new Set();
  const spawnTracked = (env) => { const child = spawnHolder(env); children.add(child); child.once("exit", () => children.delete(child)); return child; };
  const cleanupChildren = async () => { const pending = [...children]; for (const child of pending) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await Promise.all(pending.map((child) => new Promise((resolve) => child.once("exit", resolve)))); assert.equal(children.size, 0, "N6 mutation cleanup: no child exporter descendants may survive an assertion failure"); };
  try {
    const a = spawnTracked({ USAGE_EXPORT_TEST_HOLD_MS: "5000", USAGE_EXPORT_TEST_LOCK_STALE_MS: "80" });
    const aExit = new Promise((resolve) => a.once("exit", (code, signal) => resolve({ code, signal })));
    let aOwner = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !aOwner) { try { aOwner = JSON.parse(await fs.readFile(`${lockFile}/owner.json`, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
    assert.ok(aOwner, "N6 mutation sanity: A acquired its lock");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const b = spawnTracked({ USAGE_EXPORT_TEST_HOLD_MS: "5000", USAGE_EXPORT_TEST_LOCK_STALE_MS: "80", USAGE_EXPORT_TEST_LOCK_WAIT_MS: "3000" });
    const bExit = new Promise((resolve) => b.once("exit", (code, signal) => resolve({ code, signal })));
    let bOwner = null;
    while (Date.now() < deadline && !bOwner) { try { const candidate = JSON.parse(await fs.readFile(`${lockFile}/owner.json`, "utf8")); if (candidate.nonce !== aOwner.nonce) bOwner = candidate; } catch {} if (!bOwner) await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.ok(bOwner, "N6 mutation sanity: B stole A's stale lock");
    a.kill("SIGTERM");
    await aExit;
    assert.equal(existsSync(lockFile), false, "MUTATION CHECK N6: without the signal owner check, SIGTERM on A must WRONGLY delete B's live lock");
    console.log("N6 MUTATION (signal owner check removed): old A's SIGTERM WRONGLY deleted B's live lock.");
    b.kill("SIGTERM");
    await bExit;
  } finally {
    await cleanupChildren();
    await fs.rm(root, { recursive: true, force: true });
    await cleanup();
  }
}


// --- N6 failure-path proof: force an assertion after both real children exist. The child
// process must fail at that exact assertion, but its N6 finally writes both PIDs only after
// awaiting their exits. The parent then proves neither descendant remains alive. -------------
{
  const marker = path.join("/tmp", `aios-n6-cleanup-${process.pid}-${Date.now()}.json`);
  try {
    const child = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "exportUsageAtomicWrite.test.mjs")], { env: { ...process.env, AIOS_N6_FORCE_ASSERTION: "1", AIOS_N6_CLEANUP_MARKER: marker }, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; c.stderr.on("data", d => stderr += d); c.once("exit", code => resolve({ code, stderr }));
    });
    assert.notEqual(child.code, 0, `N6 forced assertion subprocess must fail, got ${JSON.stringify(child)}`);
    assert.match(child.stderr, /N6 forced assertion: verify finally kills A and B/, `N6 failure path must fail at its named assertion, got ${JSON.stringify(child)}`);
    const cleanup = JSON.parse(await fs.readFile(marker, "utf8"));
    assert.equal(cleanup.remaining, 0, `N6 cleanup marker must report no tracked children, got ${JSON.stringify(cleanup)}`);
    for (const pid of cleanup.pids) {
      let alive = true; try { process.kill(pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
      assert.equal(alive, false, `N6 failure cleanup: descendant pid ${pid} must not survive the forced assertion`);
    }
    console.log(`N6 forced-assertion cleanup: subprocess failed at named assertion and no descendants survived (${cleanup.pids.join(",")}).`);
  } finally { await fs.rm(marker, { force: true }); }
}

// --- MUTATION (M8): remove the injected pre-rename failure branch. The same forced fixture
// must then wrongly rename over the named prior snapshot, proving the preservation assertion
// depends on the executable branch rather than a generic exporter failure. -------------------
{
  const needle = '    if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_SNAPSHOT_PUBLISH_FAIL") && path.basename(filePath) === "usage-stats.json") {';
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((source) => {
    assert.ok(source.includes(needle), "M8 mutation anchor must be the executable pre-rename injected-failure gate");
    // Keep the named injected failure active, but publish first. This recreates exactly the
    // broken preservation path: the command still fails with the same cause after replacing
    // the live snapshot.
    return source.replace(needle, '    if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_SNAPSHOT_PUBLISH_FAIL") && path.basename(filePath) === "usage-stats.json") { await fs.rename(tempFile, filePath);');
  });
  assert.ok(changed, "M8 mutation must change executable source");
  const { root, vaultRoot, projectsRoot, piRoot, bbRoot } = await makeFixtureRoot();
  const { outFile } = outPaths(vaultRoot);
  try {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify({ marker: "prior-good-snapshot", days: [], projects: [] }) + "\n");
    const result = await runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot, exporterCli, env: { USAGE_EXPORT_TEST_FORCE_SNAPSHOT_PUBLISH_FAIL: "1" } });
    assert.equal(result.code, 1, `M8 mutation sanity: the injected publish failure must still exit non-zero, got ${JSON.stringify(result)}`);
    assert.match(result.stderr, /synthetic snapshot publish failure requested/, `M8 mutation sanity: failure must retain its named injected cause, got ${JSON.stringify(result)}`);
    assert.notEqual(JSON.parse(await fs.readFile(outFile, "utf8")).marker, "prior-good-snapshot", "MUTATION CHECK M8: failure after premature rename must WRONGLY replace the named prior snapshot");
    console.log("M8 MUTATION (failure moved after rename): failing export WRONGLY replaced prior usage-stats.json.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await cleanup();
  }
}


// --- MUTATION (R2-M5): remove the explicit production test-setting gate. ---------------------
{
  const needle = 'const usageTestEnv = (name) => process.env.AIOS_USAGE_EXPORT_TEST_MODE === "1" ? process.env[name] : undefined;';
  const { exporterCli, changed, cleanup } = await makeMutatedExporterCopy((source) => {
    assert.ok(source.includes(needle), "R2-M5 mutation anchor must be the executable usage test-setting gate");
    return source.replace(needle, 'const usageTestEnv = (name) => process.env[name];');
  });
  assert.ok(changed, "R2-M5 mutation must change the executable production gate");
  const { root, vaultRoot } = await makeFixtureRoot();
  try {
    const child = await new Promise((resolve) => {
      const c = spawn(process.execPath, [exporterCli, vaultRoot], { env: { ...process.env, HOME: path.join(root, "synthetic-production-home"), USAGE_EXPORT_TEST_FORCE_FAIL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; c.stderr.on("data", (chunk) => stderr += chunk); c.once("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(child.code, 1, `MUTATION CHECK R2-M5: without the explicit gate, a production child must WRONGLY honor USAGE_EXPORT_TEST_FORCE_FAIL, got ${JSON.stringify(child)}`);
    assert.match(child.stderr, /synthetic test failure requested/, `MUTATION CHECK R2-M5: failure must specifically prove the inherited test setting was honored, got ${JSON.stringify(child)}`);
    console.log("R2-M5 MUTATION (production test-setting gate removed): production child WRONGLY honored USAGE_EXPORT_TEST_FORCE_FAIL.");
  } finally { await fs.rm(root, { recursive: true, force: true }); await cleanup(); }
}

console.log("exportUsageAtomicWrite.mutations: all mutation checks ran (see above for the probabilistic R3-I2 result)");
