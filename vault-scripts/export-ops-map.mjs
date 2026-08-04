#!/usr/bin/env node
// Export the AIOS operating-system map (agents, SOPs, workflows, guidelines,
// skills, and their cross-references) into <vaultRoot>/Operations/ops-map.json
// for the aios-dashboard Ops map tab.
// Usage: node export-ops-map.mjs [vaultRoot]
// Style-matches export-usage-stats.mjs: plain node, no deps, tolerant of
// missing files.
//
// Canonical home: the aios-dashboard repo (vault-scripts/). deploy.sh copies
// this file into <vault>/Operations/scripts/. Pure parts (ref extraction,
// frontmatter parse, edge dedupe) are exported so the repo test suite
// (exportOpsMap.test.mjs) imports the REAL functions instead of keeping a
// hand-synced mirror. Importing this module never starts a scan: the script
// body only runs on direct execution (see the guard at the bottom).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const MAX_READ_BYTES = 40 * 1024;

// ---------------------------------------------------------------------------
// Helpers (pure where practical; the pure ones are exported and unit-tested
// in exportOpsMap.test.mjs)
// ---------------------------------------------------------------------------

async function listMdFiles(dir, { skipIndex = true } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .filter((e) => !skipIndex || e.name.toLowerCase() !== "index.md")
    .map((e) => path.join(dir, e.name))
    .sort();
}

