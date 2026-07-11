// Tests for the ops-map exporter's pure parts (build 2.5 m2): token
// extraction, agent/skill refs, and edge dedupe. Imports the REAL functions
// from the repo-canonical exporter (vault-scripts/, deployed to the vault by
// deploy.sh). Importing the exporter never starts a scan (direct-execution
// guard). Run: node exportOpsMap.test.mjs
import assert from "node:assert";
import {
  extractTokenRefs,
  extractAgentRefs,
  extractSkillRefs,
  dedupeEdges,
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
