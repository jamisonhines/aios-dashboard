// Tests for the System tab's Agents-section view-model (Phase 3, 2026-08-05).
// Pure functions imported from model.mjs; no Obsidian deps.
// Run: node systemAgentsModel.test.mjs
import assert from "node:assert";
import {
  systemAgentWiredToRows,
  systemAgentRowFromNode,
  computeSystemAgentsView,
  computeAvailableHiresView,
  systemGenericSubagentRowFromUsage,
} from "./model.mjs";

// --- systemGenericSubagentRowFromUsage: plain pass-through, no contract
// fields at all (Dispatch escalation, 2026-08-05) ---
{
  const row = systemGenericSubagentRowFromUsage({
    key: "general-purpose",
    label: "general-purpose",
    costUsd: 1072.53,
    runs: 556,
    avgCostUsd: 1.93,
  });
  assert.deepEqual(row, {
    id: "general-purpose",
    label: "general-purpose",
    costUsd: 1072.53,
    runs: 556,
    avgCostUsd: 1.93,
  });
}
{
  // Missing label falls back to the key, same convention as skills.
  const row = systemGenericSubagentRowFromUsage({ key: "unknown", costUsd: 1, runs: 1, avgCostUsd: 1 });
  assert.equal(row.label, "unknown");
}

// --- systemAgentWiredToRows: splits edges by target type, ignores
// agent-to-agent and guideline edges (the task asks for workflows/SOPs/
// skills only) ---
{
  const nodesById = new Map([
    ["WS-001-daily-journaling", { id: "WS-001-daily-journaling", type: "workflow", label: "Daily journaling", path: "Operations/Workflows/WS-001-daily-journaling.md" }],
    ["SOP-close-task", { id: "SOP-close-task", type: "sop", label: "Close task", path: "Operations/SOPs/SOP-close-task.md" }],
    ["gsd-executor", { id: "gsd-executor", type: "skill", label: "gsd-executor", path: "/skills/gsd-executor", external: true }],
    ["reviewer", { id: "reviewer", type: "agent", label: "Reviewer", path: "Agents/Reviewer/AGENTS.md" }],
    ["GL-001-file-naming-conventions", { id: "GL-001-file-naming-conventions", type: "guideline", label: "Naming", path: "Operations/Guidelines/GL-001-file-naming-conventions.md" }],
  ]);
  const edges = [
    { from: "coder", to: "WS-001-daily-journaling", viaType: "token" },
    { from: "coder", to: "SOP-close-task", viaType: "token" },
    { from: "coder", to: "gsd-executor", viaType: "skill" },
    { from: "coder", to: "reviewer", viaType: "agent" },
    { from: "coder", to: "GL-001-file-naming-conventions", viaType: "token" },
    { from: "reviewer", to: "SOP-close-task", viaType: "token" }, // a different `from` -- must not leak in
  ];
  const rows = systemAgentWiredToRows("coder", edges, nodesById);
  assert.deepEqual(rows.workflows.map((r) => r.id), ["WS-001-daily-journaling"]);
  assert.deepEqual(rows.sops.map((r) => r.id), ["SOP-close-task"], "only coder's own SOP edge, not reviewer's");
  assert.deepEqual(rows.skills.map((r) => r.id), ["gsd-executor"]);
  assert.equal(rows.workflows[0].path, "Operations/Workflows/WS-001-daily-journaling.md", "internal target carries a clickable path");
  assert.equal(rows.skills[0].path, undefined, "external skill target carries no path");
}
{
  // No edges from this agent at all -> all three buckets empty, not a throw.
  const rows = systemAgentWiredToRows("lonely-agent", [], new Map());
  assert.deepEqual(rows, { workflows: [], sops: [], skills: [] });
}
{
  // Sorted alphabetically by label within each bucket.
  const nodesById = new Map([
    ["SOP-write-journal-entry", { id: "SOP-write-journal-entry", type: "sop", label: "Write journal entry", path: "x" }],
    ["SOP-close-task", { id: "SOP-close-task", type: "sop", label: "Close task", path: "y" }],
  ]);
  const edges = [
    { from: "coder", to: "SOP-write-journal-entry", viaType: "token" },
    { from: "coder", to: "SOP-close-task", viaType: "token" },
  ];
  const rows = systemAgentWiredToRows("coder", edges, nodesById);
  assert.deepEqual(rows.sops.map((r) => r.label), ["Close task", "Write journal entry"], "alphabetical, not edge-discovery order");
}

// --- systemAgentRowFromNode: usage join by key, dash-worthy nulls when
// absent, model/description/path pass through ---
{
  const node = {
    id: "coder",
    label: "Coder",
    model: "sonnet",
    description: "Application code, including the backend surface Web Builder disowns.",
    path: "Agents/Coder/AGENTS.md",
  };
  const usageByKey = new Map([["coder", { key: "coder", costUsd: 177.14, runs: 41, avgCostUsd: 4.32 }]]);
  const row = systemAgentRowFromNode(node, [], new Map(), usageByKey);
  assert.equal(row.id, "coder");
  assert.equal(row.model, "sonnet");
  assert.equal(row.costUsd, 177.14);
  assert.equal(row.runs, 41);
  assert.equal(row.avgCostUsd, 4.32);
  assert.equal(row.path, "Agents/Coder/AGENTS.md");
}
{
  // No usage row for this roster agent (e.g. never dispatched as a subagent
  // in the current window) -> null, not zero, not a crash.
  const node = { id: "capture", label: "Capture" };
  const row = systemAgentRowFromNode(node, [], new Map(), new Map());
  assert.equal(row.costUsd, null, "no usage row -> null cost (dash is a render decision)");
  assert.equal(row.runs, null);
  assert.equal(row.avgCostUsd, null);
  assert.equal(row.model, null, "missing model field -> null, not undefined-turned-empty-string");
  assert.equal(row.description, "(no description)", "missing description falls back");
}

