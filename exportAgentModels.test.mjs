import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildAgentModelsSnapshot, main, parseShimFrontmatter, preserveLegacySnapshot } from "./vault-scripts/export-agent-models.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const exporter = path.join(here, "vault-scripts", "export-agent-models.mjs");
const readOrNull = async (file) => { try { return await fs.readFile(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } };

// Frontmatter parsing: only the top-level frontmatter `model:` line counts.
assert.deepEqual(parseShimFrontmatter("---\nname: coder\nmodel: sonnet\n---\nbody"), { name: "coder", model: "sonnet" });
assert.deepEqual(parseShimFrontmatter("---\nname: q\nmodel: \"opus\"\n---\n"), { name: "q", model: "opus" }, "quoted model value is unquoted");
assert.deepEqual(parseShimFrontmatter("---\nname: x\n---\nmodel: opus\n"), { name: "x", model: null }, "a model line in the body is not configuration");
assert.deepEqual(parseShimFrontmatter("---\nname: x\ndescription: >\n  model: opus\n---\n"), { name: "x", model: null }, "an indented continuation line is not the model key");
assert.deepEqual(parseShimFrontmatter("no frontmatter"), { name: null, model: null });
assert.deepEqual(parseShimFrontmatter("---\r\nname: w\r\nmodel: haiku\r\n---\r\n"), { name: "w", model: "haiku" }, "CRLF shims parse");

const vault = await fs.mkdtemp(path.join(os.tmpdir(), "claude-agent-models-"));
try {
  const agents = path.join(vault, ".claude", "agents");
  await fs.mkdir(path.join(agents, "nested"), { recursive: true });
  await fs.writeFile(path.join(agents, "coder.md"), "---\nname: coder\nmodel: sonnet\n---\nbody\n");
  await fs.writeFile(path.join(agents, "capture.md"), "---\nname: capture\nmodel: haiku\n---\n");
  await fs.writeFile(path.join(agents, "nomodel.md"), "---\nname: nomodel\ndescription: forgot the model line\n---\nmodel: opus in prose\n");
  await fs.writeFile(path.join(agents, "inheritor.md"), "---\nname: inheritor\nmodel: inherit\n---\n");
  await fs.writeFile(path.join(agents, "nested", "deep.md"), "---\nname: deep\nmodel: opus\n---\n");
  await fs.writeFile(path.join(agents, "notes.txt"), "model: opus\n");
  const outsideShim = path.join(vault, "outside.md"); await fs.writeFile(outsideShim, "---\nname: linked\nmodel: opus\n---\n");
  await fs.symlink(outsideShim, path.join(agents, "linked.md"));

  const snapshot = await buildAgentModelsSnapshot({ vaultRoot: vault });
  assert.equal(snapshot.schemaVersion, 2, "Claude snapshot is schemaVersion 2 so the old Pi reader cannot mistake it");
  assert.equal(snapshot.source, "claude-agent-shims");
  assert.equal(snapshot.agentsDir, ".claude/agents");
  assert.deepEqual(snapshot.agents.map((a) => a.slug), ["capture", "coder", "inheritor", "nomodel"], "only top-level regular .claude/agents/*.md shims, sorted; nested, non-md and symlinked files skipped");
  assert.deepEqual(snapshot.agents.find((a) => a.slug === "coder"), { slug: "coder", name: "coder", file: ".claude/agents/coder.md", model: "sonnet", status: "set" });
  assert.deepEqual(snapshot.agents.find((a) => a.slug === "nomodel"), { slug: "nomodel", name: "nomodel", file: ".claude/agents/nomodel.md", model: null, status: "missing" }, "a shim with no model line is flagged missing");
  assert.equal(snapshot.agents.find((a) => a.slug === "inheritor").status, "inherit", "explicit inherit is flagged separately from missing");
  assert.deepEqual(snapshot.missingModel, ["nomodel"], "missing model lines are listed by slug at the top level");
  assert.deepEqual(snapshot.errors, []);

  const emptyVault = await fs.mkdtemp(path.join(os.tmpdir(), "claude-agent-models-empty-"));
  try {
    const none = await buildAgentModelsSnapshot({ vaultRoot: emptyVault });
    assert.deepEqual(none.agents, []); assert.deepEqual(none.errors, [".claude/agents not found"], "missing shim directory is reported, not silently empty");
  } finally { await fs.rm(emptyVault, { recursive: true, force: true }); }

  // Credential blindness: the exporter source never names a credential or
  // Pi/home path, and a run succeeds with unreadable credential canaries.
  const source = await fs.readFile(exporter, "utf8");
  for (const banned of ["auth.json", ".credentials", "homedir", ".pi", "models-store", "apiKey"]) assert.ok(!source.includes(banned), `exporter source never references ${banned}`);
  const fakeHome = path.join(vault, "home"); await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true }); await fs.mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
  const canaries = [path.join(fakeHome, ".claude", ".credentials.json"), path.join(fakeHome, ".pi", "agent", "auth.json")];
  for (const file of canaries) { await fs.writeFile(file, "SECRET_CANARY"); await fs.chmod(file, 0o000); }

  // CLI: --out writes to an explicit path, leaving the live default untouched.
  const tempOut = path.join(vault, "tmp-out", "agent-models.json");
  const cli = await new Promise((resolve) => { const c = spawn(process.execPath, [exporter, vault, "--out", tempOut], { env: { ...process.env, HOME: fakeHome }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; c.stdout.on("data", (d) => stdout += d); c.stderr.on("data", (d) => stderr += d); c.once("exit", (code) => resolve({ code, stdout, stderr })); });
  assert.equal(cli.code, 0, `CLI exits cleanly: ${JSON.stringify(cli)}`);
  assert.match(cli.stdout, /agent-models: 4 Claude agent shim\(s\), 1 missing a model line \(nomodel\) ->/, "CLI summary names the missing shim loudly");
  const writtenRaw = await readOrNull(tempOut);
  assert.notEqual(writtenRaw, null, "--out writes the snapshot to the explicit temp path");
  const written = JSON.parse(writtenRaw);
  assert.deepEqual(written.missingModel, ["nomodel"]); assert.ok(!JSON.stringify(written).includes("SECRET_CANARY"));
  await assert.rejects(fs.access(path.join(vault, "Operations", "agent-models.json")), "--out never writes the live default path");
  for (const file of canaries) await fs.chmod(file, 0o600);

  // Legacy Pi snapshot preservation: before the first Claude export replaces a
  // schemaVersion 1 file, it is copied (never moved) to a dated history file.
  const ops = path.join(vault, "Operations"); await fs.mkdir(ops, { recursive: true });
  const legacy = JSON.stringify({ schemaVersion: 1, generatedAt: "2026-09-15T10:02:14.953Z", catalog: { providers: [] }, agents: [{ name: "capture", effective: { model: "openai-codex/gpt-5.6-luna" } }] }, null, 2) + "\n";
  await fs.writeFile(path.join(ops, "agent-models.json"), legacy);
  const historyFile = path.join(ops, "agent-models-history", "2026-09-15-pi.json");
  await main(vault);
  // No custom message: the generated diff names the expected and actual history file names.
  assert.deepEqual(await fs.readdir(path.dirname(historyFile)).catch(() => []), ["2026-09-15-pi.json"]);
  assert.equal(await readOrNull(historyFile), legacy, "legacy Pi snapshot is preserved byte-identical at Operations/agent-models-history/2026-09-15-pi.json");
  assert.equal(JSON.parse(await fs.readFile(path.join(ops, "agent-models.json"), "utf8")).schemaVersion, 2, "live output becomes the Claude snapshot");
  await fs.writeFile(historyFile, "KEEP_EXISTING_HISTORY");
  await fs.writeFile(path.join(ops, "agent-models.json"), legacy);
  assert.equal((await preserveLegacySnapshot(path.join(ops, "agent-models.json"))).status, "exists", "an existing history file is never overwritten");
  assert.equal(await fs.readFile(historyFile, "utf8"), "KEEP_EXISTING_HISTORY");
  await fs.writeFile(path.join(ops, "agent-models.json"), JSON.stringify({ schemaVersion: 2, agents: [] }));
  assert.equal((await preserveLegacySnapshot(path.join(ops, "agent-models.json"))).status, "not-legacy", "a Claude snapshot is never copied to history");
} finally { await fs.rm(vault, { recursive: true, force: true }); }
console.log("exportAgentModels: all assertions passed");
