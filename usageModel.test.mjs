// Tests for the Usage-tab data model: computeUsageView, computeWorkflowsView,
// usageWorkflowColorIndex, and formatCompactNumber (pure).
// Imports the SAME module main.ts bundles (model.mjs). Run: node usageModel.test.mjs
import assert from "node:assert";
import {
  formatCompactNumber,
  computeUsageView,
  computeWorkflowsView,
  usageWorkflowColorIndex,
  USAGE_WORKFLOW_COLOR_COUNT,
  computeUsageWindow,
  usageChartFromWindow,
  usageDayFamilyBars,
  formatUsageWindowLabel,
} from "./model.mjs";

// --- formatCompactNumber ---
assert.equal(formatCompactNumber(0), "0", "zero");
assert.equal(formatCompactNumber(999), "999", "below 1k stays plain");
assert.equal(formatCompactNumber(1200), "1.2k", "1.2k");
assert.equal(formatCompactNumber(3400000), "3.4M", "3.4M");
assert.equal(formatCompactNumber(4200000), "4.2M", "4.2M");
assert.equal(formatCompactNumber(1500000000), "1.5B", "1.5B");
assert.equal(formatCompactNumber(-2500), "-2.5k", "negative values keep sign");

// --- tile math: today / 7d / 30d boundaries ---
{
  const now = new Date(2026, 6, 11); // 2026-07-11 local
  const stats = {
    generatedAt: now.toISOString(),
    windowDays: 35,
    days: [
      { date: "2026-07-11", models: { opus: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 5 } }, totalCostUsd: 5, totalOutputTokens: 1 },
      { date: "2026-07-10", models: { opus: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 2 } }, totalCostUsd: 2, totalOutputTokens: 1 },
      { date: "2026-07-05", models: { sonnet: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 3 } }, totalCostUsd: 3, totalOutputTokens: 1 },
      // Outside the 30-day window (2026-06-01 is 40 days before 2026-07-11).
      { date: "2026-06-01", models: { opus: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 100 } }, totalCostUsd: 100, totalOutputTokens: 1 },
    ],
    projects: [],
    totals: { last7DaysCostUsd: 0, last30DaysCostUsd: 0, todayCostUsd: 0 },
  };
  const view = computeUsageView(stats, now);
  assert.equal(view.tiles.todayCostUsd, 5, "today = only today's cost");
  assert.equal(view.tiles.last7DaysCostUsd, 10, "7d = today + 07-10 + 07-05 (within 7 days)");
  assert.equal(view.tiles.last30DaysCostUsd, 10, "30d excludes the 06-01 entry outside the window");
}

// --- stacking math: segment heightFractions sum to the day's totalFraction ---
{
  const now = new Date(2026, 6, 11);
  const stats = {
    generatedAt: now.toISOString(),
    windowDays: 35,
    days: [
      {
        date: "2026-07-11",
        models: {
          opus: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 4 },
          sonnet: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 6 },
        },
        totalCostUsd: 10,
        totalOutputTokens: 2,
      },
    ],
    projects: [],
    totals: { last7DaysCostUsd: 0, last30DaysCostUsd: 0, todayCostUsd: 0 },
  };
  const view = computeUsageView(stats, now);
  const day = view.chart.days.find((d) => d.date === "2026-07-11");
  const sumFractions = day.segments.reduce((s, seg) => s + seg.heightFraction, 0);
  assert.ok(Math.abs(sumFractions - day.totalFraction) < 1e-9, "segment fractions sum to the day total fraction");
  assert.equal(day.segments.length, 2, "both families present as segments");
}

// --- empty-days handling: 30-day window always has 30 entries, gaps are zero-cost ---
{
  const now = new Date(2026, 6, 11);
  const stats = {
    generatedAt: now.toISOString(),
    windowDays: 35,
    days: [
      { date: "2026-07-11", models: { opus: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 1 } }, totalCostUsd: 1, totalOutputTokens: 1 },
    ],
    projects: [],
    totals: { last7DaysCostUsd: 0, last30DaysCostUsd: 0, todayCostUsd: 0 },
  };
  const view = computeUsageView(stats, now);
  assert.equal(view.chart.days.length, 30, "always 30 days in the chart window");
  const gap = view.chart.days.find((d) => d.date === "2026-07-01");
  assert.ok(gap, "a day with no transcript activity is still present");
  assert.equal(gap.totalCostUsd, 0, "gap day has zero cost");
  assert.deepEqual(gap.segments, [], "gap day has no segments");
}

