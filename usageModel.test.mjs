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
  computeSkillsView,
  USAGE_SKILLS_TOP_N,
  computeWorkflowSpikes,
  SPIKE_MIN_RECENT_COST_USD,
  SPIKE_MIN_SHARE_INCREASE_PP,
  SPIKE_MIN_SHARE_MULTIPLIER,
  USAGE_RANGE_LABELS,
  usageFamilyBreakdown,
  computeUsageRangeTiles,
  computeWorkflowsViewForRange,
  computeSkillsViewForRange,
  usageScopedRangeLabel,
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

// --- computeSkillsView (build 2.9): top-N collapse + show-more ---
{
  const mkSkills = (n) =>
    Array.from({ length: n }, (_, i) => ({
      key: "skill-" + i,
      label: "skill-" + i,
      costUsd: 100 - i,
      outputTokens: 1000,
      messages: 10,
      runs: 2,
      avgCostUsd: (100 - i) / 2,
    }));

  // Missing/empty skills (JSON written before build 2.9) hides the section.
  assert.equal(computeSkillsView({}, false).hasData, false, "missing skills -> no section");
  assert.equal(computeSkillsView({ skills: [] }, false).hasData, false, "empty skills -> no section");

  // Collapsed: exactly TOP_N rows, remainder counted for the button label.
  const collapsed = computeSkillsView({ skills: mkSkills(9) }, false);
  assert.equal(collapsed.hasData, true, "skills present -> section renders");
  assert.equal(collapsed.rows.length, USAGE_SKILLS_TOP_N, "collapsed shows exactly the top N");
  assert.equal(collapsed.rows[0].key, "skill-0", "exporter order (cost desc) is preserved");
  assert.equal(collapsed.hiddenCount, 4, "hiddenCount drives the show-more label");
  assert.equal(collapsed.totalCount, 9, "totalCount reports the full set");

  // Expanded: everything, nothing hidden.
  const expanded = computeSkillsView({ skills: mkSkills(9) }, true);
  assert.equal(expanded.rows.length, 9, "expanded shows all rows");
  assert.equal(expanded.hiddenCount, 0, "expanded hides nothing");
  assert.equal(expanded.expanded, true, "expanded flag flips the button to Show less");

  // Fewer than TOP_N: no button (hiddenCount 0) and no padding.
  const few = computeSkillsView({ skills: mkSkills(3) }, false);
  assert.equal(few.rows.length, 3, "short list renders in full");
  assert.equal(few.hiddenCount, 0, "short list hides the show-more button");
}

