import './testFileTimeout.mjs';
import assert from 'node:assert/strict';
import { computeUsageWindow, usageChartFromWindow, usageFamilyBreakdown, usagePeriodBreakdown } from './model.mjs';
const bucket = (inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd, messages = 1) => ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd, messages });
const days = [
  { date: '2026-09-13', models: { opus: bucket(900, 90, 9, 90, 9), 'openai-codex/gpt-6-astra': bucket(800, 80, 8, 80, 8) }, totalCostUsd: 17, totalOutputTokens: 170 },
  { date: '2026-09-14', models: { opus: bucket(100, 10, 0, 20, 1, 2), 'openai-codex/gpt-6-astra': bucket(200, 20, 2, 30, 2, 3) }, totalCostUsd: 3, totalOutputTokens: 50 },
];
const selected = computeUsageWindow(days, '1d', 0, new Date(2026, 8, 14));
const rows = Object.fromEntries(usageFamilyBreakdown(selected.days).table.map(row => [row.model, row]));
assert.deepEqual({ ...rows.opus, sharePercent: undefined }, { model: 'opus', label: 'Opus', messages: 2, inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 20, totalTokens: 130, costUsd: 1, sharePercent: undefined }, 'Claude normalized selected-range fields retain honest zero cache write');
assert.ok(Math.abs(rows.opus.sharePercent - 100 / 3) < 1e-9, 'Claude cost share follows selected range');
assert.deepEqual({ ...rows['openai-codex/gpt-6-astra'], sharePercent: undefined }, { model: 'openai-codex/gpt-6-astra', label: 'gpt-6-astra', messages: 3, inputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 2, outputTokens: 30, totalTokens: 252, costUsd: 2, sharePercent: undefined }, 'OpenAI has identical normalized fields');
assert.ok(Math.abs(rows['openai-codex/gpt-6-astra'].sharePercent - 200 / 3) < 1e-9);
const chart = usageChartFromWindow(selected.days);
const segment = chart.days[0].segments.find(item => item.model === 'openai-codex/gpt-6-astra');
assert.deepEqual([segment.inputTokens, segment.cacheReadTokens, segment.cacheWriteTokens, segment.outputTokens], [200, 20, 2, 30], 'all actual buckets retained behind column');
assert.equal(chart.days[0].totalFraction, 1, 'single-day geometry uses summed cost');
const popup = usagePeriodBreakdown(chart.days[0], 'tokens');
assert.equal(popup.rows.find(row => row.model === 'opus').amount, '130 tokens', 'one-day popup sums actual buckets including zero cache write');
assert.equal(popup.total, '382 tokens', 'popup counts four buckets across all models');
console.log('usageTokenTransparency.test.mjs: all assertions passed');
