// Tests for the ops-map exporter's pure parts (build 2.5 m2): token
// extraction, agent/skill refs, and edge dedupe. Imports the REAL functions
// from the repo-canonical exporter (vault-scripts/, deployed to the vault by
// deploy.sh). Importing the exporter never starts a scan (direct-execution
// guard). Run: node exportOpsMap.test.mjs
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractTokenRefs,
  extractAgentRefs,
  extractSkillRefs,
  dedupeEdges,
  firstSentenceDescription,
  parseDisableModelInvocation,
  listSkillDirs,
  buildAgentNode,
  listPluginSkillDirs,
} from "./vault-scripts/export-ops-map.mjs";

// --- token refs: numbered tokens map by id prefix ---
{
  const nodesById = new Map([
    ["SOP-001-how-to-add-a-new-specialist", { id: "SOP-001-how-to-add-a-new-specialist", type: "sop" }],
    ["WS-001-daily-journaling", { id: "WS-001-daily-journaling", type: "workflow" }],
    ["GL-002-frontmatter-conventions", { id: "GL-002-frontmatter-conventions", type: "guideline" }],
  ]);
  const found = extractTokenRefs("See SOP-001 and WS-001 for details.", nodesById);
  assert.ok(found.has("SOP-001-how-to-add-a-new-specialist"), "SOP-001 token resolves to the full stem");
  assert.ok(found.has("WS-001-daily-journaling"), "WS-001 token resolves to the full stem");
  assert.ok(!found.has("GL-002-frontmatter-conventions"), "unmentioned token is not found");
}

// --- token refs: unnumbered full-stem tokens (e.g. SOP-claim-task) ---
{
  const nodesById = new Map([
    ["SOP-claim-task", { id: "SOP-claim-task", type: "sop" }],
    ["SOP-close-task", { id: "SOP-close-task", type: "sop" }],
  ]);
  const found = extractTokenRefs("Run SOP-claim-task before starting work.", nodesById);
  assert.ok(found.has("SOP-claim-task"), "exact unnumbered stem token is matched");
  assert.ok(!found.has("SOP-close-task"), "unmentioned unnumbered stem is not matched");
}

// --- token refs: unknown token ignored ---
{
  const nodesById = new Map([["SOP-001-how-to-add-a-new-specialist", { id: "SOP-001-how-to-add-a-new-specialist", type: "sop" }]]);
  const found = extractTokenRefs("SOP-999 does not exist.", nodesById);
  assert.equal(found.size, 0, "unknown token produces no match");
}

// --- agent refs: word-boundary + case-insensitive ---
{
  const agentIds = ["capture", "curate", "recruit"];
  const found = extractAgentRefs("Route this to Capture for journaling.", agentIds);
  assert.ok(found.has("capture"), "capitalized mention still matches lowercase agent id");
  assert.equal(found.size, 1, "only the mentioned agent is found");
}
{
  const agentIds = ["research"];
  const found = extractAgentRefs("This uses researcher tools, not the agent.", agentIds);
  assert.equal(found.size, 0, "word-boundary match does not fire inside a longer word");
}

// --- skill refs: context-scoped matcher (backtick or slash required) ---
{
  const skillIds = ["blog-write", "scope"];
  const found = extractSkillRefs("Call `blog-write` to generate the post.", skillIds);
  assert.ok(found.has("blog-write"), "backticked skill name matches");
  assert.ok(!found.has("scope"), "unmentioned skill is not found");
}
{
  const skillIds = ["vgb-email-router"];
  const found = extractSkillRefs("Invoke /vgb-email-router on schedule.", skillIds);
  assert.ok(found.has("vgb-email-router"), "slash-command form matches");
}
{
  const skillIds = ["scope", "brief"];
  const found = extractSkillRefs(
    "The scope of this brief is limited to plain prose mentions.",
    skillIds
  );
  assert.equal(found.size, 0, "plain-prose word mentions do NOT match without backtick/slash context");
}
{
  const skillIds = ["blog"];
  const found = extractSkillRefs("See `blogging` for details.", skillIds);
  assert.equal(found.size, 0, "backticked longer word does not match a shorter skill id (trailing boundary)");
}