// --- computeWorkflowSpikes: share-of-spend spike detection (build 2.9 slice 3) ---
{
  const now = new Date(2026, 6, 28); // 2026-07-28 local; recent = Jul22-28, baseline = Jun24-Jul21

  const byDay = (entries) => {
    const o = {};
    for (const [dayKey, costUsd] of entries) o[dayKey] = { costUsd, outputTokens: 0, messages: 1 };
    return o;
  };

  // wf-a: baseline $5 (5% of $100 baseline total), recent $30 (60% of $50
  // recent total) -- a clear, material spike (delta 55pp, 12x multiplier).
  // wf-b: baseline $95 (95%), recent $20 (40%) -- share DROPPED, must be silent.
  // wf-new: no baseline cost at all, $2 recent -- flagged "new", not a spike.
  // wf-noise: recent cost is below the absolute floor even though its share
  // would technically triple -- must be silent (the $0.02 -> $0.10 case from spec).
  // wf-flat: same share both periods -- must be silent.
  const stats = {
    workflows: [
      { key: "wf-a", label: "Workflow A", byDay: byDay([["2026-07-10", 5], ["2026-07-25", 30]]) },
      { key: "wf-b", label: "Workflow B", byDay: byDay([["2026-07-10", 95], ["2026-07-25", 20]]) },
      { key: "wf-new", label: "New workflow", byDay: byDay([["2026-07-25", 2]]) },
      { key: "wf-noise", label: "Noisy workflow", byDay: byDay([["2026-07-10", 0.02], ["2026-07-25", 0.1]]) },
      { key: "wf-flat", label: "Flat workflow", byDay: byDay([["2026-07-10", 10], ["2026-07-25", 5]]) },
    ],
  };

  const alerts = computeWorkflowSpikes(stats, now);
  const byKey = Object.fromEntries(alerts.map((a) => [a.key, a]));

  assert.ok(byKey["wf-a"], "wf-a's material share increase is flagged");
  assert.equal(byKey["wf-a"].kind, "spike", "wf-a is a spike, not new");
  assert.ok(
    byKey["wf-a"].recentSharePercent - byKey["wf-a"].baselineSharePercent >= SPIKE_MIN_SHARE_INCREASE_PP,
    "flagged delta clears the percentage-point floor"
  );

  assert.ok(byKey["wf-new"], "a workflow with zero prior-28d cost is flagged");
  assert.equal(byKey["wf-new"].kind, "new", "no-baseline case reports kind 'new', not a spike percentage");

  assert.equal(byKey["wf-b"], undefined, "a workflow whose share fell is never flagged");
  assert.equal(byKey["wf-noise"], undefined, "below the absolute-cost floor stays silent even if share tripled");
  assert.equal(byKey["wf-flat"], undefined, "an unchanged share is not a spike");

  assert.equal(alerts.length, 2, "exactly the two qualifying workflows are reported");
  assert.equal(alerts[0].key, "wf-a", "alerts sort by recentCostUsd desc");

  // Degrades gracefully: no workflows, empty array, and missing byDay all
  // produce an empty alert list rather than throwing.
  assert.deepEqual(computeWorkflowSpikes({}, now), [], "missing workflows -> no alerts");
  assert.deepEqual(computeWorkflowSpikes({ workflows: [] }, now), [], "empty workflows -> no alerts");
  assert.deepEqual(
    computeWorkflowSpikes({ workflows: [{ key: "old", label: "Old-shape entry" }] }, now),
    [],
    "a workflow entry with no byDay (pre-slice-2 JSON) contributes zero cost, never flags"
  );

  // Sanity-check the exported thresholds are the documented values, since the
  // test above depends on them.
  assert.equal(SPIKE_MIN_RECENT_COST_USD, 1.0);
  assert.equal(SPIKE_MIN_SHARE_INCREASE_PP, 10);
  assert.equal(SPIKE_MIN_SHARE_MULTIPLIER, 1.5);
}

// --- computeUsageWindow: "all" range (Phase 1 System-browser range toggle,
// 2026-08-04) ---
{
  const bucket = (cost) => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: cost });
  const day = (date, cost) => ({ date, models: { opus: bucket(cost) }, totalCostUsd: cost, totalOutputTokens: 1 });
  const today = new Date(2026, 6, 14); // 2026-07-14 local

  const days = [day("2026-07-14", 5), day("2026-07-10", 2), day("2026-06-20", 7)];
  const wAll = computeUsageWindow(days, "all", 0, today);
  assert.equal(wAll.days[0].date, "2026-06-20", "all: window starts at the earliest day present");
  assert.equal(wAll.days[wAll.days.length - 1].date, "2026-07-14", "all: window ends today");
  assert.equal(wAll.days.length, 25, "all: continuous zero-filled span, Jun 20 - Jul 14 inclusive");
  assert.equal(wAll.canPrev, false, "all: paging always disabled");
  assert.equal(wAll.canNext, false, "all: paging always disabled");
  assert.equal(wAll.offset, 0, "all: offset always resets to 0 regardless of what was passed in");
  const wAllPaged = computeUsageWindow(days, "all", 3, today);
  assert.equal(wAllPaged.days[0].date, "2026-06-20", "all: offset is ignored entirely");

  // No data at all: falls back to a single-day window (today), same
  // graceful-degradation shape as the other ranges' empty-data case.
  const wAllEmpty = computeUsageWindow([], "all", 0, today);
  assert.equal(wAllEmpty.days.length, 1, "all with no data: single-day fallback");
  assert.equal(wAllEmpty.days[0].date, "2026-07-14", "all with no data: fallback day is today");
  assert.equal(wAllEmpty.canPrev, false, "all with no data: still no paging");
}