// --- empty stats: no days at all ---
{
  const now = new Date(2026, 6, 11);
  const stats = { generatedAt: now.toISOString(), windowDays: 35, days: [], projects: [], totals: { last7DaysCostUsd: 0, last30DaysCostUsd: 0, todayCostUsd: 0 } };
  const view = computeUsageView(stats, now);
  assert.equal(view.hasData, false, "no days -> hasData false");
  assert.equal(view.chart.days.length, 30, "chart window still fully populated with zero-cost days");
  assert.equal(view.tiles.todayCostUsd, 0, "today cost 0");
  assert.equal(view.chart.maxCost, 0, "maxCost 0 when no data");
}

// --- projects: top 8 by cost, sorted desc ---
{
  const now = new Date(2026, 6, 11);
  const stats = {
    generatedAt: now.toISOString(),
    windowDays: 35,
    days: [],
    projects: Array.from({ length: 10 }, (_, i) => ({ name: "p" + i, costUsd: i, outputTokens: i * 10, messages: i })),
    totals: { last7DaysCostUsd: 0, last30DaysCostUsd: 0, todayCostUsd: 0 },
  };
  const view = computeUsageView(stats, now);
  assert.equal(view.projects.length, 8, "top 8 only");
  assert.equal(view.projects[0].name, "p9", "sorted by cost desc");
  assert.equal(view.projects[7].name, "p2", "8th place is p2 (cost 2)");
}
// --- workflows view model (computeWorkflowsView, imported from model.mjs) ---

// --- missing/empty `workflows` field: hasData false, no rows ---
{
  const view = computeWorkflowsView({ days: [], projects: [], totals: {} });
  assert.equal(view.hasData, false, "missing workflows field -> hasData false");
  assert.deepEqual(view.shareBar, [], "missing workflows field -> empty shareBar");
  assert.deepEqual(view.table, [], "missing workflows field -> empty table");
}
{
  const view = computeWorkflowsView({ days: [], projects: [], workflows: [], totals: {} });
  assert.equal(view.hasData, false, "empty workflows array -> hasData false");
}

// --- share computation: percentages sum to 100 and are proportional to cost ---
{
  const stats = {
    days: [],
    projects: [],
    totals: {},
    workflows: [
      { key: "email-followups", label: "Email follow-ups", costUsd: 75, outputTokens: 100, messages: 10, sessions: 2 },
      { key: "email-router", label: "Email router", costUsd: 25, outputTokens: 50, messages: 5, sessions: 1 },
    ],
  };
  const view = computeWorkflowsView(stats);
  assert.equal(view.hasData, true, "non-empty workflows -> hasData true");
  assert.equal(view.shareBar.length, 2, "one segment per workflow");
  assert.equal(view.shareBar[0].sharePercent, 75, "75/100 -> 75%");
  assert.equal(view.shareBar[1].sharePercent, 25, "25/100 -> 25%");
  const sum = view.shareBar.reduce((s, seg) => s + seg.sharePercent, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, "shares sum to 100%");
  assert.deepEqual(
    view.table.map((r) => r.key),
    ["email-followups", "email-router"],
    "table preserves delivered (exporter-sorted) order"
  );
}

// --- zero-cost workflows: no division-by-zero, shares are 0 not NaN ---
{
  const stats = {
    days: [],
    projects: [],
    totals: {},
    workflows: [
      { key: "interactive", label: "Interactive", costUsd: 0, outputTokens: 0, messages: 0, sessions: 1 },
    ],
  };
  const view = computeWorkflowsView(stats);
  assert.equal(view.shareBar[0].sharePercent, 0, "zero total cost -> 0% share, not NaN");
}

// --- color index: known keys map to fixed stable slots regardless of order ---
{
  assert.equal(usageWorkflowColorIndex("telegram-bridge"), 0, "telegram-bridge -> slot 0");
  assert.equal(usageWorkflowColorIndex("interactive"), 7, "interactive -> slot 7");
  const a = usageWorkflowColorIndex("some-future-workflow");
  const b = usageWorkflowColorIndex("some-future-workflow");
  assert.equal(a, b, "unknown key still gets a stable (deterministic) color across calls");
  assert.ok(a >= 0 && a < USAGE_WORKFLOW_COLOR_COUNT, "fallback color index stays in palette range");
}

