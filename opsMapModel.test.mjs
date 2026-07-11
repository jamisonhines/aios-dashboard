// Tests for the ops-map view model (build 2.5 m2): computeOpsMapLayout.
// Imports the SAME module main.ts bundles (model.mjs).
// Run: node opsMapModel.test.mjs
import assert from "node:assert";
import { computeOpsMapLayout } from "./model.mjs";

// --- empty manifest ---
{
  const layout = computeOpsMapLayout(null);
  assert.equal(layout.columns.length, 5, "always 5 columns, even with no manifest");
  assert.ok(layout.columns.every((c) => c.count === 0), "every column count is 0");
  assert.equal(layout.nodes.length, 0, "no nodes");
  assert.equal(layout.edges.length, 0, "no edges");

  const layoutEmptyObj = computeOpsMapLayout({ nodes: [], edges: [] });
  assert.equal(layoutEmptyObj.nodes.length, 0, "explicit empty arrays also produce no nodes");
}

// --- unknown edge endpoints dropped ---
{
  const manifest = {
    nodes: [
      { id: "capture", type: "agent", label: "Capture", path: ".claude/agents/capture.md" },
      { id: "WS-001-daily-journaling", type: "workflow", label: "WS-001", path: "Operations/Workflows/WS-001-daily-journaling.md" },
    ],
    edges: [
      { from: "capture", to: "WS-001-daily-journaling", viaType: "token" },
      { from: "capture", to: "SOP-999-does-not-exist", viaType: "token" },
      { from: "GL-999-ghost", to: "capture", viaType: "token" },
    ],
  };
  const layout = computeOpsMapLayout(manifest);
  assert.equal(layout.edges.length, 1, "only the edge with two known endpoints survives");
  assert.equal(layout.edges[0].from, "capture");
  assert.equal(layout.edges[0].to, "WS-001-daily-journaling");
}

// --- visibility rule: only ops-connected skills stay individual ---
{
  const manifest = {
    nodes: [
      { id: "blog-write", type: "skill", label: "blog-write", path: "/skills/blog-write" },
      { id: "blog-outline", type: "skill", label: "blog-outline", path: "/skills/blog-outline" },
      { id: "capture", type: "agent", label: "Capture", path: ".claude/agents/capture.md" },
    ],
    edges: [{ from: "capture", to: "blog-write", viaType: "skill" }],
  };
  const layout = computeOpsMapLayout(manifest);
  const skillNodes = layout.nodes.filter((n) => n.column === 4);
  // blog-write has an agent edge -> stays individual. blog-outline has none -> collapses.
  assert.ok(skillNodes.some((n) => n.id === "blog-write"), "ops-connected skill stays as its own node");
  const summary = skillNodes.find((n) => n.type === "skill-summary");
  assert.ok(summary, "non-ops-connected skill collapses into a summary node");
  assert.equal(summary.label, "+1 other skills", "summary label counts the collapsed skills");
  assert.deepEqual(summary.collapsedNames, ["blog-outline"], "summary lists the collapsed skill names");
  assert.equal(layout.columns[4].count, 1, "column count reflects only the individually-shown skill");
}

// --- visibility rule: skill->skill edges alone do NOT make a skill visible ---
{
  const manifest = {
    nodes: [
      { id: "blog-write", type: "skill", label: "blog-write", path: "/skills/blog-write" },
      { id: "blog-outline", type: "skill", label: "blog-outline", path: "/skills/blog-outline" },
      { id: "blog-brief", type: "skill", label: "blog-brief", path: "/skills/blog-brief" },
    ],
    edges: [
      { from: "blog-write", to: "blog-outline", viaType: "skill" },
      { from: "blog-outline", to: "blog-brief", viaType: "skill" },
    ],
  };
  const layout = computeOpsMapLayout(manifest);
  const skillNodes = layout.nodes.filter((n) => n.column === 4);
  assert.equal(skillNodes.length, 1, "skill-pack-only skills all collapse: only the summary node is shown");
  assert.equal(skillNodes[0].type, "skill-summary");
  assert.deepEqual(
    skillNodes[0].collapsedNames,
    ["blog-brief", "blog-outline", "blog-write"],
    "collapsed names sorted alphabetically"
  );
  assert.equal(layout.edges.length, 0, "skill->skill edges among collapsed skills are dropped");
}