// --- USAGE_RANGE_LABELS: sticky-header human labels ---
{
  assert.equal(USAGE_RANGE_LABELS["1d"], "Today");
  assert.equal(USAGE_RANGE_LABELS["7d"], "Last 7 days");
  assert.equal(USAGE_RANGE_LABELS["30d"], "Last 30 days");
  assert.equal(USAGE_RANGE_LABELS.all, "All available");
}

// --- usageFamilyBreakdown: extracted helper matches computeUsageView's old
// inline behavior exactly (regression guard for the refactor) ---
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
          sonnet: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: 6 },
        },
        totalCostUsd: 10,
        totalOutputTokens: 4,
      },
    ],
    projects: [],
    totals: { last7DaysCostUsd: 0, last30DaysCostUsd: 0, todayCostUsd: 0 },
  };
  const view = computeUsageView(stats, now);
  // Same window computeUsageView builds internally: only 2026-07-11 has
  // real data, the other 29 days are zero-cost placeholders and contribute
  // nothing to the family totals either way.
  const direct = usageFamilyBreakdown(stats.days);
  assert.deepEqual(direct.legend, view.legend, "usageFamilyBreakdown legend matches computeUsageView's");
  assert.deepEqual(direct.table, view.table, "usageFamilyBreakdown table matches computeUsageView's");
}

// --- usageFamilyBreakdown: sharePercent (System-browser header/tabs
// restructure, 2026-08 -- feeds the Usage tab's "Models" breakdown table's
// Share column) ---
{
  const bucket = (cost) => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 1, costUsd: cost });
  const day = {
    date: "2026-08-01",
    models: { opus: bucket(3), sonnet: bucket(1) },
    totalCostUsd: 4,
    totalOutputTokens: 2,
  };
  const { table } = usageFamilyBreakdown([day]);
  const opusRow = table.find((r) => r.family === "opus");
  const sonnetRow = table.find((r) => r.family === "sonnet");
  assert.equal(opusRow.sharePercent, 75, "3 of 4 total cost");
  assert.equal(sonnetRow.sharePercent, 25, "1 of 4 total cost");
}
{
  // Zero-cost window: sharePercent is 0 for every row, not NaN/Infinity.
  const zeroBucket = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 0, costUsd: 0 };
  const day = { date: "2026-08-01", models: { opus: zeroBucket }, totalCostUsd: 0, totalOutputTokens: 0 };
  const { table } = usageFamilyBreakdown([day]);
  assert.equal(table[0].sharePercent, 0, "no spend -> 0%, not NaN");
}

// --- computeUsageRangeTiles: sums cost/tokens over an arbitrary window ---
{
  const windowDays = [
    { date: "2026-07-12", totalCostUsd: 2, totalOutputTokens: 100 },
    { date: "2026-07-13", totalCostUsd: 0, totalOutputTokens: 0 },
    { date: "2026-07-14", totalCostUsd: 5, totalOutputTokens: 900 },
  ];
  const tiles = computeUsageRangeTiles(windowDays, "Last 7 days");
  assert.equal(tiles.rangeLabel, "Last 7 days", "rangeLabel passes through unchanged");
  assert.equal(tiles.costUsd, 7, "cost sums across the window");
  assert.equal(tiles.outputTokens, 1000, "output tokens sum across the window");
  assert.equal(tiles.outputTokensCompact, "1.0k", "compact formatting applied");

  const empty = computeUsageRangeTiles([], "Today");
  assert.equal(empty.costUsd, 0, "empty window -> zero cost, no throw");
}

