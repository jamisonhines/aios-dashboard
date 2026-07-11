#!/usr/bin/env node
// Export launchd automation health into <vaultRoot>/Operations/usage/automation-health.json
// for the aios-dashboard Automations strip.
// Usage: node export-automation-health.mjs [vaultRoot] [prefix1,prefix2,...]
// Style-matches export-usage-stats.mjs / export-ops-map.mjs: plain node, no
// deps, tolerant of missing files and failing commands.
//
// Canonical home: the aios-dashboard repo (vault-scripts/). deploy.sh copies
// this file into <vault>/Operations/scripts/. Pure parts (launchctl parse,
// schedule description, next-occurrence math, state derivation, red-first
// sort) are exported so the repo test suite (exportAutomationHealth.test.mjs)
// imports the REAL functions instead of keeping a hand-synced mirror.
// Importing this module never scans anything: the script body only runs on
// direct execution (see the guard at the bottom).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileP = promisify(execFile);

// Only launchd labels starting with one of these prefixes are ours to watch.
// CLI arg 2 (comma-separated) overrides.
export const DEFAULT_LABEL_PREFIXES = ["com.jaymo.", "com.aios.", "ge.vagabondadventures."];

// Red-first display/sort order. "unknown" means the label is not in
// `launchctl list` at all (not loaded), which is a red state.
export const STATE_ORDER = ["unknown", "error", "overdue", "running", "ok"];

// ---------------------------------------------------------------------------
// Pure helpers (exported, unit-tested in exportAutomationHealth.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Parse `launchctl list` text output into a Map keyed by label.
 * Lines look like: "<pid|->\t<status>\t<label>". Header line is skipped.
 * @param {string} text
 * @returns {Map<string, { pid: number | null, lastExitStatus: number | null }>}
 */
export function parseLaunchctlList(text) {
  const out = new Map();
  for (const line of (text || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, label] = parts;
    if (pidRaw === "PID") continue; // header
    const pid = pidRaw === "-" ? null : parseInt(pidRaw, 10);
    const status = parseInt(statusRaw, 10);
    out.set(label, {
      pid: Number.isFinite(pid) ? pid : null,
      lastExitStatus: Number.isFinite(status) ? status : null,
    });
  }
  return out;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function describeCalendarDict(dict) {
  const time =
    dict.Hour != null ? `${pad2(dict.Hour)}:${pad2(dict.Minute ?? 0)}` : `:${pad2(dict.Minute ?? 0)}`;
  if (dict.Weekday != null) {
    const name = WEEKDAY_NAMES[dict.Weekday] ?? `wd${dict.Weekday}`;
    return `${name} ${time}`;
  }
  return `daily ${time}`;
}

/**
 * Human-readable schedule string for a job's normalized schedule
 * ({ calendar, interval, runAtLoad } as built by buildJob).
 * @returns {string}
 */
export function describeSchedule(schedule) {
  if (schedule.calendar) {
    const dicts = Array.isArray(schedule.calendar) ? schedule.calendar : [schedule.calendar];
    return dicts.map(describeCalendarDict).join(" / ");
  }
  if (schedule.interval != null) {
    const s = schedule.interval;
    if (s % 3600 === 0) return `every ${s / 3600}h`;
    if (s % 60 === 0) return `every ${s / 60}m`;
    return `every ${s}s`;
  }
  if (schedule.runAtLoad) return "at load";
  return "unscheduled";
}

/**
 * Next occurrence of one StartCalendarInterval dict strictly after `now`.
 * Supports Hour/Minute plus optional Weekday (launchd: 0 and 7 = Sunday).
 * @param {{ Hour?: number, Minute?: number, Weekday?: number }} dict
 * @param {Date} now
 * @returns {Date}
 */
export function nextCalendarOccurrence(dict, now) {
  const hour = dict.Hour ?? 0;
  const minute = dict.Minute ?? 0;
  const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  const wantedDay = dict.Weekday != null ? dict.Weekday % 7 : null;
  for (let i = 0; i < 9; i++) {
    if (cand > now && (wantedDay == null || cand.getDay() === wantedDay)) return cand;
    cand.setDate(cand.getDate() + 1);
  }
  return cand; // unreachable in practice
}

/**
 * Next expected run for a normalized schedule.
 * Calendar: earliest next occurrence over all dicts. StartInterval:
 * lastActivity + interval (null when never active). RunAtLoad-only: null.
 * @param {{ calendar?: object | object[], interval?: number | null, runAtLoad?: boolean }} schedule
 * @param {string | null} lastActivityIso
 * @param {Date} now
 * @returns {string | null} ISO timestamp or null
 */
export function computeNextExpected(schedule, lastActivityIso, now) {
  if (schedule.calendar) {
    const dicts = Array.isArray(schedule.calendar) ? schedule.calendar : [schedule.calendar];
    let best = null;
    for (const d of dicts) {
      const occ = nextCalendarOccurrence(d, now);
      if (best === null || occ < best) best = occ;
    }
    return best ? best.toISOString() : null;
  }
  if (schedule.interval != null) {
    if (!lastActivityIso) return null;
    const t = Date.parse(lastActivityIso);
    if (isNaN(t)) return null;
    return new Date(t + schedule.interval * 1000).toISOString();
  }
  return null; // RunAtLoad or unscheduled
}

/**
 * Effective schedule period in ms (mean gap between runs), used for the
 * overdue check. Weekly dicts count as 7d, daily as 24h; multiple dicts sum
 * their rates (3x daily -> 8h). Null when the job has no periodic schedule.
 * @returns {number | null}
 */
export function schedulePeriodMs(schedule) {
  if (schedule.calendar) {
    const dicts = Array.isArray(schedule.calendar) ? schedule.calendar : [schedule.calendar];
    let ratePerMs = 0;
    for (const d of dicts) {
      const period = d.Weekday != null ? 7 * 86400000 : 86400000;
      ratePerMs += 1 / period;
    }
    return ratePerMs > 0 ? Math.round(1 / ratePerMs) : null;
  }
  if (schedule.interval != null) return schedule.interval * 1000;
  return null;
}

/**
 * Derive the display state for one job. Red-first meanings:
 * - "unknown": not present in launchctl list (not loaded); red.
 * - "error": last exit status != 0; red.
 * - "overdue": no activity for one full schedule period + 25% grace; yellow.
 * - "running": has a live pid; blue/accent.
 * - "ok": everything else; green/neutral.
 * @param {{ loaded: boolean, pid: number | null, lastExitStatus: number | null,
 *           lastActivity: string | null,
 *           schedule: { calendar?: object | object[], interval?: number | null, runAtLoad?: boolean } }} job
 * @param {Date} now
 * @returns {"unknown" | "error" | "overdue" | "running" | "ok"}
 */
export function computeJobState(job, now) {
  if (!job.loaded) return "unknown";
  if (job.pid != null) return "running";
  if (job.lastExitStatus != null && job.lastExitStatus !== 0) return "error";
  const period = schedulePeriodMs(job.schedule);
  if (period != null && job.lastActivity) {
    const t = Date.parse(job.lastActivity);
    if (!isNaN(t) && now.getTime() - t > period * 1.25) return "overdue";
  }
  return "ok";
}

/**
 * Red-first sort: unknown/error, overdue, running, ok; label a-z inside each
 * state. Returns a new array.
 */
export function sortJobsRedFirst(jobs) {
  return jobs
    .slice()
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
        a.label.localeCompare(b.label)
    );
}

