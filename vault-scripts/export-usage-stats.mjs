#!/usr/bin/env node
// Export token-usage/cost stats from Claude Code session transcripts into
// <vaultRoot>/Operations/usage/usage-stats.json for the aios-dashboard Usage tab.
// Usage: node export-usage-stats.mjs [vaultRoot]
//
// Canonical home: the aios-dashboard repo (vault-scripts/). deploy.sh copies
// this file into <vault>/Operations/scripts/. Pure parts (workflow classifier
// + rule table, content extraction) are exported so the repo test suite
// (exportUsageWorkflows.test.mjs) imports the REAL functions instead of
// keeping a hand-synced mirror. Importing this module never starts a scan:
// the script body only runs on direct execution (see the guard at the bottom).
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const WINDOW_DAYS = 35;

// Per-Mtok rates: { in, out }. Cache read bills at 0.1x input rate, cache write at 1.25x input rate.
export const RATES = {
  fable: { in: 10, out: 50 },
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
  other: { in: 5, out: 25 },
};

export function modelFamily(model) {
  const m = model.toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

export function estimateCost(family, usage) {
  const rate = RATES[family] || RATES.other;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cost =
    input * rate.in +
    output * rate.out +
    cacheRead * 0.1 * rate.in +
    cacheWrite * 1.25 * rate.in;
  return cost / 1e6;
}

export function prettifyProject(folderName) {
  if (folderName === "-Users-jaymo") return "home";
  const prefix = "-Users-jaymo-";
  return folderName.startsWith(prefix) ? folderName.slice(prefix.length) : folderName;
}

export function localDay(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function findTranscripts(root, cutoffMs) {
  const files = [];
  let projectDirs;
  try {
    projectDirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(root, entry.name);
    let children;
    try {
      children = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectPath, child.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs >= cutoffMs) {
          files.push({ filePath, project: entry.name });
        }
      } catch {
        // Ignore unreadable files.
      }
    }
  }
  return files;
}

// Content may be a plain string or an array of content blocks; join the
// `text` fields of any blocks that have one. Only the first ~500 chars are
// needed downstream, but we return the full joined string here and let the
// caller trim.
export function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

export const FIRST_COMMAND_RE = /<command-name>(\/[\w-]+)<\/command-name>/;

// Single pass over the transcript: collects usage entries AND the two extra
// classification signals (firstUserContent, firstCommand) with no second pass.
async function parseTranscript(filePath) {
  const entries = [];
  let firstUserContent;
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (firstUserContent === undefined && obj?.type === "user") {
      firstUserContent = extractTextContent(obj.message?.content).slice(0, 500);
    }
    const usage = obj?.message?.usage;
    if (!usage) continue;
    const model = obj.message?.model;
    if (!model || model === "<synthetic>") continue;
    const timestamp = obj.timestamp;
    if (!timestamp) continue;
    entries.push({
      timestamp,
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    });
  }
  if (firstUserContent === undefined) firstUserContent = "";
  const firstCommandMatch = FIRST_COMMAND_RE.exec(firstUserContent);
  const firstCommand = firstCommandMatch ? firstCommandMatch[1] : undefined;
  return { entries, firstUserContent, firstCommand };
}

// Bridge session ids: values of ~/.aios/bridge/data/sessions.json (chatId -> session uuid).
// Only marks CURRENT bridge sessions (the file only holds the latest mapping per chat,
// not history) -- accepted tradeoff, see spec.
async function loadBridgeSessionIds() {
  const bridgePath = path.join(os.homedir(), ".aios", "bridge", "data", "sessions.json");
  try {
    const raw = await fs.readFile(bridgePath, "utf8");
    const obj = JSON.parse(raw);
    return new Set(Object.values(obj));
  } catch {
    return new Set();
  }
}

// Data-driven classification rules, evaluated in order; first match wins.
// ctx = { project, sessionId, firstCommand, firstUserContent }.
// Kept as a plain array so adding a new automation later is a one-line change.
export function buildWorkflowRules(bridgeSessionIds) {
  return [
    {
      key: "telegram-bridge",
      label: "Telegram bridge",
      match: (ctx) => bridgeSessionIds.has(ctx.sessionId),
    },
    {
      key: "telegram-ingest",
      label: "Telegram ingest (WS-004)",
      match: (ctx) =>
        ctx.firstUserContent.startsWith("Run WS-004") ||
        ctx.firstUserContent.includes("ingest-and-upgrade"),
    },
    {
      key: "email-router",
      label: "Email router",
      match: (ctx) => ctx.firstCommand === "/vgb-email-router",
    },
    {
      key: "email-followups",
      label: "Email follow-ups",
      match: (ctx) => ctx.firstCommand === "/vgb-draft-followup",
    },
    {
      key: "email-postmortem",
      label: "Email postmortem",
      match: (ctx) => ctx.firstCommand === "/vgb-draft-postmortem",
    },
    {
      key: "email-other",
      label: "Email automation (other)",
      match: (ctx) => typeof ctx.firstCommand === "string" && ctx.firstCommand.startsWith("/vgb-"),
    },
    {
      key: "learning-scan",
      label: "Learning scan",
      match: (ctx) => ctx.project.endsWith("Operations-learning-scan"),
    },
    {
      key: "interactive",
      label: "Interactive",
      match: () => true,
    },
  ];
}