// --- computeWorkflowsViewForRange: recomputes from byDay over a window ---
{
  const windowDays = [
    { date: "2026-07-08" }, { date: "2026-07-09" }, { date: "2026-07-10" },
    { date: "2026-07-11" }, { date: "2026-07-12" }, { date: "2026-07-13" }, { date: "2026-07-14" },
  ];
  const stats = {
    workflows: [
      {
        key: "interactive",
        label: "Interactive",
        costUsd: 100,
        outputTokens: 5000,
        messages: 50,
        sessions: 10,
        byDay: {
          "2026-07-01": { costUsd: 80, outputTokens: 4000, messages: 40, sessions: 8 }, // outside the 7d window
          "2026-07-10": { costUsd: 15, outputTokens: 700, messages: 7, sessions: 1 },
          "2026-07-14": { costUsd: 5, outputTokens: 300, messages: 3, sessions: 1 },
        },
      },
      {
        // No activity at all inside the window -> dropped from range-scoped rows.
        key: "email-router",
        label: "Email router",
        costUsd: 20,
        outputTokens: 500,
        messages: 5,
        sessions: 2,
        byDay: { "2026-06-01": { costUsd: 20, outputTokens: 500, messages: 5, sessions: 2 } },
      },
      {
        // Pre-slice-2 shape: no byDay at all -> shown as a partial/all-time row.
        key: "legacy-workflow",
        label: "Legacy workflow",
        costUsd: 9,
        outputTokens: 90,
        messages: 9,
        sessions: 3,
      },
    ],
  };

  const view = computeWorkflowsViewForRange(stats, windowDays, "7d");
  assert.equal(view.hasData, true, "at least one row survives -> hasData true");
  const byKey = Object.fromEntries(view.table.map((r) => [r.key, r]));

  assert.equal(byKey.interactive.costUsd, 20, "interactive: only the two in-window days sum (15 + 5), not the full $100");
  assert.equal(byKey.interactive.sessions, 2, "interactive: sessions sum from byDay, not the all-time total of 10");
  assert.equal(byKey["email-router"], undefined, "email-router has zero activity in-window -> dropped entirely");
  assert.ok(byKey["legacy-workflow"], "legacy-workflow (no byDay) still appears");
  assert.equal(byKey["legacy-workflow"].costUsd, 9, "legacy-workflow falls back to its all-time total");
  assert.equal(byKey["legacy-workflow"].partial, true, "legacy-workflow is flagged partial so the caller can label it honestly");
  assert.equal(byKey.interactive.partial, false, "a workflow with real byDay data is never flagged partial");
  assert.equal(view.table.length, 2, "exactly the two rows with in-window (or unscoped) activity survive");
}

// Sort order over range-scoped totals (byDay-derived cost, not the all-time total).
{
  const windowDays = [{ date: "2026-07-14" }];
  const stats = {
    workflows: [
      { key: "big", label: "Big", costUsd: 1, outputTokens: 0, messages: 0, sessions: 0, byDay: { "2026-07-14": { costUsd: 20, outputTokens: 0, messages: 1, sessions: 1 } } },
      { key: "small", label: "Small", costUsd: 1, outputTokens: 0, messages: 0, sessions: 0, byDay: { "2026-07-14": { costUsd: 5, outputTokens: 0, messages: 1, sessions: 1 } } },
    ],
  };
  const view = computeWorkflowsViewForRange(stats, windowDays, "1d");
  assert.deepEqual(view.table.map((r) => r.key), ["big", "small"], "range-scoped rows sort by their scoped cost desc");

  const sumShares = view.shareBar.reduce((s, seg) => s + seg.sharePercent, 0);
  assert.ok(Math.abs(sumShares - 100) < 1e-9, "shares still sum to 100% over the range-scoped totals");

  // Missing/empty workflows: unchanged hasData:false contract.
  assert.equal(computeWorkflowsViewForRange({}, windowDays, "1d").hasData, false);
  assert.equal(computeWorkflowsViewForRange({ workflows: [] }, windowDays, "1d").hasData, false);
}

