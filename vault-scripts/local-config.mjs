// Instance-owned settings for the exporters. The file sits under Instance/, a seed path, so an
// update never writes it; the template ships none, and every key is optional with a neutral default.
//
//   {
//     "launchdLabelPrefixes": ["com.aios."],
//     "usageWorkflows": [
//       { "key": "report", "label": "Weekly report", "command": "/report" },
//       { "key": "mail", "label": "Mail automation", "commandPrefix": "/mail-" }
//     ]
//   }
//
// launchdLabelPrefixes: which ~/Library/LaunchAgents jobs export-automation-health.mjs watches
// (default com.aios.; a CLI argument still wins). usageWorkflows: extra export-usage-stats.mjs
// buckets for sessions that start with a slash command, matched exactly (command) or by prefix
// (commandPrefix), checked after the Telegram rules and before the catch-alls.
import { readFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_CONFIG_PATH = "Instance/local-config.json";
const RESERVED_WORKFLOW_KEYS = new Set(["telegram-bridge", "telegram-ingest", "learning-scan", "interactive"]);

/** The parsed config object, or {} when the file is missing, unreadable or not a JSON object. */
export function readLocalConfig(vaultRoot, warn = (m) => console.error(m)) {
  let text;
  try {
    text = readFileSync(path.join(vaultRoot, LOCAL_CONFIG_PATH), "utf8");
  } catch {
    return {};
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    // fall through to the warning
  }
  warn(`${LOCAL_CONFIG_PATH}: not valid JSON object; using defaults`);
  return {};
}

/** Trimmed prefixes when the value is a non-empty array of non-empty strings, else null. */
export function launchdPrefixesFrom(config) {
  const raw = config?.launchdLabelPrefixes;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((p) => typeof p === "string" && p.trim().length > 0)) return null;
  return raw.map((p) => p.trim());
}

/** Workflow rules for each well-formed usageWorkflows entry; malformed entries are dropped. */
export function usageWorkflowsFrom(config) {
  const raw = config?.usageWorkflows;
  if (!Array.isArray(raw)) return [];
  const rules = [];
  for (const w of raw) {
    if (!w || typeof w.key !== "string" || !w.key || typeof w.label !== "string" || !w.label) continue;
    if (RESERVED_WORKFLOW_KEYS.has(w.key)) continue;
    const exact = typeof w.command === "string" && w.command.startsWith("/");
    const prefix = typeof w.commandPrefix === "string" && w.commandPrefix.startsWith("/");
    if (exact === prefix || ("command" in w && "commandPrefix" in w)) continue;
    const match = exact
      ? (ctx) => ctx.firstCommand === w.command
      : (ctx) => typeof ctx.firstCommand === "string" && ctx.firstCommand.startsWith(w.commandPrefix);
    rules.push({ key: w.key, label: w.label, match });
  }
  return rules;
}