export function classifyWorkflow(rules, ctx) {
  for (const rule of rules) {
    if (rule.match(ctx)) return rule;
  }
  return rules[rules.length - 1];
}

async function main() {
  const vaultRoot = process.argv[2] || process.cwd();
  const outDir = path.join(vaultRoot, "Operations", "usage");
  const outFile = path.join(outDir, "usage-stats.json");
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");

  const now = new Date();
  const cutoffMs = now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const transcripts = await findTranscripts(projectsRoot, cutoffMs);
  const bridgeSessionIds = await loadBridgeSessionIds();
  const workflowRules = buildWorkflowRules(bridgeSessionIds);

  // dayKey -> family -> { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, messages, costUsd }
  const days = new Map();
  // projectName -> { costUsd, outputTokens, messages }
  const projects = new Map();
  // workflowKey -> { label, costUsd, outputTokens, messages, sessions }
  const workflows = new Map();

  for (const { filePath, project } of transcripts) {
    const { entries, firstUserContent, firstCommand } = await parseTranscript(filePath);
    const projectName = prettifyProject(project);
    const sessionId = path.basename(filePath, ".jsonl");
    const rule = classifyWorkflow(workflowRules, {
      project: projectName,
      sessionId,
      firstCommand,
      firstUserContent,
    });

    if (!workflows.has(rule.key)) {
      workflows.set(rule.key, {
        label: rule.label,
        costUsd: 0,
        outputTokens: 0,
        messages: 0,
        sessions: 0,
      });
    }
    const w = workflows.get(rule.key);
    w.sessions += 1;

    for (const e of entries) {
      const family = modelFamily(e.model);
      const cost = estimateCost(family, e);
      const dayKey = localDay(e.timestamp);

      if (!days.has(dayKey)) days.set(dayKey, {});
      const dayModels = days.get(dayKey);
      if (!dayModels[family]) {
        dayModels[family] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          messages: 0,
          costUsd: 0,
        };
      }
      const bucket = dayModels[family];
      bucket.inputTokens += e.input_tokens;
      bucket.outputTokens += e.output_tokens;
      bucket.cacheReadTokens += e.cache_read_input_tokens;
      bucket.cacheWriteTokens += e.cache_creation_input_tokens;
      bucket.messages += 1;
      bucket.costUsd += cost;

      if (!projects.has(projectName)) {
        projects.set(projectName, { costUsd: 0, outputTokens: 0, messages: 0 });
      }
      const p = projects.get(projectName);
      p.costUsd += cost;
      p.outputTokens += e.output_tokens;
      p.messages += 1;

      w.costUsd += cost;
      w.outputTokens += e.output_tokens;
      w.messages += 1;
    }
  }

  const sortedDays = [...days.keys()].sort();
  const dayList = sortedDays.map((date) => {
    const models = days.get(date);
    const totalCostUsd = Object.values(models).reduce((sum, m) => sum + m.costUsd, 0);
    const totalOutputTokens = Object.values(models).reduce((sum, m) => sum + m.outputTokens, 0);
    return { date, models, totalCostUsd, totalOutputTokens };
  });

  const projectList = [...projects.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const workflowList = [...workflows.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const todayKey = localDay(now.toISOString());
  const sevenDaysAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgoMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  let last7DaysCostUsd = 0;
  let last30DaysCostUsd = 0;
  let todayCostUsd = 0;
  for (const d of dayList) {
    const dayMs = new Date(`${d.date}T00:00:00`).getTime();
    if (d.date === todayKey) todayCostUsd += d.totalCostUsd;
    if (dayMs >= sevenDaysAgoMs) last7DaysCostUsd += d.totalCostUsd;
    if (dayMs >= thirtyDaysAgoMs) last30DaysCostUsd += d.totalCostUsd;
  }

  const output = {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    days: dayList,
    projects: projectList,
    workflows: workflowList,
    totals: { last7DaysCostUsd, last30DaysCostUsd, todayCostUsd },
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(output, null, 2) + "\n", "utf8");

  const totalMessages = dayList.reduce(
    (sum, d) => sum + Object.values(d.models).reduce((s, m) => s + m.messages, 0),
    0
  );
  const topWorkflow = workflowList[0];
  const topWorkflowText = topWorkflow
    ? `, top workflow ${topWorkflow.label} $${topWorkflow.costUsd.toFixed(2)}`
    : "";
  console.log(
    `usage-stats: ${transcripts.length} transcript(s), ${totalMessages} message(s), ` +
      `today $${todayCostUsd.toFixed(2)}, 7d $${last7DaysCostUsd.toFixed(2)}, 30d $${last30DaysCostUsd.toFixed(2)}${topWorkflowText} -> ${outFile}`
  );
}

// Run only on direct execution (node export-usage-stats.mjs ...), never on import.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((e) => {
    console.error("usage-stats: export failed:", e?.message || e);
    process.exitCode = 1;
  });
}