// --- computeSkillsViewForRange: recomputes from byDay over a window;
// section-level fallback when byDay is missing on ANY skill ---
{
  const windowDays = [
    { date: "2026-07-08" }, { date: "2026-07-09" }, { date: "2026-07-10" },
    { date: "2026-07-11" }, { date: "2026-07-12" }, { date: "2026-07-13" }, { date: "2026-07-14" },
  ];

  // All skills have byDay -> range-scoped recompute.
  const statsSupported = {
    skills: [
      {
        key: "close-session",
        label: "close-session",
        costUsd: 10,
        outputTokens: 1000,
        messages: 10,
        runs: 5,
        avgCostUsd: 2,
        byDay: {
          "2026-07-01": { costUsd: 8, outputTokens: 800, messages: 8, runs: 4 }, // outside window
          "2026-07-12": { costUsd: 2, outputTokens: 200, messages: 2, runs: 1 },
        },
      },
    ],
  };
  const supported = computeSkillsViewForRange(statsSupported, windowDays, "7d", false);
  assert.equal(supported.rangeSupported, true, "every skill has byDay -> range-scoped");
  assert.equal(supported.rows[0].costUsd, 2, "recomputed from the in-window day only");
  assert.equal(supported.rows[0].runs, 1, "runs recomputed from byDay, not the all-time total of 5");
  assert.equal(supported.rows[0].avgCostUsd, 2, "avg recomputed as costUsd/runs for the window");

  // "all" range always uses full totals even when byDay is present (there's
  // nothing to scope out).
  const allRange = computeSkillsViewForRange(statsSupported, windowDays, "all", false);
  assert.equal(allRange.rows[0].costUsd, 10, "'all' range shows the full all-time total");

  // A skill missing byDay (pre-Phase-1 JSON) -> whole section falls back.
  const statsMixed = {
    skills: [
      { ...statsSupported.skills[0] },
      { key: "old-skill", label: "old-skill", costUsd: 3, outputTokens: 300, messages: 3, runs: 1, avgCostUsd: 3 },
    ],
  };
  const mixed = computeSkillsViewForRange(statsMixed, windowDays, "7d", false);
  assert.equal(mixed.rangeSupported, false, "one skill missing byDay -> whole section falls back");
  const mixedByKey = Object.fromEntries(mixed.rows.map((r) => [r.key, r]));
  assert.equal(mixedByKey["close-session"].costUsd, 10, "fallback shows all-time totals, not the range-scoped $2");

  // Missing/empty skills: unchanged hasData:false contract.
  assert.equal(computeSkillsViewForRange({}, windowDays, "7d", false).hasData, false);
  assert.equal(computeSkillsViewForRange({ skills: [] }, windowDays, "7d", false).hasData, false);

  // Top-N collapse still applies to the range-scoped rows.
  const many = {
    skills: Array.from({ length: 9 }, (_, i) => ({
      key: "s" + i,
      label: "s" + i,
      costUsd: 9 - i,
      outputTokens: 0,
      messages: 0,
      runs: 1,
      avgCostUsd: 9 - i,
      byDay: { "2026-07-14": { costUsd: 9 - i, outputTokens: 0, messages: 0, runs: 1 } },
    })),
  };
  const collapsed = computeSkillsViewForRange(many, windowDays, "7d", false);
  assert.equal(collapsed.rows.length, USAGE_SKILLS_TOP_N, "collapsed shows exactly the top N even after range-scoping");
  assert.equal(collapsed.hiddenCount, 4, "hiddenCount reflects the range-scoped total, not the raw skills.length");
}

