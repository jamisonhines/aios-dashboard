// tsk-2026-09-18-020: pure unit tests for resolveExporterLaunch (model.mjs), the launcher that
// replaced spawning process.execPath directly. All fs/env/homedir access is injected, so this
// needs no real filesystem -- the real-machine evidence (Obsidian's packaged binary is not
// node, ELECTRON_RUN_AS_NODE=1 does not help, a real node exists only via nvm here) lives in
// model.mjs's own header comment on resolveExporterLaunch and in the task's build log, not
// re-asserted here.
import assert from "node:assert";
import { resolveExporterLaunch } from "./model.mjs";

// 1. Already running under real node (test/CLI context, or a from-source dev host): use it as-is,
//    no fs probing at all.
{
  const result = resolveExporterLaunch({ execPath: "/some/path/bin/node", exists: () => { throw new Error("must not probe fs"); } });
  assert.deepEqual(result, { command: "/some/path/bin/node", reason: null });
}
{
  // Windows node.exe
  const result = resolveExporterLaunch({ execPath: "C:\\nodejs\\node.exe", exists: () => { throw new Error("must not probe fs"); } });
  assert.deepEqual(result, { command: "C:\\nodejs\\node.exe", reason: null });
}

// 2. Not node (Electron/Obsidian) -- falls through to fixed candidate paths.
{
  const seen = [];
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    exists: (p) => { seen.push(p); return p === "/opt/homebrew/bin/node"; },
  });
  assert.equal(result.command, "/opt/homebrew/bin/node");
  assert.equal(result.reason, null);
  assert.deepEqual(seen, ["/usr/local/bin/node", "/opt/homebrew/bin/node"], "must check candidates in order and stop at the first hit");
}

// 3. No fixed candidate -- falls through to nvm's aliased default version.
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node",
    readFile: (p) => (p === "/Users/jaymo/.nvm/alias/default" ? "24.14.1\n" : null),
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node");
  assert.equal(result.reason, null);
}
// 3b. NVM_DIR env override takes priority over homedir-derived default.
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    env: { NVM_DIR: "/custom/nvm" },
    homedir: "/Users/jaymo",
    exists: (p) => p === "/custom/nvm/versions/node/v22.0.0/bin/node",
    readFile: (p) => (p === "/custom/nvm/alias/default" ? "v22.0.0" : null),
  });
  assert.equal(result.command, "/custom/nvm/versions/node/v22.0.0/bin/node");
}

// 4. nvm alias file absent/unreadable, but a versions directory exists -- picks the highest
//    installed semver.
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v20.11.0/bin/node",
    readFile: () => null,
    listNodeVersionDirs: (dir) => (dir === "/Users/jaymo/.nvm/versions/node" ? ["v18.19.0", "v20.11.0", "v20.9.0"] : []),
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v20.11.0/bin/node", "must pick the HIGHEST installed version, not the first listed");
}

// 5. Nothing found anywhere -- a specific, non-null reason, no command.
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: () => false,
    readFile: () => null,
    listNodeVersionDirs: () => [],
  });
  assert.equal(result.command, null);
  assert.match(result.reason, /no Node\.js binary found/);
}

// 6. No homedir and no NVM_DIR -- must not throw, must fall through cleanly to the "not found"
//    outcome (an earlier draft could have thrown constructing an empty nvmDir path).
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    exists: () => false,
  });
  assert.equal(result.command, null);
  assert.ok(result.reason);
}

// Round 2, Reviewer Minor M2: the failure reason must name the paths actually checked and must
// NOT tell the user to add node to PATH (this function never reads PATH, and Obsidian's GUI
// process has no shell PATH to search anyway).
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: () => false,
    readFile: () => null,
    listNodeVersionDirs: () => [],
  });
  assert.match(result.reason, /\/usr\/local\/bin\/node/, "must name a checked fixed candidate");
  assert.match(result.reason, /\/opt\/homebrew\/bin\/node/, "must name a checked fixed candidate");
  assert.match(result.reason, /\/opt\/homebrew\/opt\/node\/bin\/node/, "must name the third checked candidate (round 1 checked but never mentioned it)");
  assert.match(result.reason, /nvm/i, "must mention nvm was also checked");
  assert.doesNotMatch(result.reason, /add it to PATH/i, "must not claim adding to PATH would help -- PATH is never searched");
  assert.doesNotMatch(result.reason, /\bPATH\b/, "must not mention PATH at all, to avoid implying it was searched");
}

// Round 2, Reviewer Minor M3: `lts/*` resolves through nvm's own alias-chain shape (alias/default
// -> "lts/*" -> alias/lts/* -> a real version), not just a full x.y.z default.
{
  const files = {
    "/Users/jaymo/.nvm/alias/default": "lts/*",
    "/Users/jaymo/.nvm/alias/lts/*": "iron",
    "/Users/jaymo/.nvm/alias/iron": "v20.11.0",
  };
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v20.11.0/bin/node",
    readFile: (p) => files[p] ?? null,
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v20.11.0/bin/node", "must follow a multi-hop alias chain, not stop at the first non-version alias");
}

// M3: a chained custom alias ("work" -> "v18.0.0") resolves the same way.
{
  const files = { "/Users/jaymo/.nvm/alias/default": "work", "/Users/jaymo/.nvm/alias/work": "v18.0.0" };
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v18.0.0/bin/node",
    readFile: (p) => files[p] ?? null,
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v18.0.0/bin/node");
}

// M3: a partial version alias ("24") picks the HIGHEST INSTALLED version matching that major,
// not nvm's own "highest installed overall" fallback (round 1 measured: partial "24" resolved
// to a newer v25 install, silently picking a different major than the user pinned).
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node",
    readFile: (p) => (p === "/Users/jaymo/.nvm/alias/default" ? "24" : null),
    listNodeVersionDirs: (dir) =>
      dir === "/Users/jaymo/.nvm/versions/node" ? ["v20.11.0", "v24.9.0", "v24.14.1", "v25.0.0"] : [],
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node", "must pick the highest v24.x, not v25.0.0");
}
// M3: a major.minor partial ("24.14") narrows further.
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node",
    readFile: (p) => (p === "/Users/jaymo/.nvm/alias/default" ? "24.14" : null),
    listNodeVersionDirs: (dir) =>
      dir === "/Users/jaymo/.nvm/versions/node" ? ["v24.9.0", "v24.14.0", "v24.14.1"] : [],
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node");
}

// M3: a half-installed HIGHEST version (directory exists, no bin/node -- an interrupted nvm
// install) must not block a working lower version. Round 1 only tried the single highest dir.
{
  const result = resolveExporterLaunch({
    execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    homedir: "/Users/jaymo",
    exists: (p) => p === "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node", // v99.0.0 has no bin/node
    readFile: () => null,
    listNodeVersionDirs: (dir) =>
      dir === "/Users/jaymo/.nvm/versions/node" ? ["v24.14.1", "v99.0.0"] : [],
  });
  assert.equal(result.command, "/Users/jaymo/.nvm/versions/node/v24.14.1/bin/node", "must fall through past a half-installed newer version to a working older one");
}

console.log("exporterLaunch: all assertions passed");
