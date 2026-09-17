// Focused contract coverage for Usage token transparency. Run: node usageTokenTransparency.test.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { computeUsageWindow, usageChartFromWindow, usageDayFamilyBars, usageFamilyBreakdown } from "./model.mjs";

const bucket = (inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd, messages = 1) => ({
  inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd, messages,
});

// Claude and provider-qualified OpenAI records use the same normalized bucket
// fields, and the breakdown aggregates ONLY the selected window.
{
  const days = [
    { date: "2026-09-13", models: { opus: bucket(900, 90, 9, 90, 9), "openai-codex/gpt-6-astra": bucket(800, 80, 8, 80, 8) }, totalCostUsd: 17, totalOutputTokens: 170 },
    { date: "2026-09-14", models: { opus: bucket(100, 10, 0, 20, 1, 2), "openai-codex/gpt-6-astra": bucket(200, 20, 2, 30, 2, 3) }, totalCostUsd: 3, totalOutputTokens: 50 },
  ];
  const selected = computeUsageWindow(days, "1d", 0, new Date(2026, 8, 14));
  const rows = Object.fromEntries(usageFamilyBreakdown(selected.days).table.map((row) => [row.model, row]));
  assert.deepEqual(
    { ...rows.opus, sharePercent: undefined },
    { model: "opus", family: "opus", label: "Opus", messages: 2, inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 20, costUsd: 1, sharePercent: undefined },
    "Claude row exposes every selected-range bucket; zero cache write remains an honest zero"
  );
  assert.ok(Math.abs(rows.opus.sharePercent - 100 / 3) < 1e-9, "Claude share remains the selected window's cost share");
  assert.deepEqual(
    { ...rows["openai-codex/gpt-6-astra"], sharePercent: undefined },
    { model: "openai-codex/gpt-6-astra", family: "openai-codex-gpt-6-astra", label: "gpt-6-astra", messages: 3, inputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 2, outputTokens: 30, costUsd: 2, sharePercent: undefined },
    "provider-qualified OpenAI row has the identical normalized range-scoped fields"
  );
  assert.ok(Math.abs(rows["openai-codex/gpt-6-astra"].sharePercent - 200 / 3) < 1e-9, "OpenAI share remains the selected window's cost share");
}

// Chart geometry remains cost-only, while each model segment/bar carries its
// real token buckets for the tooltip rather than pretending costs are tokens.
{
  const day = { date: "2026-09-14", models: { opus: bucket(100, 10, 0, 20, 1), "openai-codex/gpt-6-astra": bucket(200, 20, 2, 30, 2) }, totalCostUsd: 3, totalOutputTokens: 50 };
  const segment = usageChartFromWindow([day]).days[0].segments.find((item) => item.model === "openai-codex/gpt-6-astra");
  assert.equal(segment.heightFraction, 2 / 3, "chart segment height is still its cost share of the cost maximum");
  assert.deepEqual(
    { inputTokens: segment.inputTokens, cacheReadTokens: segment.cacheReadTokens, cacheWriteTokens: segment.cacheWriteTokens, outputTokens: segment.outputTokens },
    { inputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 2, outputTokens: 30 },
    "multi-day segment carries all actual buckets for its tooltip"
  );
  const opusBar = usageDayFamilyBars(day).bars.find((item) => item.model === "opus");
  assert.deepEqual(
    { inputTokens: opusBar.inputTokens, cacheReadTokens: opusBar.cacheReadTokens, cacheWriteTokens: opusBar.cacheWriteTokens, outputTokens: opusBar.outputTokens },
    { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 20 },
    "one-day chart bar carries all actual buckets, including zero cache write"
  );
}

// Render contract: tables name all four token columns and both chart tooltip
// paths use the same labeled formatter. This checks the shipped renderer's
// wiring, not a copy of its output.
{
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const table = source.slice(source.indexOf("function renderUsageModelsTable"), source.indexOf("function renderUsageProjectsTable"));
  assert.match(table, /\["Model", "Input", "Cache read", "Cache write", "Output", "Cost", "Share", "Msgs"\]/, "Models table names each token bucket and retains spend/message context");
  assert.match(table, /formatCompactNumber\(row\.cacheWriteTokens\)/, "Models table renders cache writes as their measured count (zero stays 0)");
  assert.ok(
    source.includes("Input ${formatCompactNumber(bucket.inputTokens)} · Cache read ${formatCompactNumber(bucket.cacheReadTokens)} · Cache write ${formatCompactNumber(bucket.cacheWriteTokens)} · Output ${formatCompactNumber(bucket.outputTokens)}"),
    "shared tooltip formatter labels Input, Cache read, Cache write, and Output with actual bucket values"
  );
  const tooltip = source.slice(source.indexOf("function usageDayTooltip"), source.indexOf("function renderUsagePeriodBar"));
  assert.match(tooltip, /formatUsageTokenBreakdown\(s\)/, "multi-day tooltip includes the shared labeled token breakdown");
  assert.match(tooltip, /formatUsageTokenBreakdown\(bar\)/, "one-day tooltip includes the shared labeled token breakdown");
  assert.match(source, /const USAGE_BREAKDOWN_TOTAL_COLUMNS = 9;/, "shared breakdown tables pad to the new common column count, avoiding shifted columns");
}

console.log("usageTokenTransparency.test.mjs: all assertions passed");