// --- Reviewer M3 regression (2026-08-04): computeWorkflowsViewForRange must
// not silently zero the Runs column when byDay exists but its day buckets
// lack a `sessions` key -- exactly the shape Jaymo's LIVE
// Operations/usage/usage-stats.json has right now (byDay written before
// this Phase 1 slice added per-day session folding). Cost/tokens/messages
// ARE genuinely scoped from real byDay data; only Runs falls back, and only
// Runs gets flagged partial. ---
{
  const windowDays = [
    { date: "2026-07-08" }, { date: "2026-07-09" }, { date: "2026-07-10" },
    { date: "2026-07-11" }, { date: "2026-07-12" }, { date: "2026-07-13" }, { date: "2026-07-14" },
  ];
  const stats = {
    workflows: [
      {
        key: "interactive",
        label: "Interactive",
        costUsd: 9422.49,
        outputTokens: 500000,
        messages: 6000,
        sessions: 180,
        // Pre-Phase-1 byDay shape: cost/outputTokens/messages present, no
        // `sessions` field on any day bucket at all (matches the live file).
        byDay: {
          "2026-07-10": { costUsd: 20, outputTokens: 700, messages: 7 },
          "2026-07-14": { costUsd: 5, outputTokens: 300, messages: 3 },
        },
      },
    ],
  };

  const view = computeWorkflowsViewForRange(stats, windowDays, "7d");
  const row = view.table[0];
  assert.equal(row.costUsd, 25, "cost still scopes correctly from real byDay data (20 + 5)");
  assert.equal(row.messages, 10, "messages still scope correctly (7 + 3)");
  assert.notEqual(row.sessions, 0, "Runs must NOT silently zero out just because byDay lacks a sessions key");
  assert.equal(row.sessions, 180, "Runs falls back to the workflow's all-time session count, honestly");
  assert.equal(row.sessionsPartial, true, "the row is flagged so the caller can label the Runs column honestly");
  assert.equal(row.partial, false, "cost/tokens/messages are real range-scoped data -- the WHOLE row is not partial");

  // A workflow with real per-day sessions data is unaffected (not flagged).
  const statsWithSessions = {
    workflows: [
      {
        key: "email-router",
        label: "Email router",
        costUsd: 50,
        outputTokens: 1000,
        messages: 20,
        sessions: 4,
        byDay: {
          "2026-07-10": { costUsd: 50, outputTokens: 1000, messages: 20, sessions: 4 },
        },
      },
    ],
  };
  const viewWithSessions = computeWorkflowsViewForRange(statsWithSessions, windowDays, "7d");
  assert.equal(viewWithSessions.table[0].sessionsPartial, false, "real per-day sessions data -> not flagged partial");
  assert.equal(viewWithSessions.table[0].sessions, 4, "real per-day sessions data is used as-is, not the all-time fallback");

  // A workflow with zero in-window cost/messages is still dropped even
  // though its sessions fallback would be a nonzero all-time count (the
  // zero-activity check must not be fooled by the fallback).
  const statsZeroActivity = {
    workflows: [
      {
        key: "idle",
        label: "Idle",
        costUsd: 30,
        outputTokens: 300,
        messages: 3,
        sessions: 3,
        byDay: { "2026-06-01": { costUsd: 30, outputTokens: 300, messages: 3 } }, // outside the 7d window
      },
    ],
  };
  const viewZeroActivity = computeWorkflowsViewForRange(statsZeroActivity, windowDays, "7d");
  assert.equal(viewZeroActivity.table.length, 0, "zero in-window activity is still dropped despite the sessions fallback");
}

// --- Reviewer M4 regression (2026-08-04): usageScopedRangeLabel must not
// claim a period name ("Last 7 days", "Today") once paging has moved the
// window away from the one ending today -- it should fall back to the
// window's own concrete date-range label instead. ---
{
  // offset 0: the human label is accurate for every range.
  assert.equal(usageScopedRangeLabel({ range: "7d", offset: 0, label: "Jul 8 - Jul 14" }), "Last 7 days");
  assert.equal(usageScopedRangeLabel({ range: "1d", offset: 0, label: "Jul 14" }), "Today");
  assert.equal(usageScopedRangeLabel({ range: "30d", offset: 0, label: "Jun 15 - Jul 14" }), "Last 30 days");
  assert.equal(usageScopedRangeLabel({ range: "all", offset: 0, label: "Jun 20 - Jul 14" }), "All available");

  // offset != 0: "Last 7 days" / "Today" would be wrong -- fall back to the
  // window's concrete date range instead of a stale period name.
  assert.equal(
    usageScopedRangeLabel({ range: "7d", offset: 1, label: "Jul 1 - Jul 7" }),
    "Jul 1 - Jul 7",
    "paged-back 7d window shows its real date range, not 'Last 7 days'"
  );
  assert.equal(
    usageScopedRangeLabel({ range: "1d", offset: 3, label: "Jul 11" }),
    "Jul 11",
    "paged-back 1d window shows its real date, not 'Today'"
  );
  assert.equal(
    usageScopedRangeLabel({ range: "30d", offset: 2, label: "Apr 17 - May 16" }),
    "Apr 17 - May 16",
    "paged-back 30d window shows its real date range, not 'Last 30 days'"
  );

  // "all" never pages (computeUsageWindow always returns offset: 0 for it),
  // so it's included above at offset 0 only -- there is no offset != 0 case
  // to regress.
}

console.log("usageModel: all assertions passed");
