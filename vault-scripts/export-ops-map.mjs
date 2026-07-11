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

async function listSkillDirs(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(dir, e.name, "SKILL.md");
    try {
      await fs.access(skillFile);
      out.push({ id: e.name, dir: path.join(dir, e.name), skillFile });
    } catch {
      // Not a skill dir (no SKILL.md); skip.
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

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

async function buildAgentNode(vaultRoot, filePath) {
  const id = path.basename(filePath, ".md");
  const text = await readCapped(filePath);
  const fm = parseFrontmatter(text);
  return {
    id,
    type: "agent",
    label: fm.name ? prettifyStem(fm.name) : prettifyStem(id),
    description: (fm.description || "").slice(0, 140),
    path: vaultRelative(vaultRoot, filePath),
    body: text,
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

async function buildSkillNode(skill) {
  const text = await readCapped(skill.skillFile);
  const fm = parseFrontmatter(text);
  return {
    id: skill.id,
    type: "skill",
    label: skill.id,
    description: (fm.description || "").replace(/\s+/g, " ").trim().slice(0, 140),
    path: skill.dir,
    external: true,
    body: text,
  };
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
export function extractSkillRefs(body, skillIds) {
  const found = new Set();
  for (const id of skillIds) {
    const re = new RegExp(`[\`/]${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
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

  const nodes = [];
  for (const f of agentFiles) nodes.push(await buildAgentNode(vaultRoot, f));
  for (const f of sopFiles) nodes.push(await buildOpsNode(vaultRoot, f, "sop"));
  for (const f of workflowFiles) nodes.push(await buildOpsNode(vaultRoot, f, "workflow"));
  for (const f of guidelineFiles) nodes.push(await buildOpsNode(vaultRoot, f, "guideline"));
  for (const s of skillDirs) nodes.push(await buildSkillNode(s));

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

  // Strip the body field before writing output (internal-only, used for edge
  // extraction).
  const outNodes = nodes.map(({ body, ...rest }) => rest);

  const output = {
    generatedAt: new Date().toISOString(),
    nodes: outNodes,
    edges,
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
