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

console.log("exporterLaunch: all assertions passed");