// --- edge rule: skill->skill edge drawn only when BOTH endpoints are visible ---
{
  const manifest = {
    nodes: [
      { id: "capture", type: "agent", label: "Capture", path: ".claude/agents/capture.md" },
      { id: "brief", type: "skill", label: "brief", path: "/skills/brief" },
      { id: "scope", type: "skill", label: "scope", path: "/skills/scope" },
      { id: "humanizer", type: "skill", label: "humanizer", path: "/skills/humanizer" },
    ],
    edges: [
      { from: "capture", to: "brief", viaType: "skill" }, // brief visible
      { from: "capture", to: "scope", viaType: "skill" }, // scope visible
      { from: "brief", to: "scope", viaType: "skill" }, // both visible -> kept
      { from: "brief", to: "humanizer", viaType: "skill" }, // humanizer collapses -> dropped
    ],
  };
  const layout = computeOpsMapLayout(manifest);
  const skillIds = layout.nodes.filter((n) => n.column === 4 && n.type === "skill").map((n) => n.id);
  assert.deepEqual(skillIds, ["brief", "scope"], "only ops-connected skills shown individually");
  assert.ok(
    layout.edges.some((e) => e.from === "brief" && e.to === "scope"),
    "skill->skill edge between two visible skills is kept"
  );
  assert.ok(
    !layout.edges.some((e) => e.to === "humanizer" || e.from === "humanizer"),
    "skill->skill edge to a collapsed skill is dropped"
  );
  assert.equal(layout.edges.length, 3, "capture->brief, capture->scope, brief->scope survive");
}

// --- visibility rule: registered skill with ZERO edges still renders individually ---
{
  const manifest = {
    nodes: [
      { id: "vgb-email-router", type: "skill", label: "vgb-email-router", path: "/skills/vgb-email-router", registered: true },
      { id: "blog-audio", type: "skill", label: "blog-audio", path: "/skills/blog-audio" },
    ],
    edges: [],
  };
  const layout = computeOpsMapLayout(manifest);
  const skillNodes = layout.nodes.filter((n) => n.column === 4);
  assert.ok(
    skillNodes.some((n) => n.id === "vgb-email-router" && n.type === "skill"),
    "registered-but-unconnected skill stays visible"
  );
  const summary = skillNodes.find((n) => n.type === "skill-summary");
  assert.ok(summary, "unregistered zero-edge skill still collapses");
  assert.deepEqual(summary.collapsedNames, ["blog-audio"], "only the unregistered skill collapses");
  assert.equal(layout.columns[4].count, 1, "column count includes only the visible skill");
}

// --- collapse rule: all skills without ops edges -> all collapse, none individual ---
{
  const manifest = {
    nodes: [
      { id: "a-skill", type: "skill", label: "a-skill", path: "/skills/a-skill" },
      { id: "b-skill", type: "skill", label: "b-skill", path: "/skills/b-skill" },
    ],
    edges: [],
  };
  const layout = computeOpsMapLayout(manifest);
  const skillNodes = layout.nodes.filter((n) => n.column === 4);
  assert.equal(skillNodes.length, 1, "only the summary node is shown");
  assert.equal(skillNodes[0].type, "skill-summary");
  assert.deepEqual(skillNodes[0].collapsedNames, ["a-skill", "b-skill"], "collapsed names sorted alphabetically");
}

// --- deterministic ordering: nodes sorted by id within column ---
{
  const manifest = {
    nodes: [
      { id: "web-builder", type: "agent", label: "Web Builder", path: ".claude/agents/web-builder.md" },
      { id: "capture", type: "agent", label: "Capture", path: ".claude/agents/capture.md" },
      { id: "recruit", type: "agent", label: "Recruit", path: ".claude/agents/recruit.md" },
    ],
    edges: [],
  };
  const layout = computeOpsMapLayout(manifest);
  const agentIds = layout.nodes.filter((n) => n.column === 0).map((n) => n.id);
  assert.deepEqual(agentIds, ["capture", "recruit", "web-builder"], "agents sorted alphabetically by id, not input order");
}

// --- column headers always present in the fixed order, with correct counts ---
{
  const manifest = {
    nodes: [
      { id: "capture", type: "agent", label: "Capture", path: ".claude/agents/capture.md" },
      { id: "SOP-001-x", type: "sop", label: "SOP-001", path: "Operations/SOPs/SOP-001-x.md" },
    ],
    edges: [],
  };
  const layout = computeOpsMapLayout(manifest);
  assert.deepEqual(
    layout.columns.map((c) => c.type),
    ["agent", "workflow", "sop", "guideline", "skill"],
    "columns always appear left-to-right in the fixed order"
  );
  assert.equal(layout.columns[0].count, 1, "agent column count");
  assert.equal(layout.columns[1].count, 0, "empty workflow column count is 0, not omitted");
  assert.equal(layout.columns[2].count, 1, "sop column count");
}

console.log("opsMapModel: all assertions passed");
