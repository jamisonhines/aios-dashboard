// Tests for the Today-tab data model (pure): topTasks, intakeBacklogCount,
// automationSummaryText, quickCaptureFileStem, resolveCaptureFileName,
// buildQuickCaptureContent, budgetGuardrail. Imports the SAME module main.ts
// bundles (model.mjs). Run: node todayModel.test.mjs
import assert from "node:assert";
import {
  topTasks,
  intakeBacklogCount,
  automationSummaryText,
  quickCaptureFileStem,
  resolveCaptureFileName,
  buildQuickCaptureContent,
  budgetGuardrail,
} from "./model.mjs";

// --- topTasks ---
{
  const tasks = [
    { title: "done task", status: "done", priority: 1, created: "2026-01-01" },
    { title: "cancelled task", status: "cancelled", priority: 1, created: "2026-01-01" },
    { title: "open low priority", status: "open", priority: 4, created: "2026-01-01" },
    { title: "in-progress p1 older", status: "in-progress", priority: 1, created: "2026-01-01" },
    { title: "open p1 newer", status: "open", priority: 1, created: "2026-01-05" },
    { title: "open unset priority", status: "open", priority: null, created: "2026-01-01" },
  ];
  const top = topTasks(tasks, 3);
  assert.equal(top.length, 3, "limited to 3");
  assert.deepEqual(
    top.map((t) => t.title),
    ["in-progress p1 older", "open p1 newer", "open low priority"],
    "priority asc, then created asc; done/cancelled excluded"
  );
}
{
  // unset priority (-> 5) sorts after any explicit priority, unset created sorts last within a tie.
  const tasks = [
    { title: "no created", status: "open", priority: 2, created: null },
    { title: "has created", status: "open", priority: 2, created: "2026-01-01" },
  ];
  const top = topTasks(tasks, 2);
  assert.deepEqual(top.map((t) => t.title), ["has created", "no created"]);
}
assert.deepEqual(topTasks([], 3), [], "empty input -> empty output");

// --- intakeBacklogCount ---
assert.equal(intakeBacklogCount([]), 0, "no tiles -> 0");
assert.equal(intakeBacklogCount([{ key: "stale-open", count: 9 }]), 0, "no intake tile -> 0");
assert.equal(intakeBacklogCount([{ key: "intake", count: 5 }]), 5, "reads the intake tile's count");

// --- automationSummaryText ---
{
  const view = automationSummaryText({ unknown: 1, error: 1, overdue: 1, running: 2, ok: 7 });
  assert.equal(view.text, "2 failing, 1 overdue, 9 ok", "unknown folds into failing, running folds into ok");
  assert.equal(view.hasFailing, true);
}
{
  const view = automationSummaryText({ unknown: 0, error: 0, overdue: 0, running: 1, ok: 4 });
  assert.equal(view.text, "0 failing, 0 overdue, 5 ok");
  assert.equal(view.hasFailing, false);
}
assert.equal(automationSummaryText(undefined).text, "0 failing, 0 overdue, 0 ok", "missing counts -> all zero");

// --- quickCaptureFileStem ---
{
  const stem = quickCaptureFileStem(new Date(2026, 6, 11, 9, 5)); // July 11 2026, 09:05 local
  assert.equal(stem, "2026-07-11-0905-quick-capture");
}
{
  const stem = quickCaptureFileStem(new Date(2026, 0, 2, 23, 59));
  assert.equal(stem, "2026-01-02-2359-quick-capture");
}

// --- resolveCaptureFileName (collision-safe naming) ---
assert.equal(
  resolveCaptureFileName("2026-07-11-0905-quick-capture", []),
  "2026-07-11-0905-quick-capture",
  "no collision -> base name"
);
assert.equal(
  resolveCaptureFileName("2026-07-11-0905-quick-capture", ["2026-07-11-0905-quick-capture"]),
  "2026-07-11-0905-quick-capture-2",
  "one collision -> -2"
);
assert.equal(
  resolveCaptureFileName("2026-07-11-0905-quick-capture", [
    "2026-07-11-0905-quick-capture",
    "2026-07-11-0905-quick-capture-2",
  ]),
  "2026-07-11-0905-quick-capture-3",
  "two collisions -> -3"
);
assert.equal(
  resolveCaptureFileName("stem", ["stem", "stem-2", "stem-4"]),
  "stem-3",
  "fills the first free gap, not the max+1"
);

// --- buildQuickCaptureContent ---
{
  const content = buildQuickCaptureContent("  call the vet  ", "2026-07-11T09:05:00Z");
  assert.equal(content, "---\ncaptured: 2026-07-11T09:05:00Z\n---\n\ncall the vet\n", "trims body, stamps captured");
}

// --- budgetGuardrail ---
assert.equal(budgetGuardrail(5, 0), null, "budget off (0) -> null");
assert.equal(budgetGuardrail(5, -1), null, "negative budget -> null (off)");
assert.equal(budgetGuardrail(4, 10), null, "under budget -> null");
assert.equal(budgetGuardrail(10, 10), null, "exactly at budget -> null (not over)");
{
  const g = budgetGuardrail(12.5, 10);
  assert.ok(g, "over budget -> triggered");
  assert.equal(g.message, "Today $12.50 of $10.00 budget (API-equivalent)");
}

console.log("todayModel.test.mjs: all assertions passed");
