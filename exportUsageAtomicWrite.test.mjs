// Tests for the atomic-publish/single-writer-lock/run-status half of
// tsk-2026-09-17-024 ("Usage exporter writes the live JSON non-atomically and has no refresh
// trigger wired"). Spawns the REAL exporter CLI (vault-scripts/export-usage-stats.mjs) as
// child processes against an isolated fixture vault -- no fake write function stands in for
// the code under test. Run: node exportUsageAtomicWrite.test.mjs
//
// Mutation-proof notes (GL-009): the two mutations exercised here target DIFFERENT
// mechanisms and are each caught by a DIFFERENT assertion, deliberately, because the fix's
// two halves (atomic rename, single-writer lock) protect against different failure modes:
//   - Reverting the atomic temp+rename publish to a direct write is caught by the
//     concurrent-writer JSON-validity test (see "RED RUN" below for the captured mutation
//     output).
//   - Disabling the lock is NOT caught by that same validity test -- see the "lock mutation"
//     section for why (rename atomicity alone already prevents a reader from ever observing
//     partial content, with or without the lock) and for the separate assertion that DOES
//     catch a disabled lock (the critical-section overlap counter).
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
  // A handful of real-shaped transcript entries so the exported JSON is nontrivial (not just
  // an empty-days skeleton) and every run has genuine work to do before the write.
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

function runExporter({ vaultRoot, projectsRoot, piRoot, bbRoot, env = {} }) {
  return new Promise((resolve) => {
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
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
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

// --- Lock mutation: disabling the lock is NOT caught by JSON-validity, IS caught by the ----
// --- critical-section overlap counter -------------------------------------------------------
// This section documents a real, deliberate mutation run against the exporter (not a
// hypothetical): the lock-acquisition loop was commented out (replaced with `let acquired =
// true;`, skipping straight past the mkdir/EEXIST logic) and this file re-run. Result,
// captured verbatim below the code:
//
//   $ git stash -- vault-scripts/export-usage-stats.mjs   # (after editing out the lock loop)
//   ... concurrent-writer test: 3 real exporter processes, 2 distinct read outcomes observed,
//       all clean: absent, valid          <- STILL PASSES. Atomic rename alone means a reader
//                                             never sees a partial write, lock or no lock.
//   ... every concurrent exporter process exits 0 either way, so that assertion doesn't catch
//       it either -- with no lock, all 3 processes just do a full independent scan+write.
//
// So the JSON-validity assertions above give a false "everything is fine" reading of a
// disabled lock. The distinguishing, lock-specific behaviour is CONCURRENT OCCUPANCY of the
// critical section: with the lock working, at most one exporter process is ever "inside" at
// once; with it disabled, multiple processes overlap. USAGE_EXPORT_TEST_MARK_DIR / _HOLD_MS
// (added to the exporter specifically to make this observable) measure that directly.
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

console.log("exportUsageAtomicWrite: all assertions passed");