/** Parse the comma-separated prefix override; falls back to the default set. */
export function resolvePrefixes(arg) {
  if (!arg) return DEFAULT_LABEL_PREFIXES;
  const parsed = arg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_LABEL_PREFIXES;
}

// ---------------------------------------------------------------------------
// Impure gathering (plist read, launchctl exec, log stat)
// ---------------------------------------------------------------------------

// Parse one .plist via `plutil -convert json -o -`; null when unparseable.
async function readPlist(filePath) {
  try {
    const { stdout } = await execFileP("plutil", ["-convert", "json", "-o", "-", filePath], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function mtimeIso(filePath) {
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

async function launchctlListMap() {
  try {
    const { stdout } = await execFileP("launchctl", ["list"], { maxBuffer: 4 * 1024 * 1024 });
    return parseLaunchctlList(stdout);
  } catch {
    return new Map();
  }
}

async function buildJob(plist, launchMap, now) {
  const label = plist.Label;
  const schedule = {
    calendar: plist.StartCalendarInterval ?? null,
    interval: plist.StartInterval ?? null,
    runAtLoad: plist.RunAtLoad === true,
  };
  const outPath = plist.StandardOutPath ?? null;
  const errPath = plist.StandardErrorPath ?? null;

  const outMtime = await mtimeIso(outPath);
  const errMtime = await mtimeIso(errPath);
  const mtimes = [outMtime, errMtime].filter((t) => t != null);
  const lastActivity = mtimes.length > 0 ? mtimes.sort().at(-1) : null;

  const launch = launchMap.get(label);
  const loaded = launch != null;
  const pid = launch?.pid ?? null;
  const lastExitStatus = launch?.lastExitStatus ?? null;

  const job = { label, loaded, pid, lastExitStatus, lastActivity, schedule };
  return {
    label,
    schedule: describeSchedule(schedule),
    lastActivity,
    lastExitStatus,
    pid,
    nextExpected: computeNextExpected(schedule, lastActivity, now),
    state: computeJobState(job, now),
    logPath: outPath ?? errPath,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const vaultRoot = path.resolve(process.argv[2] || process.cwd());
  const prefixes = resolvePrefixes(process.argv[3]);
  const outDir = path.join(vaultRoot, "Operations", "usage");
  const outFile = path.join(outDir, "automation-health.json");
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const now = new Date();

  let entries = [];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    // No LaunchAgents dir: emit an empty job list rather than failing.
  }
  const plistFiles = entries.filter((n) => n.endsWith(".plist")).sort();

  const launchMap = await launchctlListMap();

  const jobs = [];
  for (const name of plistFiles) {
    const plist = await readPlist(path.join(agentsDir, name));
    if (!plist || typeof plist.Label !== "string") continue; // tolerate unparseable
    if (!prefixes.some((p) => plist.Label.startsWith(p))) continue;
    jobs.push(await buildJob(plist, launchMap, now));
  }

  const output = {
    generatedAt: now.toISOString(),
    jobs: sortJobsRedFirst(jobs),
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(output, null, 2) + "\n", "utf8");

  const counts = {};
  for (const j of output.jobs) counts[j.state] = (counts[j.state] || 0) + 1;
  const countsText =
    STATE_ORDER.filter((s) => counts[s])
      .map((s) => `${counts[s]} ${s}`)
      .join(", ") || "no jobs";
  console.log(`automation-health: ${output.jobs.length} job(s) (${countsText}) -> ${outFile}`);
}

// Run only on direct execution, never on import.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((e) => {
    console.error("automation-health: export failed:", e?.message || e);
    process.exitCode = 1;
  });
}