// Tolerant of symlinked skill dirs (~/.claude/skills commonly holds
// symlinks into ~/.agents/skills/, e.g. all firecrawl-* skills): a
// readdir() Dirent's isDirectory()/isSymbolicLink() reflect the entry's OWN
// type, never the symlink target, so a plain isDirectory() check silently
// drops every symlinked skill. For any entry that is a symlink, fs.stat()
// (which follows symlinks, unlike fs.lstat()) resolves whether the TARGET
// is a directory; a broken symlink's stat() throws and the entry is
// skipped, same as any other non-skill entry.
export async function listSkillDirs(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const entryPath = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        const stat = await fs.stat(entryPath);
        isDir = stat.isDirectory();
      } catch {
        continue; // broken symlink target
      }
    }
    if (!isDir) continue;
    const skillFile = path.join(entryPath, "SKILL.md");
    try {
      await fs.access(skillFile);
      out.push({ id: e.name, dir: entryPath, skillFile });
    } catch {
      // Not a skill dir (no SKILL.md); skip.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Reviewer M3 (2026-08-04): the spec says "every installed skill" -- that
// includes skills shipped BY installed Claude Code plugins (superpowers,
// context-mode, etc.), which live under
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/*/SKILL.md,
// not under ~/.claude/skills at all. installed_plugins.json is the
// authoritative "what's actually installed" list (its installPath per
// plugin already resolves the version); ids are namespaced pluginName:
// skillId to match how the host itself invokes them
// (/superpowers:brainstorming) and how usage-stats.json keys their runs,
// so the usage join in buildSkillNode's caller works without extra mapping.
// Tolerant of a missing/malformed installed_plugins.json (a host with no
// plugins installed) and of an install whose skills/ folder doesn't exist.
export async function listPluginSkillDirs(
  pluginsRoot = path.join(os.homedir(), ".claude", "plugins")
) {
  let installed;
  try {
    installed = JSON.parse(await fs.readFile(path.join(pluginsRoot, "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const [key, installs] of Object.entries(installed.plugins || {})) {
    const pluginName = key.split("@")[0];
    for (const inst of installs || []) {
      if (!inst || !inst.installPath) continue;
      const dirs = await listSkillDirs(path.join(inst.installPath, "skills"));
      for (const d of dirs) {
        const id = `${pluginName}:${d.id}`;
        if (seen.has(id)) continue; // same plugin installed at >1 scope
        seen.add(id);
        out.push({ id, dir: d.dir, skillFile: d.skillFile, pluginName });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function readCapped(filePath, maxBytes = MAX_READ_BYTES) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, 0);
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

// Minimal frontmatter parser: only pulls single-line `key: value` pairs out
// of the leading `---` block. Good enough for agent shims and SKILL.md
// (name/description/model fields); not a full YAML parser.
export function parseFrontmatter(text) {
  const out = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  const block = text.slice(3, end);
  const lines = block.split("\n");
  let currentKey = null;
  for (const raw of lines) {
    const foldedMatch = raw.match(/^\s+(.*)$/);
    if (foldedMatch && currentKey) {
      out[currentKey] = (out[currentKey] ? out[currentKey] + " " : "") + foldedMatch[1].trim();
      continue;
    }
    const m = raw.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === ">" || value === "|" || value === "") {
      currentKey = key;
      out[key] = "";
      continue;
    }
    currentKey = null;
    value = value.replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

export function firstHeading(text) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export function prettifyStem(stem) {
  return stem
    .replace(/^(SOP|WS|GL)-\d+-/, "")
    .replace(/^(SOP|WS|GL)-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function vaultRelative(vaultRoot, filePath) {
  return path.relative(vaultRoot, filePath).split(path.sep).join("/");
}

// System-browser Skills section (2026-08-04): a skill's raw frontmatter
// `description:` is often a long run-on paragraph written for the model, not
// a human scanning a table. Take the first sentence (up to and including the
// first ., !, or ? followed by whitespace/end) and hard-truncate it if it is
// still too long for a table row. Falls back to "(no description)" so the
// plugin never has to special-case a missing/empty description.
export function firstSentenceDescription(raw, maxLen = 140) {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "(no description)";
  const m = text.match(/^(.*?[.!?])(\s|$)/);
  let sentence = m ? m[1].trim() : text;
  if (sentence.length > maxLen) {
    const cut = sentence.slice(0, maxLen - 1);
    const lastSpace = cut.lastIndexOf(" ");
    sentence = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
  }
  return sentence;
}

// Claude Code's SKILL.md frontmatter uses `disable-model-invocation: true` to
// mean "slash-command only, the model will never auto-invoke this skill".
// Tolerant of the key being absent (most skills) or spelled with any casing.
export function parseDisableModelInvocation(fm) {
  const raw = fm["disable-model-invocation"];
  if (raw === undefined) return false;
  return /^(true|yes)$/i.test(String(raw).trim());
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

// Reviewer M2 (2026-08-04, measured): the .claude/agents/*.md shim is a thin
// Claude-Code-specific pointer (frontmatter + "go read your real contract"
// instructions) with almost no skill names in it, so building agent nodes
// from the shim ALONE meant agents contributed ~zero skill edges. The real
// wiring -- which skills/SOPs/workflows/agents an agent actually names --
// lives in the real contract at Agents/<Name>/AGENTS.md (and any sibling
// top-level *.md in that folder, e.g. a future NOTES.md). This now reads
// BOTH: the shim (still the id/label/description source, since that's the
// Claude-Code-specific metadata) and the contract folder (folded into the
// same node's body, so buildEdges finds refs from either source), and
// points the node's `path` at the real contract file -- Obsidian cannot
// open a dot-directory, so the shim was never a clickable link target
// anyway. Falls back to the shim's own path only if no contract file
// exists yet (a newly hired agent mid-onboarding, before Recruit has
// written its Agents/<Name>/AGENTS.md).
export async function buildAgentNode(vaultRoot, filePath) {
  const id = path.basename(filePath, ".md");
  const shimText = await readCapped(filePath);
  const fm = parseFrontmatter(shimText);
  const label = fm.name ? prettifyStem(fm.name) : prettifyStem(id);

  const contractDir = path.join(vaultRoot, "Agents", label);
  const contractFiles = await listMdFiles(contractDir);
  const primaryContract =
    contractFiles.find((f) => path.basename(f) === "AGENTS.md") || contractFiles[0];
  let contractText = "";
  for (const f of contractFiles) contractText += "\n" + (await readCapped(f));

  return {
    id,
    type: "agent",
    label,
    description: (fm.description || "").slice(0, 140),
    // System-browser Agents section (Phase 3, 2026-08-05): the shim's
    // `model:` frontmatter line is the same value ops-map's Coder/Recruit
    // shim template documents as mandatory (SOP-001 step 5). Undefined
    // (never empty string) when the shim predates that convention, so the
    // plugin can render an honest dash instead of a blank cell.
    model: fm.model || undefined,
    path: primaryContract
      ? vaultRelative(vaultRoot, primaryContract)
      : vaultRelative(vaultRoot, filePath),
    body: shimText + "\n" + contractText,
  };
}

async function buildOpsNode(vaultRoot, filePath, type) {
  const stem = path.basename(filePath, ".md");
  const text = await readCapped(filePath);
  const heading = firstHeading(text);
  return {
    id: stem,
    type,
    label: heading || prettifyStem(stem),
    description: "",
    path: vaultRelative(vaultRoot, filePath),
    body: text,
  };
}

// `origin` (Reviewer M3, 2026-08-04) distinguishes where a skill node came
// from -- "skills-dir" (~/.claude/skills, the default and original source),
// "plugin" (an installed Claude Code plugin's own skills/ folder, namespaced
// pluginName:skillId), or "command" (the vault's .claude/commands/*.md
// slash commands, e.g. close-session). The plugin renders a badge per
// origin so 220+ skills from three different sources stay legible.
async function buildSkillNode(skill, origin = "skills-dir") {
  const text = await readCapped(skill.skillFile);
  const fm = parseFrontmatter(text);
  return {
    id: skill.id,
    type: "skill",
    label: skill.label || skill.id,
    description: firstSentenceDescription(fm.description),
    hasDescription: Boolean((fm.description || "").trim()),
    disableModelInvocation: parseDisableModelInvocation(fm),
    path: skill.dir,
    external: true,
    origin,
    body: text,
  };
}

// ---------------------------------------------------------------------------
// System-browser "Available hires" (Phase 3, 2026-08-05): SOP-001's
// procedure describes how to hire a specialist, not a catalog of
// off-the-shelf roster patterns, so it currently has no "Reference
// pattern" heading to parse (checked against the real file on this
// machine). Parses defensively for a future heading matching
// /reference pattern/i anyway, so the day Recruit adds one this starts
// working with no exporter change; today (and for any SOP-001 that never
// gains the heading) it returns found:false, and the caller renders a
// graceful "see SOP-001" fallback row instead of fabricating a hardcoded
// list (task requirement: a hardcoded-in-exporter list is NOT acceptable).
//
// When found, each bullet under the heading becomes one item: a bullet like
// "- **Label**: rest of the line" (colon, hyphen, or a longer dash
// separator, bold or plain) splits into {label, description}; a bullet with
// no separator becomes {label: the whole line, description: ""}. Stops at
// the next heading of equal-or-shallower depth, or end of file.
// ---------------------------------------------------------------------------

// Longer-dash separators built from code points, not literal glyphs, so
// this file never contains a literal long-dash character (repo-wide
// writing rule). Covers en dash (U+2013) and em dash (U+2014).
const DASH_CLASS = "[-" + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + "]";

export function parseAvailableHires(body) {
  if (!body) return { found: false, items: [] };
  const lines = body.split("\n");
  const headingRe = /^(#{1,6})\s+(.*)$/;
  let startIdx = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (m && /reference pattern/i.test(m[2])) {
      startIdx = i + 1;
      startDepth = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return { found: false, items: [] };

  const items = [];
  const bulletRe = /^\s*-\s+(.*)$/;
  const boldRe = new RegExp("^\\*\\*(.+?)\\*\\*\\s*(?:" + DASH_CLASS + "|:)?\\s*(.*)$");
  const plainRe = new RegExp("^(.+?)\\s+(?::|" + DASH_CLASS + ")\\s+(.*)$");
  for (let i = startIdx; i < lines.length; i++) {
    const h = headingRe.exec(lines[i]);
    if (h && h[1].length <= startDepth) break;
    const b = bulletRe.exec(lines[i]);
    if (!b) continue;
    const rest = b[1].trim();
    const boldMatch = rest.match(boldRe);
    if (boldMatch) {
      items.push({ label: boldMatch[1].trim(), description: boldMatch[2].trim() });
      continue;
    }
    const plainMatch = rest.match(plainRe);
    if (plainMatch) {
      items.push({ label: plainMatch[1].trim(), description: plainMatch[2].trim() });
      continue;
    }
    items.push({ label: rest, description: "" });
  }
  return { found: items.length > 0, items };
}

// ---------------------------------------------------------------------------
// Edge extraction (pure over an in-memory node set; exported for tests)
// ---------------------------------------------------------------------------

export const TOKEN_RE = /\b(SOP-\d{3}|WS-\d{3}|GL-\d{3})\b/g;

export function extractTokenRefs(body, nodesById) {
  const found = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body))) {
    const token = m[1];
    for (const node of nodesById.values()) {
      if (node.id.startsWith(token)) found.add(node.id);
    }
  }
  // Full stem tokens without numbers, e.g. SOP-claim-task.
  for (const node of nodesById.values()) {
    if (node.type !== "sop" && node.type !== "workflow" && node.type !== "guideline") continue;
    if (/^(SOP|WS|GL)-\d+/.test(node.id)) continue; // already covered above
    const re = new RegExp(`\\b${node.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(body)) found.add(node.id);
  }
  return found;
}

export function extractAgentRefs(body, agentIds) {
  const found = new Set();
  for (const slug of agentIds) {
    const re = new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(body)) found.add(slug);
  }
  return found;
}

// Skill refs require a backtick or forward slash immediately before the name
// (real refs are always written as `skill-name` or /skill-name); this kills
// prose false positives like "brief", "scope", "blog" as ordinary words.
//
// Reviewer M1 (2026-08-04, measured): the delimiter alone was not enough --
// a bare "/name" also matches inside a PATH FRAGMENT ("skills/blog-google/
// scripts") and inside a URL ("https://example.com/blog"), because in both
// cases the character directly before the "/" is a word character (or
// another "/" for a URL's "//"). A negative lookbehind closes both holes at
// once: the delimiter itself must NOT be preceded by a word character or
// another "/". That leaves every genuine invocation form intact --
// start-of-line/start-of-string "/skill-name", whitespace-preceded
// "Invoke /skill-name", and any backtick form ("`skill-name`",
// "`/skill-name`") -- since none of those put a word char or "/" directly
// before the matched delimiter.
export function extractSkillRefs(body, skillIds) {
  const found = new Set();
  for (const id of skillIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Trailing guard is (?![\w-]) not \b: with \b, a mention of `blog-write`
    // also matches the bare skill id "blog" (the g->- transition is a word
    // boundary), producing false hub-skill edges.
    const re = new RegExp(`(?<![\\w/])[\`/]${escaped}(?![\\w-])`);
    if (re.test(body)) found.add(id);
  }
  return found;
}

export function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = e.from + " " + e.to;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function buildEdges(nodes) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const agentIds = nodes.filter((n) => n.type === "agent").map((n) => n.id);
  const skillIds = nodes.filter((n) => n.type === "skill").map((n) => n.id);
  const edges = [];

  for (const node of nodes) {
    const body = node.body || "";

    // Token refs (SOP/WS/GL) from any node body.
    for (const targetId of extractTokenRefs(body, nodesById)) {
      if (targetId === node.id) continue;
      edges.push({ from: node.id, to: targetId, viaType: "token" });
    }

    // Agent refs from SOP/WS/GL bodies, and from agent shim bodies.
    if (node.type === "sop" || node.type === "workflow" || node.type === "guideline") {
      for (const agentId of extractAgentRefs(body, agentIds)) {
        edges.push({ from: node.id, to: agentId, viaType: "agent" });
      }
    }
    if (node.type === "agent") {
      for (const agentId of extractAgentRefs(body, agentIds)) {
        if (agentId === node.id) continue;
        edges.push({ from: node.id, to: agentId, viaType: "agent" });
      }
    }

    // Skill refs from any node body.
    for (const skillId of extractSkillRefs(body, skillIds)) {
      if (skillId === node.id) continue;
      edges.push({ from: node.id, to: skillId, viaType: "skill" });
    }
  }

  return dedupeEdges(edges);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const vaultRoot = path.resolve(process.argv[2] || process.cwd());
  const outDir = path.join(vaultRoot, "Operations");
  const outFile = path.join(outDir, "ops-map.json");
  const skillsRoot = path.join(os.homedir(), ".claude", "skills");

  const agentFiles = await listMdFiles(path.join(vaultRoot, ".claude", "agents"));
  const sopFiles = await listMdFiles(path.join(vaultRoot, "Operations", "SOPs"));
  const workflowFiles = await listMdFiles(path.join(vaultRoot, "Operations", "Workflows"));
  const guidelineFiles = await listMdFiles(path.join(vaultRoot, "Operations", "Guidelines"));
  const skillDirs = await listSkillDirs(skillsRoot);
  const pluginSkillDirs = await listPluginSkillDirs();
  // Slash commands (Reviewer M3, 2026-08-04): the vault's .claude/commands/
  // *.md are also skills from the host's point of view -- close-session is
  // the clearest example (real usage-stats spend, no ~/.claude/skills entry
  // at all). Keyed by bare basename to match usage-stats.json's run key
  // (SKILL_COMMAND_RE strips the leading "/").
  const commandFiles = await listMdFiles(path.join(vaultRoot, ".claude", "commands"));
  const commandSkills = commandFiles.map((f) => ({
    id: path.basename(f, ".md"),
    dir: vaultRelative(vaultRoot, f),
    skillFile: f,
  }));

  const nodes = [];
  for (const f of agentFiles) nodes.push(await buildAgentNode(vaultRoot, f));
  for (const f of sopFiles) nodes.push(await buildOpsNode(vaultRoot, f, "sop"));
  for (const f of workflowFiles) nodes.push(await buildOpsNode(vaultRoot, f, "workflow"));
  for (const f of guidelineFiles) nodes.push(await buildOpsNode(vaultRoot, f, "guideline"));
  for (const s of skillDirs) nodes.push(await buildSkillNode(s, "skills-dir"));
  for (const s of pluginSkillDirs) nodes.push(await buildSkillNode(s, "plugin"));
  for (const s of commandSkills) nodes.push(await buildSkillNode(s, "command"));

  // Canonical skill registry: skills it mentions (same context-scoped matcher)
  // are flagged registered:true on their node. The registry itself is not a
  // node and contributes no edges.
  const registryBody = await readCapped(path.join(vaultRoot, "Operations", "skill-registry.md"));
  if (registryBody) {
    const skillIds = nodes.filter((n) => n.type === "skill").map((n) => n.id);
    const registered = extractSkillRefs(registryBody, skillIds);
    for (const n of nodes) {
      if (n.type === "skill" && registered.has(n.id)) n.registered = true;
    }
  }

  const edges = buildEdges(nodes);

  // System-browser Skills section (2026-08-04): denormalize "who references
  // this skill" onto the skill node itself so the plugin doesn't have to
  // scan the full edges array per row. Every edge targeting a skill node is
  // always viaType "skill" (see buildEdges), so no viaType filter is needed
  // here.
  const usedByMap = new Map();
  for (const e of edges) {
    if (!usedByMap.has(e.to)) usedByMap.set(e.to, []);
    usedByMap.get(e.to).push(e.from);
  }
  for (const n of nodes) {
    if (n.type === "skill") n.usedBy = usedByMap.get(n.id) || [];
  }

  // Strip the body field before writing output (internal-only, used for edge
  // extraction).
  const outNodes = nodes.map(({ body, ...rest }) => rest);

  // System-browser "Available hires" (Phase 3, 2026-08-05): see
  // parseAvailableHires' own comment for why this is usually found:false on
  // the real SOP-001 today, and why that's the graceful, correct outcome
  // rather than a bug.
  const sop001Path = path.join(vaultRoot, "Operations", "SOPs", "SOP-001-how-to-add-a-new-specialist.md");
  const sop001Body = await readCapped(sop001Path);
  const availableHires = {
    ...parseAvailableHires(sop001Body),
    sopId: "SOP-001-how-to-add-a-new-specialist",
    sopPath: vaultRelative(vaultRoot, sop001Path),
  };

  const output = {
    generatedAt: new Date().toISOString(),
    nodes: outNodes,
    edges,
    availableHires,
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(output, null, 2) + "\n", "utf8");

  const counts = {};
  for (const n of outNodes) counts[n.type] = (counts[n.type] || 0) + 1;
  const countsText = Object.entries(counts)
    .map(([type, n]) => `${n} ${type}`)
    .join(", ");
  console.log(
    `ops-map: ${countsText}, ${edges.length} edge(s) -> ${outFile}`
  );
}

// Run only on direct execution (node export-ops-map.mjs ...), never on import.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((e) => {
    console.error("ops-map: export failed:", e?.message || e);
    process.exitCode = 1;
  });
}