// --- computeUsageWindow: range slicing, zero-fill, labels, paging edges ---
{
  const bucket = (cost) => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: cost });
  const day = (date, cost, fam = "opus") => ({ date, models: { [fam]: bucket(cost) }, totalCostUsd: cost, totalOutputTokens: 1 });
  const today = new Date(2026, 6, 14); // 2026-07-14 local
  const days = [
    day("2026-07-14", 5),
    day("2026-07-10", 2),
    day("2026-07-01", 3, "sonnet"),
    day("2026-06-20", 7),
  ];

  // 7D current window: Jul 8 - Jul 14, zero-filled to exactly 7 entries.
  const w7 = computeUsageWindow(days, "7d", 0, today);
  assert.equal(w7.days.length, 7, "7d window has 7 entries");
  assert.equal(w7.days[0].date, "2026-07-08", "7d window starts Jul 8");
  assert.equal(w7.days[6].date, "2026-07-14", "7d window ends today");
  assert.equal(w7.days[6].totalCostUsd, 5, "today's bucket carried through");
  assert.equal(w7.days[1].totalCostUsd, 0, "missing days zero-filled");
  assert.equal(w7.label, "Jul 8 - Jul 14", "multi-day label");
  assert.equal(w7.canNext, false, "no next at offset 0");
  assert.equal(w7.canPrev, true, "earlier data exists -> canPrev");

  // Paging back one 7D window: Jul 1 - Jul 7.
  const w7b = computeUsageWindow(days, "7d", 1, today);
  assert.equal(w7b.days[0].date, "2026-07-01", "offset 1 pages back by window length");
  assert.equal(w7b.days[0].totalCostUsd, 3, "Jul 1 bucket present in prior window");
  assert.equal(w7b.canNext, true, "offset > 0 -> canNext");
  assert.equal(w7b.canPrev, true, "2026-06-20 is before Jul 1 -> canPrev");

  // Past the earliest data day: canPrev goes false.
  const w7c = computeUsageWindow(days, "7d", 4, today); // window Jun 10 - Jun 16
  assert.equal(w7c.canPrev, false, "no data before the window start -> prev disabled");

  // 1D: single-entry slice, single-day label.
  const w1 = computeUsageWindow(days, "1d", 0, today);
  assert.equal(w1.days.length, 1, "1d window has one entry");
  assert.equal(w1.label, "Jul 14", "single-day label has no range dash");
  const w1b = computeUsageWindow(days, "1d", 4, today);
  assert.equal(w1b.days[0].date, "2026-07-10", "1d offset pages one day at a time");

  // 30D spans a month boundary in the label.
  const w30 = computeUsageWindow(days, "30d", 0, today);
  assert.equal(w30.days.length, 30, "30d window has 30 entries");
  assert.equal(w30.label, "Jun 15 - Jul 14", "30d label crosses the month boundary");

  // No data at all: paging fully disabled.
  const wEmpty = computeUsageWindow([], "7d", 0, today);
  assert.equal(wEmpty.canPrev, false, "empty data -> no prev");
  assert.equal(wEmpty.canNext, false, "empty data at offset 0 -> no next");

  // usageChartFromWindow: segment fractions, gridlines, x label density.
  const chart7 = usageChartFromWindow(w7.days);
  assert.equal(chart7.maxCost, 5, "window max cost");
  assert.equal(chart7.days.length, 7, "chart mirrors window length");
  assert.deepEqual(chart7.xLabelIndices, [0, 1, 2, 3, 4, 5, 6], "short windows label every day");
  const segToday = chart7.days[6].segments[0];
  assert.equal(segToday.family, "opus", "segment family");
  assert.equal(segToday.heightFraction, 1, "max-cost day fills the plot");
  const chart30 = usageChartFromWindow(w30.days);
  assert.deepEqual(chart30.xLabelIndices, [0, 7, 14, 21, 28, 29], "long windows label every 7th + last");

  // usageDayFamilyBars: per-family bars for the 1D view.
  const multi = {
    date: "2026-07-14",
    models: { opus: bucket(4), haiku: bucket(1) },
    totalCostUsd: 5,
    totalOutputTokens: 2,
  };
  const dayBars = usageDayFamilyBars(multi);
  assert.equal(dayBars.bars.length, 2, "one bar per active family");
  assert.equal(dayBars.bars[0].family, "opus", "family order follows USAGE_FAMILY_ORDER");
  assert.equal(dayBars.bars[0].fraction, 1, "costliest family fills the plot");
  assert.equal(dayBars.bars[1].fraction, 0.25, "other families scale relative to max");
  assert.equal(dayBars.maxCost, 4, "1d max is the costliest family");
  const emptyBars = usageDayFamilyBars({ date: "2026-07-13", models: {}, totalCostUsd: 0, totalOutputTokens: 0 });
  assert.equal(emptyBars.bars.length, 0, "empty day -> no bars");
  assert.equal(emptyBars.maxCost, 0, "empty day -> zero max");

  // Label helper directly.
  assert.equal(formatUsageWindowLabel("2026-12-28", "2027-01-03"), "Dec 28 - Jan 3", "year boundary label");
}

console.log("usageModel: all assertions passed");