// --- skill refs (Reviewer M1, 2026-08-04): the delimiter must not itself be
// preceded by a word char or another "/" -- otherwise a bare "/name" also
// matches inside path fragments and URLs, producing false used-by edges. ---
{
  const skillIds = ["blog"];
  const found = extractSkillRefs("See the post at https://example.com/blog for details.", skillIds);
  assert.equal(found.size, 0, "a URL path segment (word char before the slash) is not a skill reference");
}
{
  const skillIds = ["blog-google"];
  const found = extractSkillRefs("Run: python3 skills/blog-google/scripts/publish.py", skillIds);
  assert.equal(found.size, 0, "a filesystem path fragment (word char before the slash) is not a skill reference");
}
{
  const skillIds = ["firecrawl"];
  const found = extractSkillRefs("See https://firecrawl.dev or the skills/firecrawl/README for setup.", skillIds);
  assert.equal(found.size, 0, "a URL scheme's // does not let the next segment match either (slash before the slash)");
}
{
  const skillIds = ["close-session"];
  const found = extractSkillRefs("Run /close-session at the end of the day.", skillIds);
  assert.ok(found.has("close-session"), "genuine start-of-word slash-command still resolves");
}
{
  const skillIds = ["close-session"];
  const found = extractSkillRefs("Wrapped as `/close-session` in the docs.", skillIds);
  assert.ok(found.has("close-session"), "backtick-wrapped slash command still resolves");
}
{
  const skillIds = ["blog-write"];
  const found = extractSkillRefs("Start of the string /blog-write with no preceding character.", skillIds);
  assert.ok(found.has("blog-write"), "a slash-command mid-sentence but preceded by whitespace still resolves");
}

// --- dedupe: drops self-edges, dedupes from/to pairs, preserves first occurrence ---
{
  const edges = [
    { from: "capture", to: "capture", viaType: "agent" },
    { from: "capture", to: "WS-001-daily-journaling", viaType: "token" },
    { from: "capture", to: "WS-001-daily-journaling", viaType: "token" },
    { from: "curate", to: "WS-001-daily-journaling", viaType: "token" },
  ];
  const out = dedupeEdges(edges);
  assert.equal(out.length, 2, "self-edge dropped, duplicate from/to pair collapsed to one");
  assert.ok(out.some((e) => e.from === "capture" && e.to === "WS-001-daily-journaling"));
  assert.ok(out.some((e) => e.from === "curate" && e.to === "WS-001-daily-journaling"));
}

// --- firstSentenceDescription: System-browser Skills section (2026-08-04) ---
{
  const out = firstSentenceDescription("");
  assert.equal(out, "(no description)", "empty/missing description falls back");
}
{
  const out = firstSentenceDescription(undefined);
  assert.equal(out, "(no description)", "undefined description falls back");
}
{
  const out = firstSentenceDescription(
    "When the user wants to optimize content for AI search engines, get cited by LLMs, or appear in AI-generated answers. Also use when the user mentions 'AI SEO.'"
  );
  assert.equal(
    out,
    "When the user wants to optimize content for AI search engines, get cited by LLMs, or appear in AI-generated answers.",
    "takes only the first sentence, drops the rest"
  );
}
{
  const out = firstSentenceDescription("No terminal punctuation here at all just prose that runs on");
  assert.equal(
    out,
    "No terminal punctuation here at all just prose that runs on",
    "no sentence-ending punctuation: whole (short) text is kept"
  );
}
{
  const longNoSentence = "word ".repeat(40).trim(); // 199 chars, no punctuation
  const out = firstSentenceDescription(longNoSentence);
  assert.ok(out.length <= 141, "hard-truncated when the single sentence exceeds maxLen");
  assert.ok(out.endsWith("…"), "truncation adds an ellipsis");
  assert.ok(!out.includes("  "), "truncation does not leave a partial trailing word glued together");
}
{
  const out = firstSentenceDescription("Multi   \n  space   text.  Second sentence.");
  assert.equal(out, "Multi space text.", "whitespace is collapsed before sentence-splitting");
}

// --- parseDisableModelInvocation: tolerant of absence and casing ---
{
  assert.equal(parseDisableModelInvocation({}), false, "missing key defaults to false");
  assert.equal(
    parseDisableModelInvocation({ "disable-model-invocation": "true" }),
    true,
    "string 'true' is truthy"
  );
  assert.equal(
    parseDisableModelInvocation({ "disable-model-invocation": "TRUE" }),
    true,
    "case-insensitive"
  );
  assert.equal(
    parseDisableModelInvocation({ "disable-model-invocation": "false" }),
    false,
    "string 'false' is falsy"
  );
}