// --- computeSystemAgentsView: one row per roster agent node, usage joined,
// non-agent nodes ignored ---
{
  const opsMap = {
    nodes: [
      { id: "capture", type: "agent", label: "Capture", model: "haiku", path: "Agents/Capture/AGENTS.md" },
      { id: "coder", type: "agent", label: "Coder", model: "sonnet", path: "Agents/Coder/AGENTS.md" },
      { id: "gsd-executor", type: "skill", label: "gsd-executor", path: "/skills/gsd-executor" },
    ],
    edges: [{ from: "coder", to: "gsd-executor", viaType: "skill" }],
  };
  const usageStats = {
    agents: [
      { key: "coder", costUsd: 177.14, runs: 41, avgCostUsd: 4.32 },
      // Non-roster: must not appear in `rows` (the roster table), but MUST
      // appear in `genericSubagents` (Dispatch escalation, 2026-08-05) --
      // real spend, no specialist contract behind it.
      { key: "general-purpose", label: "general-purpose", costUsd: 1072.53, runs: 556, avgCostUsd: 1.93 },
      { key: "unknown", label: "unknown", costUsd: 3.5, runs: 2, avgCostUsd: 1.75 },
    ],
  };
  const view = computeSystemAgentsView(opsMap, usageStats);
  assert.equal(view.totalCount, 2, "only agent-type nodes count, the skill node is excluded");
  assert.deepEqual(view.rows.map((r) => r.id), ["capture", "coder"], "one row per roster agent, skill node excluded entirely");
  const coderRow = view.rows.find((r) => r.id === "coder");
  assert.equal(coderRow.costUsd, 177.14, "usage joined by id match");
  assert.equal(coderRow.wiredTo.skills.map((s) => s.id).join(","), "gsd-executor");
  const captureRow = view.rows.find((r) => r.id === "capture");
  assert.equal(captureRow.costUsd, null, "no usage-stats row for capture in this fixture -> null, i.e. a dash");

  assert.equal(view.genericSubagents.length, 2, "both non-roster usage entries land in genericSubagents");
  assert.deepEqual(
    view.genericSubagents.map((r) => r.id),
    ["general-purpose", "unknown"],
    "sorted by cost descending"
  );
  assert.equal(view.genericSubagents[0].costUsd, 1072.53);
  assert.ok(
    Math.abs(view.genericSubagentsCostUsd - (1072.53 + 3.5)) < 1e-9,
    "genericSubagentsCostUsd sums exactly the non-roster rows"
  );
}
{
  const view = computeSystemAgentsView({ nodes: [], edges: [] }, null);
  assert.equal(view.totalCount, 0);
  assert.deepEqual(view.rows, [], "empty ops map and missing usage stats do not throw");
  assert.deepEqual(view.genericSubagents, [], "no usage stats at all -> empty genericSubagents, not a throw");
  assert.equal(view.genericSubagentsCostUsd, 0);
}
{
  // Every usage entry matches a roster agent: genericSubagents is empty, not
  // fabricated.
  const opsMap = {
    nodes: [{ id: "coder", type: "agent", label: "Coder" }],
    edges: [],
  };
  const usageStats = { agents: [{ key: "coder", label: "coder", costUsd: 10, runs: 1, avgCostUsd: 10 }] };
  const view = computeSystemAgentsView(opsMap, usageStats);
  assert.deepEqual(view.genericSubagents, [], "all usage matched to roster -> nothing left over");
}

// --- computeAvailableHiresView: pass-through with a graceful fallback shape
// regardless of whether SOP-001 parsing found a heading ---
{
  const opsMap = {
    nodes: [],
    edges: [],
    availableHires: {
      found: true,
      items: [{ label: "Code team", description: "Coder + Reviewer." }],
      sopId: "SOP-001-how-to-add-a-new-specialist",
      sopPath: "Operations/SOPs/SOP-001-how-to-add-a-new-specialist.md",
    },
  };
  const view = computeAvailableHiresView(opsMap);
  assert.equal(view.found, true);
  assert.equal(view.items.length, 1);
  assert.equal(view.sopPath, "Operations/SOPs/SOP-001-how-to-add-a-new-specialist.md");
}
{
  // No availableHires block at all (older ops-map.json, or a fork's exporter
  // that predates this field) -> graceful fallback shape, not a throw.
  const view = computeAvailableHiresView({ nodes: [], edges: [] });
  assert.equal(view.found, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.sopId, "SOP-001-how-to-add-a-new-specialist", "default sopId even with no data");
}

console.log("systemAgentsModel: all assertions passed");
