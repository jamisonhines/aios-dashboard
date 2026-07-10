// Tests for the ops-map exporter's pure parts (build 2.5 m2): token
// extraction, agent/skill refs, and edge dedupe. Mirror of the functions in
// ~/AIOS/Operations/scripts/export-ops-map.mjs (kept in sync manually; the
// exporter lives in the vault, not this repo). Run: node exportOpsMap.test.mjs
import assert from "node:assert";

const TOKEN_RE = /\b(SOP-\d{3}|WS-\d{3}|GL-\d{3})\b/g;

function extractTokenRefs(body, nodesById) {
  const found = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body))) {
    const token = m[1];
    for (const node of nodesById.values()) {
      if (node.id.startsWith(token)) found.add(node.id);
    }
  }
  for (const node of nodesById.values()) {
    if (node.type !== "sop" && node.type !== "workflow" && node.type !== "guideline") continue;
    if (/^(SOP|WS|GL)-\d+/.test(node.id)) continue;
    const re = new RegExp(`\\b${node.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(body)) found.add(node.id);
  }
  return found;
}

function extractAgentRefs(body, agentIds) {
  const found = new Set();
  for (const slug of agentIds) {
    const re = new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(body)) found.add(slug);
  }
  return found;
}

function extractSkillRefs(body, skillIds) {
  const found = new Set();
  for (const id of skillIds) {
    const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(body)) found.add(id);
  }
  return found;
}

function dedupeEdges(edges) {
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

// --- skill refs: exact word-boundary match (hyphens count as boundaries,
// so a shorter skill id can still match inside a longer hyphenated one --
// accepted per spec: "word boundary", not "whole token") ---
{
  const skillIds = ["blog-write", "blog"];
  const found = extractSkillRefs("Use blog-write for full posts.", skillIds);
  assert.ok(found.has("blog-write"), "exact skill id matches");
  assert.ok(found.has("blog"), "hyphen-adjacent skill id also matches (word-boundary semantics)");
}
{
  const skillIds = ["blog"];
  const found = extractSkillRefs("This mentions blogging in passing.", skillIds);
  assert.equal(found.size, 0, "skill id does not match inside a longer non-hyphenated word");
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

console.log("exportOpsMap: all assertions passed");