// --- listSkillDirs: symlinked skill dirs are found (real skills dirs are
// symlinks, e.g. ~/.claude/skills/firecrawl-* -> ~/.agents/skills/firecrawl-*) ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "listSkillDirs-test-"));
  try {
    const skillsDir = path.join(root, "skills");
    const realTarget = path.join(root, "real-target-dir");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(realTarget, { recursive: true });
    await fs.writeFile(path.join(realTarget, "SKILL.md"), "---\nname: symlinked-skill\n---\n");

    // A real (non-symlink) skill dir, for control.
    const plainDir = path.join(skillsDir, "plain-skill");
    await fs.mkdir(plainDir);
    await fs.writeFile(path.join(plainDir, "SKILL.md"), "---\nname: plain-skill\n---\n");

    // A symlinked skill dir pointing outside skillsDir (mirrors the real
    // ~/.agents/skills/ layout).
    await fs.symlink(realTarget, path.join(skillsDir, "symlinked-skill"), "dir");

    // A broken symlink (target does not exist) must be skipped, not thrown.
    await fs.symlink(path.join(root, "does-not-exist"), path.join(skillsDir, "broken-symlink"), "dir");

    // A symlink to a non-directory file must also be skipped.
    const plainFile = path.join(root, "not-a-dir.txt");
    await fs.writeFile(plainFile, "hi");
    await fs.symlink(plainFile, path.join(skillsDir, "symlink-to-file"), "file");

    const found = await listSkillDirs(skillsDir);
    const ids = found.map((f) => f.id).sort();
    assert.deepEqual(ids, ["plain-skill", "symlinked-skill"], "symlinked skill dir is found; broken symlink and symlink-to-file are skipped");

    const symlinked = found.find((f) => f.id === "symlinked-skill");
    assert.equal(symlinked.dir, path.join(skillsDir, "symlinked-skill"), "dir field keeps the symlink path (not resolved target), matching plain-dir behavior");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- buildAgentNode (Reviewer M2, 2026-08-04): reads the REAL contract at
// Agents/<Name>/AGENTS.md, not just the thin .claude/agents/*.md shim, and
// points `path` at the vault-visible contract (not the dot-folder shim,
// which Obsidian cannot open). Uses a synthetic vault -- production shape,
// not a fixture that hides the two-source join. ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buildAgentNode-test-"));
  try {
    const shimDir = path.join(root, ".claude", "agents");
    const contractDir = path.join(root, "Agents", "Coder");
    await fs.mkdir(shimDir, { recursive: true });
    await fs.mkdir(contractDir, { recursive: true });

    const shimPath = path.join(shimDir, "coder.md");
    await fs.writeFile(
      shimPath,
      "---\nname: coder\ndescription: Coder. Application code.\n---\n\nRead your real contract at Agents/Coder/AGENTS.md.\n"
    );

    const contractPath = path.join(contractDir, "AGENTS.md");
    await fs.writeFile(
      contractPath,
      "# Coder\n\nInvoke superpowers `test-driven-development` and `gsd-executor` for scoped tasks.\n"
    );

    const node = await buildAgentNode(root, shimPath);

    assert.equal(node.id, "coder");
    assert.equal(node.label, "Coder", "label still comes from the shim frontmatter");
    assert.equal(
      node.path,
      "Agents/Coder/AGENTS.md",
      "path points at the real, vault-visible contract, not the dot-folder shim"
    );
    assert.ok(
      node.body.includes("test-driven-development"),
      "node body includes the contract's content, not just the shim's (this is where the real skill refs live)"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
{
  // No contract folder yet (agent mid-onboarding): falls back to the shim's
  // own path rather than pointing at a file that doesn't exist.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buildAgentNode-noncontract-test-"));
  try {
    const shimDir = path.join(root, ".claude", "agents");
    await fs.mkdir(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, "new-hire.md");
    await fs.writeFile(shimPath, "---\nname: new-hire\n---\n\nOnboarding in progress.\n");

    const node = await buildAgentNode(root, shimPath);
    assert.equal(node.path, ".claude/agents/new-hire.md", "falls back to the shim path when no contract folder exists yet");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- listPluginSkillDirs (Reviewer M3, 2026-08-04): finds skills shipped by
// installed Claude Code plugins, namespaced pluginName:skillId to match how
// the host invokes them (/superpowers:brainstorming) and how usage-stats.json
// keys their runs. ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "listPluginSkillDirs-test-"));
  try {
    const pluginInstallDir = path.join(root, "cache", "acme", "widget-plugin", "1.0.0");
    const skillDir = path.join(pluginInstallDir, "skills", "do-thing");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: do-thing\ndescription: Does the thing.\n---\n");

    await fs.writeFile(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "widget-plugin@acme": [
            { scope: "user", installPath: pluginInstallDir, version: "1.0.0" },
          ],
        },
      })
    );

    const found = await listPluginSkillDirs(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "widget-plugin:do-thing", "id is namespaced pluginName:skillId");
    assert.equal(found[0].pluginName, "widget-plugin");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
{
  // Missing installed_plugins.json (no plugins installed on this host) does
  // not throw.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "listPluginSkillDirs-missing-test-"));
  try {
    const found = await listPluginSkillDirs(root);
    assert.deepEqual(found, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
{
  // Two installs of the same plugin (rare, different scopes) dedupe by id,
  // first install wins, rather than producing a duplicate node.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "listPluginSkillDirs-dupe-test-"));
  try {
    const install1 = path.join(root, "install1");
    const install2 = path.join(root, "install2");
    for (const dir of [install1, install2]) {
      const skillDir = path.join(dir, "skills", "do-thing");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: do-thing\n---\n");
    }
    await fs.writeFile(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "widget-plugin@acme": [
            { scope: "project", installPath: install1 },
            { scope: "user", installPath: install2 },
          ],
        },
      })
    );
    const found = await listPluginSkillDirs(root);
    assert.equal(found.length, 1, "duplicate plugin installs collapse to one node");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log("exportOpsMap: all assertions passed");
