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
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";

// Kept as a fixed constant, not a CLI parameter, on purpose (Phase 1
// System-browser range toggle, 2026-08-04): the Usage tab's "All" range
// option shows every day this export already scanned rather than triggering
// a wider scan. Scanning is proportional to how many days of transcripts get
// opened, and this exporter is wired into the PROJECT-level SessionStart
// hook (`~/AIOS/.claude/settings.json`, not the global `~/.claude/settings.json`),
// as `node rebuild-task-index.mjs && node export-usage-stats.mjs`, so it fires
// on every session whose cwd is the vault -- widening WINDOW_DAYS to
// "unbounded history" would make every one of those session starts slower
// forever, not just the one time someone clicks "All". If a genuinely
// unbounded history view is wanted later, it should be a separate opt-in
// export path, not the hook-triggered default.
const WINDOW_DAYS = 35;
export const USAGE_DAY_TIME_ZONE = "Asia/Tbilisi";

// Round 3, Reviewer Minor N1: the LIVE lock this process currently owns, if any -- set right
// after main() successfully acquires it (mkdir + owner-token write both succeeded), cleared once
// main()'s own finally block has run (whether or not it actually removed the lock dir). Read by
// the SIGTERM/SIGINT handler below so an interrupted run (a hung exporter killed by the plugin's
// own 60s timeout, per N1's original defect: `child.kill()` sends SIGTERM and, without this, the
// lock was orphaned until it aged past LOCK_STALE_MS) can release its OWN lock on the way out,
// the same owner-checked release main()'s finally already performs on a normal exit -- never an
// unconditional rm, which would delete a newer holder's live lock out from under it if this
// process's lock was already stolen after exceeding LOCK_STALE_MS.
let currentHeldLock = null;

// Per-Mtok rates: { in, out }. Cache read bills at 0.1x input rate, cache write at 1.25x input rate.
export const RATES = {
  fable: { in: 10, out: 50 },
  opus: { in: 5, out: 25 },
  // sonnet is date-aware -- see resolveSonnetRate/SONNET_INTRO_CUTOFF_DAY
  // below. This entry is only the fallback used when a caller has no
  // timestamp to resolve against.
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
  other: { in: 5, out: 25 },
};

// Anthropic introductory pricing for Sonnet 5: $2 input / $10 output per
// Mtok through 2026-08-31, reverting to the $3/$15 standard rate on
// 2026-09-01. Keyed off each USAGE ENTRY's own timestamp (not "now"), so a
// message logged during the intro window is priced correctly forever, no
// matter when the exporter later re-runs over that same history.
export const SONNET_INTRO_RATE = { in: 2, out: 10 };
export const SONNET_STANDARD_RATE = { in: 3, out: 15 };
export const SONNET_INTRO_CUTOFF_DAY = "2026-08-31"; // last local day still at intro pricing

/**
 * Pure rate-resolution helper: dayKey is a "YYYY-MM-DD" local-day string
 * (see localDay()). String comparison is safe here because the format is
 * fixed-width and zero-padded, so lexicographic order matches date order.
 * A missing/unparseable dayKey falls back to the standard rate rather than
 * guessing.
 */
export function resolveSonnetRate(dayKey) {
  if (dayKey && dayKey <= SONNET_INTRO_CUTOFF_DAY) return SONNET_INTRO_RATE;
  return SONNET_STANDARD_RATE;
}

// Pi records model changes separately from usage messages. A thinking level is
// execution configuration, not a model identity, so it never splits a model
// bucket. Keep provider/model otherwise intact.
export function stripThinkingSuffix(model) {
  return typeof model === "string" ? model.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "") : model;
}

export function isOpenAiModel(model) {
  return typeof model === "string" && /^(?:openai|openai-codex)\//.test(model);
}

// Versioned API-equivalent rates in USD per million tokens. See the local,
// versioned source record at docs/openai-codex-api-equivalent-v1.md: it names
// the exact catalog paths, retrieval date, cache-write semantics, rate tiers,
// and why this exporter deliberately uses the base tier for every entry.
export const OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_PROVENANCE = "docs/openai-codex-api-equivalent-v1.md";
export const OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_V1 = {
  "gpt-5.5": { input: 5, cacheRead: 0.5, cacheWrite: 0, output: 30 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.6-sol": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
};
export const OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_VERSION = "openai-codex-api-equivalent-v1";

export function openAiApiEquivalentRate(model) {
  if (!isOpenAiModel(model)) return undefined;
  const modelId = model.replace(/^(?:openai|openai-codex)\//, "");
  return OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_V1[modelId];
}

export function modelFamily(model) {
  const m = model.toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

/**
 * `timestamp` (ISO string) is optional but required to get date-aware
 * sonnet pricing right; omitting it falls back to RATES.sonnet (the
 * standard/current rate). All real callers in this file pass the usage
 * entry's own timestamp.
 */
export function estimateCost(family, usage, timestamp, model) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const openAiRate = openAiApiEquivalentRate(model);
  // Unknown OpenAI models retain their own bucket but get no made-up Claude
  // `other` charge until a reviewed rate-card entry is added.
  if (isOpenAiModel(model)) {
    if (!openAiRate) return 0;
    return (
      input * openAiRate.input +
      output * openAiRate.output +
      cacheRead * openAiRate.cacheRead +
      cacheWrite * openAiRate.cacheWrite
    ) / 1e6;
  }
  const rate =
    family === "sonnet" ? resolveSonnetRate(timestamp ? localDay(timestamp) : undefined) : RATES[family] || RATES.other;
  return (
    input * rate.in +
    output * rate.out +
    cacheRead * 0.1 * rate.in +
    cacheWrite * 1.25 * rate.in
  ) / 1e6;
}

export function prettifyProject(folderName) {
  if (folderName === "-Users-jaymo") return "home";
  const prefix = "-Users-jaymo-";
  return folderName.startsWith(prefix) ? folderName.slice(prefix.length) : folderName;
}

export function localDay(timestamp, timeZone = USAGE_DAY_TIME_ZONE) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Recursively collects every .jsonl path under `dir` (depth-unbounded).
// Subagent transcripts are written at least 2 directory levels below their
// project dir (<project>/<session-id>/subagents/agent-*.jsonl), and nested
// subagents (an agent dispatching its own subagents) go deeper still
// (observed: <project>/<session-id>/subagents/workflows/wf_*/agent-*.jsonl).
// Non-.jsonl siblings (tool-results/*.txt, workflows/scripts/*.js, a
// project-level memory/*.md dir) are skipped by the extension check, so
// walking into them is harmless.
export async function walkJsonlFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

// `project` is always the TOP-LEVEL directory name under the projects root
// (e.g. "-Users-jaymo-AIOS"), regardless of how deep a file sits -- a
// session-id directory or a `subagents`/`workflows` directory is never
// mistaken for a project, because `project` comes from the first readdir
// level only.
//
// `sessionId` is the real (top-level) Claude Code session id. For a file
// that sits directly under the project dir, that's just its own basename
// (unchanged from before this fix). For a file nested any number of levels
// deeper -- a subagent, or a subagent-of-a-subagent -- it's the FIRST path
// segment under the project dir, i.e. the outermost session-id directory
// that everything below it was dispatched from. `isTopLevel` tells the
// caller which case it is, since only top-level files are real user
// sessions (see the `sessions` counter in applyTranscriptToAggregates).
export async function findTranscripts(root, cutoffMs) {
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
    const jsonlPaths = await walkJsonlFiles(projectPath);
    for (const filePath of jsonlPaths) {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue; // Ignore unreadable files.
      }
      if (stat.mtimeMs < cutoffMs) continue;
      const relParts = path.relative(projectPath, filePath).split(path.sep);
      const isTopLevel = relParts.length === 1;
      const sessionId = isTopLevel ? path.basename(relParts[0], ".jsonl") : relParts[0];
      files.push({
        filePath,
        project: entry.name,
        sessionId,
        sourceSessionId: rootNamespacedSourceId("claude", root, filePath),
        isTopLevel,
      });
    }
  }
  return files;
}

// Pi's canonical parent session files are directly under a project folder.
// Its canonical child sessions sit beneath the matching parent-session
// directory as <parent>/<run-uuid>/run-N/session.jsonl. `subagent-artifacts`
// are handoff copies, not new model usage. BB's canonical records are its
// thread JSONLs and run-N/session.jsonl files. Scoping both roots this way
// avoids charging copied artifacts a second time.
export function rootNamespacedSourceId(namespace, root, filePath) {
  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
  return `${namespace}:${relativePath.split(path.sep).join("/")}`;
}

function isContainedWithin(canonicalPath, canonicalRoot) {
  const relativePath = path.relative(canonicalRoot, canonicalPath);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

async function isCanonicalDirectoryWithin(directoryPath, expectedRoot) {
  try {
    // lstat prevents readdir() from following a same-named parent-session
    // symlink. The resolved directory must also remain under its real Pi
    // project root, not merely match the expected lexical prefix.
    const stat = await fs.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return isContainedWithin(await fs.realpath(directoryPath), await fs.realpath(expectedRoot));
  } catch {
    return false;
  }
}

async function isCanonicalRegularFileWithin(filePath, expectedRoot) {
  try {
    // lstat, rather than stat, rejects a symlink before its target can be
    // accepted. realpath then proves the resolved regular file remains in the
    // real Pi project root rather than only inside a lexical run directory.
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return isContainedWithin(await fs.realpath(filePath), await fs.realpath(expectedRoot));
  } catch {
    return false;
  }
}

export async function findPiAndBbTranscripts(piRoot, bbRoot, cutoffMs) {
  const files = [];
  let projects = [];
  try { projects = await fs.readdir(piRoot, { withFileTypes: true }); } catch {}
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(piRoot, project.name);
    let entries = [];
    try { entries = await fs.readdir(projectPath, { withFileTypes: true }); } catch {}
    const parentSessionIds = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectPath, entry.name);
      const sessionId = path.basename(entry.name, ".jsonl");
      parentSessionIds.push(sessionId);
      try {
        if ((await fs.stat(filePath)).mtimeMs >= cutoffMs) {
          files.push({
            filePath,
            project: prettifyProject(project.name),
            sessionId,
            sourceSessionId: rootNamespacedSourceId("pi", piRoot, filePath),
            isTopLevel: true,
          });
        }
      } catch {}
    }

    // Only inspect directories named for an actual direct parent session.
    // This intentionally cannot wander into Pi's subagent-artifacts tree.
    for (const parentSessionId of parentSessionIds) {
      const parentSessionPath = path.join(projectPath, parentSessionId);
      if (!(await isCanonicalDirectoryWithin(parentSessionPath, projectPath))) continue;
      let runDirs = [];
      try { runDirs = await fs.readdir(parentSessionPath, { withFileTypes: true }); } catch {}
      for (const runDir of runDirs) {
        if (!runDir.isDirectory() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runDir.name)) continue;
        let runs = [];
        try { runs = await fs.readdir(path.join(projectPath, parentSessionId, runDir.name), { withFileTypes: true }); } catch {}
        for (const run of runs) {
          if (!run.isDirectory() || !/^run-\d+$/.test(run.name)) continue;
          const filePath = path.join(projectPath, parentSessionId, runDir.name, run.name, "session.jsonl");
          try {
            // A lexical match is not enough: reject a child transcript that
            // is symlinked or whose canonical target escapes its exact run.
            if (await isCanonicalRegularFileWithin(filePath, projectPath) && (await fs.stat(filePath)).mtimeMs >= cutoffMs) {
              // Each transcript path, not the workflow/run session ID, is the
              // fallback-dedupe source. sessionId remains attribution only.
              files.push({
                filePath,
                project: prettifyProject(project.name),
                sessionId: runDir.name,
                sourceSessionId: rootNamespacedSourceId("pi", piRoot, filePath),
                isTopLevel: true,
              });
            }
          } catch {}
        }
      }
    }
  }
  const bbPaths = await walkJsonlFiles(bbRoot);
  for (const filePath of bbPaths) {
    const rel = path.relative(bbRoot, filePath).split(path.sep);
    const isThreadTranscript = rel.length === 1 && /^thr_.+\.jsonl$/.test(rel[0]);
    const isRunTranscript = path.basename(filePath) === "session.jsonl" && rel.some((part) => /^run-\d+$/.test(part));
    if (rel.includes("subagent-artifacts") || rel.includes("forks") || (!isThreadTranscript && !isRunTranscript)) continue;
    try {
      if ((await fs.stat(filePath)).mtimeMs >= cutoffMs) {
        const sessionId = isThreadTranscript ? path.basename(filePath, ".jsonl") : rel.find((part) => /^run-\d+$/.test(part)) || path.basename(path.dirname(filePath));
        files.push({ filePath, project: "pi-bridge", sessionId, sourceSessionId: rootNamespacedSourceId("bb", bbRoot, filePath), isTopLevel: true });
      }
    } catch {}
  }
  // The roots can overlap in local setups. Canonical BB paths must remain a
  // single transcript even when reached through more than one root.
  return [...new Map(files.map((file) => [path.resolve(file.filePath), file])).values()];
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

// Per-invocation skill attribution (build 2.9). The workflow classifier above
// tags a whole SESSION by its first message, so anything invoked mid-session
// (/close-session, /brief, a /gsd-* command) is invisible inside "Interactive".
// This segments a transcript into runs instead: a run opens at a
// <command-name> marker and closes at the next human message.
//
// Colon is allowed for plugin-namespaced skills (/superpowers:brainstorming).
export const SKILL_COMMAND_RE = /<command-name>\/([\w:-]+)<\/command-name>/;

// A user entry carrying tool_result blocks is the harness feeding a tool's
// output back in, not a human turn -- it must NOT close the active run.
export function isToolResultContent(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
}

// Builtin CLI commands (/model, /context, /clear...) run locally and echo
// their result in this tag. They do no model work, so the marker that opened
// the run is not a skill invocation at all -- the run is DISCARDED rather
// than closed, otherwise the real prompt that follows (e.g. "continue") gets
// billed to /model.
export const LOCAL_COMMAND_STDOUT_RE = /<local-command-stdout>/;

// Builtin CLI commands are not skills. Most are caught by the stdout rule
// above, but a few emit nothing; deny them by name so they can never displace
// a real skill from the top of the table. Conservative on purpose: anything
// not listed here is treated as a skill.
export const BUILTIN_COMMANDS = new Set([
  "model",
  "context",
  "clear",
  "compact",
  "cost",
  "status",
  "config",
  "help",
  "resume",
  "doctor",
  "login",
  "logout",
  "ide",
  "fast",
  "vim",
  "memory",
  "exit",
  "terminal-setup",
  "release-notes",
]);

/**
 * Stateful segmenter, fed in transcript order. Kept separate from
 * parseTranscript (and exported) so the rules are unit-testable without
 * synthesizing .jsonl files.
 *
 * Three deliberate attribution choices:
 *  - Claude Code injects the expanded command body as a SECOND user message
 *    right after the marker, so a brand-new run survives exactly ONE
 *    non-marker message before any assistant work. Bounding it at one keeps a
 *    stray builtin from swallowing the next real prompt.
 *  - A <local-command-stdout> message means the marker was a builtin CLI
 *    command, not a skill: the run is discarded, not recorded.
 *  - Sidechain (subagent) usage counts toward the run that dispatched it, and
 *    sidechain user messages never act as boundaries. A skill that fans out to
 *    agents owns that spend.
 *
 * Per-day breakdown (Phase 1 System-browser range toggle, 2026-08-04): each
 * run also carries `byDay` (dayKey -> {costUsd, outputTokens, messages}),
 * folded from every usage() call the same way foldWorkflowEntry does for
 * workflows. A run almost always lands on a single day, but a long-lived
 * session CAN carry a run across a calendar-day boundary, so this is tracked
 * per usage entry rather than assumed from the run's first timestamp.
 */
export function createSkillSegmenter() {
  const runs = [];
  let active = null;

  function closeActive() {
    if (active && active.messages > 0) {
      delete active.absorbedInjection;
      runs.push(active);
    }
    active = null;
  }

  return {
    // Call for human (non-sidechain, non-tool-result) user messages only.
    boundary(text) {
      const body = text || "";
      const m = SKILL_COMMAND_RE.exec(body);
      if (m) {
        closeActive();
        active = BUILTIN_COMMANDS.has(m[1])
          ? null
          : { key: m[1], costUsd: 0, outputTokens: 0, messages: 0, absorbedInjection: false, byDay: new Map() };
        return;
      }
      if (!active) return;
      // Builtin CLI command: never a skill run, drop it entirely.
      if (LOCAL_COMMAND_STDOUT_RE.test(body)) {
        active = null;
        return;
      }
      // The harness's expanded command body, once, before any assistant work.
      if (active.messages === 0 && !active.absorbedInjection) {
        active.absorbedInjection = true;
        return;
      }
      closeActive();
    },
    // Call for every assistant message that carries usage, sidechain included.
    usage(family, entry) {
      if (!active) return undefined;
      const cost = estimateCost(family, entry, entry.timestamp, entry.model);
      active.costUsd += cost;
      active.outputTokens += entry.output_tokens || 0;
      active.messages += 1;
      // Real callers (parseTranscript) always pass a timestamp -- entries
      // without one never reach this far (see the timestamp guard in
      // parseTranscript's main loop). Guarded defensively anyway so a caller
      // missing one (e.g. a test double) degrades to "no day attribution"
      // instead of polluting byDay with an Invalid Date key.
      if (!entry.timestamp) return active;
      const dayKey = localDay(entry.timestamp);
      if (!active.byDay.has(dayKey)) {
        active.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0 });
      }
      const d = active.byDay.get(dayKey);
      d.costUsd += cost;
      d.outputTokens += entry.output_tokens || 0;
      d.messages += 1;
      return active;
    },
    // Transcripts often end mid-run (session still open); keep that run.
    finish() {
      closeActive();
      return runs;
    },
  };
}

// A usage record's provider/response ID is its strongest identity. Older or
// partial transcript formats may lack that ID, so their fallback is purposely
// conservative: root-namespaced transcript source + message identity/time/model/token
// buckets + normalized assistant prose. The source keeps two otherwise-identical
// responses from separate transcripts distinct; workflow sessionId is attribution only.
export function usageRecordKey(entry) {
  if (entry.responseId) return `response:${entry.provider || ""}\u0000${entry.responseId}`;
  return [
    "fingerprint",
    entry.sourceSessionId || "",
    entry.messageId || "",
    entry.timestamp || "",
    entry.model || "",
    entry.input_tokens,
    entry.output_tokens,
    entry.cache_creation_input_tokens,
    entry.cache_read_input_tokens,
    entry.assistantContent || "",
  ].join("\u0000");
}

// Claude emits streamed updates without response IDs. Within one canonical
// physical transcript, message.id identifies that response. Keep the update
// with the greatest timestamp; equal timestamps resolve to the later JSONL
// line. Missing IDs intentionally retain the older conservative fingerprint.
// This runs after the per-entry window filter: an unfinished stream is billed
// at its final observed in-window fragment, and invalid timestamps are already
// excluded before this policy is reached.
export function retainFinalClaudeFragments(entries) {
  const finalByResponse = new Map();
  entries.forEach((entry, fileOrder) => {
    const isClaude = !entry.responseId && entry.claudeMessageId && /claude/i.test(entry.model || "");
    if (!isClaude) return;
    const key = `${entry.sourceSessionId || ""}\u0000${entry.claudeMessageId}`;
    const previous = finalByResponse.get(key);
    const timestampMs = new Date(entry.timestamp).getTime();
    if (!previous || timestampMs >= previous.timestampMs) {
      // `attribution` is intentionally present even when undefined. A
      // response that began outside a skill must stay unassigned rather than
      // inherit the skill active when its final streamed fragment arrives.
      finalByResponse.set(key, {
        entry,
        timestampMs,
        fileOrder,
        attribution: previous ? previous.attribution : entry.skillRun,
        // Replay the retained response where it began, even when its final
        // buckets were observed after later command boundaries.
        firstReplayOrder: previous ? previous.firstReplayOrder : entry.replayOrder,
      });
    }
  });
  if (finalByResponse.size === 0) return entries;
  const retained = new Set();
  for (const { entry, attribution, firstReplayOrder } of finalByResponse.values()) {
    // The response began under this run. A final streaming flush may arrive
    // after a later command boundary, but it must not move the charge.
    entry.skillRun = attribution;
    entry.replayOrder = firstReplayOrder;
    retained.add(entry);
  }
  return entries.filter((entry) => !(!entry.responseId && entry.claudeMessageId && /claude/i.test(entry.model || "")) || retained.has(entry));
}

function rebuildSkillRuns(skillRuns, entries) {
  for (const run of skillRuns) {
    run.costUsd = 0;
    run.outputTokens = 0;
    run.messages = 0;
    run.byDay = new Map();
  }
  for (const entry of entries) {
    const run = entry.skillRun;
    if (!run) continue;
    const cost = estimateCost(modelFamily(entry.model), entry, entry.timestamp, entry.model);
    run.costUsd += cost;
    run.outputTokens += entry.output_tokens || 0;
    run.messages += 1;
    const dayKey = localDay(entry.timestamp);
    if (!run.byDay.has(dayKey)) run.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0 });
    const day = run.byDay.get(dayKey);
    day.costUsd += cost;
    day.outputTokens += entry.output_tokens || 0;
    day.messages += 1;
  }
  return skillRuns.filter((run) => run.messages > 0);
}

function redactedSourceRef(sourcePath) {
  return `source-sha256:${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
}

export function createUsageRecordDedupe() {
  const seen = new Map();
  const collisions = [];
  return {
    collisions,
    accept(entry) {
      const key = usageRecordKey(entry);
      const kept = seen.get(key);
      if (!kept) {
        seen.set(key, entry);
        return true;
      }
      const collision = {
        kind: entry.responseId ? "responseId" : "fingerprint",
        identity: entry.responseId || entry.messageId || "fingerprint",
        // Diagnostics are persisted to usage-stats.json. Never put a local
        // absolute path there: use the root-relative source ID when supplied,
        // otherwise a stable non-reversible hash.
        keptSource: kept.sourceRef || redactedSourceRef(kept.sourcePath || "unknown"),
        skippedSource: entry.sourceRef || redactedSourceRef(entry.sourcePath || "unknown"),
      };
      collisions.push(collision);
      console.warn(
        `usage-stats: skipped duplicate ${collision.kind} usage record from ${collision.skippedSource}; already counted from ${collision.keptSource}`
      );
      return false;
    },
  };
}

// Single pass over the transcript: collects usage entries AND the two extra
// classification signals (firstUserContent, firstCommand) with no second pass.
//
// `cutoffMs` windows entries by their OWN timestamp (not the file's mtime).
// findTranscripts() only prefilters which FILES are worth opening (a file
// untouched for WINDOW_DAYS isn't worth reading); a long-lived session file
// that passes that prefilter can still contain entries far outside the
// window (it was appended to over many days). Filtering here is the single
// choke point: entries[] and skillRuns (fed by the segmenter) both flow from
// this loop, so days/projects/workflows/skills all become consistently
// windowed from one change.
export function createRejectedUsageDiagnostics() {
  const reasons = new Map();
  const rejectedRecords = new Set();
  return {
    record(reason, recordId) { reasons.set(reason, (reasons.get(reason) || 0) + 1); if (recordId) rejectedRecords.add(recordId); },
    serialize() { return { rejectedRecords: rejectedRecords.size, reasons: Object.fromEntries([...reasons.entries()].sort()) }; },
  };
}
// JSONL is delimited by LF only. Do not use readline: it splits valid U+2028/U+2029
// inside JSON strings. This incremental decoder retains chunked UTF-8 and partial tails.
async function* jsonlLines(filePath) {
  const stream = createReadStream(filePath);
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      let line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      yield line.toString("utf8");
    }
  }
  if (pending.length) { if (pending[pending.length - 1] === 0x0d) pending = pending.subarray(0, -1); yield pending.toString("utf8"); }
}
function usageNumber(raw, aliases, required, rejected) {
  const found = aliases.find((key) => Object.prototype.hasOwnProperty.call(raw, key));
  if (!found) { if (required) rejected.record(`missing-${aliases[0]}`); return required ? undefined : { value: 0, present: false }; }
  const value = raw[found];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) { rejected.record(`invalid-${aliases[0]}`); return undefined; }
  return { value, present: true };
}
export function validateUsage(raw, rejected) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { rejected.record("unsupported-usage"); return undefined; }
  const input = usageNumber(raw, ["input_tokens", "input"], true, rejected), output = usageNumber(raw, ["output_tokens", "output"], true, rejected);
  const cacheWrite = usageNumber(raw, ["cache_creation_input_tokens", "cacheWrite"], false, rejected), cacheRead = usageNumber(raw, ["cache_read_input_tokens", "cacheRead"], false, rejected);
  if (!input || !output || !cacheWrite || !cacheRead) return undefined;
  return { input_tokens: input.value, output_tokens: output.value, cache_creation_input_tokens: cacheWrite.value, cache_read_input_tokens: cacheRead.value, usagePresence: { cacheWrite: cacheWrite.present, cacheRead: cacheRead.present } };
}
export async function parseTranscript(filePath, cutoffMs, { upperBoundMs = Infinity, sourceSessionId = path.resolve(filePath), sourceRef, usageDedupe, rejectedUsage = createRejectedUsageDiagnostics() } = {}) {
  const entries = [];
  let firstUserContent;
  // System-browser Agents section (Phase 3, 2026-08-05): a dispatched
  // subagent transcript carries the Task-tool subagent_type on every line as
  // `attributionAgent` (verified constant per file across 30 sampled real
  // transcripts on this machine). Top-level session files never carry it.
  // Captured opportunistically from ANY line (not just assistant/user), so a
  // file that happens to lead with a line lacking the field still resolves
  // it from a later one.
  let attributionAgent;
  let currentProvider;
  // Preserve transcript event order but do not mutate skill state until the
  // retained ledger is known. A rejected duplicate must be invisible to both
  // totals and command-body injection state.
  const events = [];
  let replayOrder = 0;
  let sourceLine = 0;
  for await (const line of jsonlLines(filePath)) {
    sourceLine += 1;
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (attributionAgent === undefined && typeof obj?.attributionAgent === "string" && obj.attributionAgent) {
      attributionAgent = obj.attributionAgent;
    }
    if (obj?.type === "model_change" && typeof obj.provider === "string" && typeof obj.modelId === "string") {
      currentProvider = obj.provider;
    }
    if (obj?.type === "user") {
      const content = obj.message?.content;
      if (firstUserContent === undefined) {
        firstUserContent = extractTextContent(content).slice(0, 500);
      }
      // Skill-run boundary: human turns only.
      if (obj.isSidechain !== true && !isToolResultContent(content)) {
        events.push({ type: "boundary", replayOrder: replayOrder++, text: extractTextContent(content).slice(0, 500) });
      }
    }
    const rawModel = obj?.message?.model;
    // Ordinary user/system/model-change envelopes are not usage candidates.
    if (!obj?.message || !rawModel || rawModel === "<synthetic>") continue;
    const candidateId = `${sourceSessionId}:${sourceLine}`;
    const usage = obj.message.usage;
    if (usage === undefined) continue;
    const normalizedUsage = validateUsage(usage, { record: (reason) => rejectedUsage.record(reason, candidateId) });
    if (!normalizedUsage) continue;
    // Pi's selection records a provider separately. The usage message still
    // owns its model identity: qualify a bare message model with its own
    // provider first, then the most recent selection provider, never the
    // selection's modelId.
    const messageProvider = obj.message?.provider || currentProvider;
    const model = stripThinkingSuffix(!rawModel.includes("/") && messageProvider ? `${messageProvider}/${rawModel}` : rawModel);
    const timestamp = obj.timestamp;
    if (!timestamp) { rejectedUsage.record("missing-timestamp", candidateId); continue; }
    const entryMs = new Date(timestamp).getTime();
    if (Number.isNaN(entryMs)) { rejectedUsage.record("invalid-timestamp", candidateId); continue; }
    if (entryMs < cutoffMs || entryMs > upperBoundMs) { rejectedUsage.record("outside-temporal-window", candidateId); continue; }
    const entry = { timestamp, model, ...normalizedUsage,
      provider: typeof messageProvider === "string" ? messageProvider : "",
      responseId: typeof obj.message?.responseId === "string" ? obj.message.responseId : typeof obj.responseId === "string" ? obj.responseId : "",
      sourceSessionId,
      // Keep the legacy envelope-first identity for non-Claude fallback
      // dedupe, but Claude stream grouping must use message.id specifically.
      messageId: typeof obj.id === "string" ? obj.id : typeof obj.message?.id === "string" ? obj.message.id : "",
      claudeMessageId: typeof obj.message?.id === "string" ? obj.message.id : "",
      assistantContent: (obj.type === "assistant" || obj.message?.role === "assistant")
        ? extractTextContent(obj.message?.content).replace(/\s+/g, " ").trim()
        : "",
      sourcePath: filePath,
      sourceRef,
      replayOrder: replayOrder++,
    };
    entries.push(entry);
    if (obj.type === "assistant") events.push({ type: "usage", replayOrder: entry.replayOrder, entry });
  }
  const rawEntries = entries;
  const finalEntries = retainFinalClaudeFragments(rawEntries);
  // Semantic dedupe is the retained ledger boundary for every downstream
  // aggregate, including skills. Rebuild only after it rejects duplicates.
  const retainedEntries = usageDedupe ? finalEntries.filter((entry) => usageDedupe.accept(entry)) : finalEntries;
  // Replay only retained usage. Claude final fragments replay at their first
  // response event, retaining original attribution while charging final
  // buckets. This also keeps a new skill's initial command body available
  // after a duplicate or prior-response flush is rejected from the ledger.
  const retainedByReplayOrder = new Map(retainedEntries.map((entry) => [entry.replayOrder, entry]));
  const segmenter = createSkillSegmenter();
  for (const event of events) {
    if (event.type === "boundary") segmenter.boundary(event.text);
    else if (retainedByReplayOrder.has(event.replayOrder)) {
      const entry = retainedByReplayOrder.get(event.replayOrder);
      entry.skillRun = segmenter.usage(modelFamily(entry.model), entry);
    }
  }
  const skillRuns = rebuildSkillRuns(segmenter.finish(), retainedEntries);
  if (firstUserContent === undefined) firstUserContent = "";
  const firstCommandMatch = FIRST_COMMAND_RE.exec(firstUserContent);
  const firstCommand = firstCommandMatch ? firstCommandMatch[1] : undefined;
  return { entries: retainedEntries, rawEntries, firstUserContent, firstCommand, skillRuns, attributionAgent, rejectedUsage };
}

// Falls back to this bucket when a subagent transcript carries in-window
// usage entries but no attributionAgent field. Reviewer Minor 2 (2026-08-05):
// this comment previously undersold it as a zero-cost edge case (the only
// instance found in a first pass was an API-error transcript with 0 usage,
// which never even reaches this fold -- applyAgentTranscript's own
// zero-entries guard returns before creating a bucket at all). In practice
// this bucket can carry REAL, nonzero cost: any future subagent dispatch
// path that doesn't set attributionAgent (a host/CLI version change, a
// dispatch mechanism other than the Task tool) lands here rather than being
// silently dropped. It is treated exactly like any other non-roster type
// (general-purpose, Explore, workflow-subagent, Plan, seo-*,
// claude-code-guide): computeSystemAgentsView (model.mjs) surfaces it in the
// System tab's "Generic subagents" group, not hidden and not merged into a
// roster row it doesn't belong to.
export const UNKNOWN_AGENT_TYPE = "unknown";

/**
 * Pure accumulator (System-browser Agents section, Phase 3, 2026-08-05):
 * folds ONE subagent transcript's already-window-filtered entries into the
 * `agents` Map, keyed by the host-level attributionAgent value (e.g.
 * "coder", "general-purpose", "Explore") -- NOT yet mapped onto the AIOS
 * roster; that join happens later, in the plugin's view-model layer, against
 * ops-map.json's agent node ids (which already match the roster's
 * attributionAgent values 1:1: capture/coder/curate/recruit/research/
 * reviewer/tooling/web-builder). Keeping the raw type here means a
 * currently-non-roster type (e.g. a future hire) shows up the moment its
 * ops-map node exists, with no exporter change required.
 *
 * Mirrors applyTranscriptToAggregates' skills-map fold: one FILE is one run,
 * attributed to its first in-window day, same reasoning as skills' run
 * attribution (a run/file can span >1 day of cost, but is only ever "how
 * many runs happened" once).
 *
 * Deliberately independent of applyTranscriptToAggregates' days/projects/
 * workflows folds -- this is an ADDITIONAL dimension over the same already-
 * counted-once subagent entries, not a second charge. The exporter's
 * pre-existing days/projects/workflows totals (unchanged by this function)
 * remain the truthful headline numbers; `agents` breaks the same subagent
 * spend down a different way, same relationship projects/workflows/skills
 * already have to each other.
 */
export function applyAgentTranscript(agents, agentType, entries) {
  if (entries.length === 0) return;
  const key = agentType || UNKNOWN_AGENT_TYPE;
  if (!agents.has(key)) {
    agents.set(key, {
      costUsd: 0,
      outputTokens: 0,
      messages: 0,
      runs: 0,
      // dayKey -> { costUsd, outputTokens, messages, runs }, same shape as
      // workflows'/skills' byDay so the Usage tab range toggle can consume
      // this dimension the same way (per the task spec).
      byDay: new Map(),
    });
  }
  const a = agents.get(key);
  a.runs += 1;

  for (const e of entries) {
    const family = modelFamily(e.model);
    const cost = estimateCost(family, e, e.timestamp, e.model);
    const dayKey = localDay(e.timestamp);
    a.costUsd += cost;
    a.outputTokens += e.output_tokens || 0;
    a.messages += 1;
    if (!a.byDay.has(dayKey)) {
      a.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0, runs: 0 });
    }
    const d = a.byDay.get(dayKey);
    d.costUsd += cost;
    d.outputTokens += e.output_tokens || 0;
    d.messages += 1;
  }

  // The run (file) itself is attributed to its FIRST in-window day only, so
  // sum(byDay.runs) === a.runs even when a single file's usage spans more
  // than one calendar day -- same choice applyTranscriptToAggregates makes
  // for skills' per-run attribution.
  const firstDayKey = localDay(entries[0].timestamp);
  a.byDay.get(firstDayKey).runs += 1;
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

/**
 * Pure accumulator step (build 2.9 slice 2): folds one usage entry's cost
 * into a workflow's running totals AND its per-day breakdown (`byDay`, a
 * dayKey -> {costUsd, outputTokens, messages} Map). This is the ONLY place
 * that touches either side, so sum(byDay) always equals the top-level
 * totals by construction -- exported so that invariant is unit-testable
 * without a real transcript. Mutates and returns `acc` for convenience in
 * the main loop.
 */
export function foldWorkflowEntry(acc, dayKey, cost, outputTokens) {
  acc.costUsd += cost;
  acc.outputTokens += outputTokens;
  acc.messages += 1;
  if (!acc.byDay.has(dayKey)) {
    acc.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0, sessions: 0 });
  }
  const wd = acc.byDay.get(dayKey);
  wd.costUsd += cost;
  wd.outputTokens += outputTokens;
  wd.messages += 1;
  return acc;
}

/**
 * Pure accumulator step (Phase 1 System-browser range toggle, 2026-08-04):
 * attributes one SESSION (not one usage entry) to a day in the workflow's
 * `byDay` breakdown, so a range-scoped "Runs" column can be computed the
 * same way the skills table's per-day run count is. Called once per
 * top-level (non-subagent) transcript, keyed off that session's first
 * in-window entry's day -- a session's cost/tokens/messages can legitimately
 * spread across multiple days (foldWorkflowEntry handles that per-entry),
 * but "how many sessions started in this window" only needs one day per
 * session, so the session is not double-counted.
 */
export function foldWorkflowSession(acc, dayKey) {
  if (!acc.byDay.has(dayKey)) {
    acc.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0, sessions: 0 });
  }
  acc.byDay.get(dayKey).sessions += 1;
  return acc;
}

/**
 * Folds one parsed transcript (its skillRuns + already-window-filtered
 * entries) into the four running aggregates (days/projects/workflows/
 * skills), all passed in as Maps and mutated in place. Extracted from main()
 * (build 2.9) so the zero-in-window-entries edge case is unit-testable
 * without synthesizing real transcript files or touching the filesystem.
 *
 * Because `entries` arrives pre-filtered by parseTranscript()'s cutoffMs
 * check, "this transcript has nothing to contribute" collapses to
 * `entries.length === 0` -- a file that passed the mtime prefilter in
 * findTranscripts() but whose own entries are all outside the window. Guard
 * on that up front so such a file never creates a $0/0-message workflow
 * session, and never materializes a workflow/project entry that would
 * otherwise carry no data. skillRuns need no extra guard here: the segmenter
 * (createSkillSegmenter) already only emits a run once it has messages > 0,
 * and messages are only recorded for entries that passed the same cutoff
 * inside parseTranscript.
 *
 * `isSubagent` (build 2.9 recursive-scan fix): true when this transcript is
 * a dispatched subagent file rather than a real top-level session file. Two
 * things change for those:
 *  - skillRuns are dropped entirely. parseTranscript's segmenter opens/closes
 *    runs on genuine human turns (`isSidechain !== true && !isToolResultContent`),
 *    but a subagent transcript has no genuine human turns -- its "user"
 *    messages are the orchestrator's tool_result feed and prompt injection,
 *    not a person typing. Any run a subagent transcript appeared to produce
 *    would be a segmentation artifact, not a real skill invocation, so it
 *    must not pollute per-skill cost attribution (which existing callers
 *    already rely on to mean "human-invoked skill runs").
 *  - `sessions` is not incremented. A subagent transcript is not a user
 *    session -- it's delegated work billed to the parent session's workflow
 *    (see findTranscripts/main: the caller passes the PARENT session's
 *    `rule` for a subagent file, not one derived from the subagent's own
 *    content). Cost/tokens/messages still fold into days/projects/workflows
 *    as normal; only the session count stays real.
 */
export function applyTranscriptToAggregates({
  entries,
  skillRuns,
  projectName,
  rule,
  days,
  projects,
  workflows,
  skills,
  isSubagent = false,
}) {
  if (!isSubagent) {
    for (const run of skillRuns) {
      if (!skills.has(run.key)) {
        skills.set(run.key, {
          costUsd: 0,
          outputTokens: 0,
          messages: 0,
          runs: 0,
          // dayKey -> { costUsd, outputTokens, messages, runs }. Mirrors
          // workflows' byDay (Phase 1 System-browser range toggle,
          // 2026-08-04) so the Usage tab can recompute per-skill numbers for
          // any range instead of only ever showing the full-window total.
          byDay: new Map(),
        });
      }
      const s = skills.get(run.key);
      s.costUsd += run.costUsd;
      s.outputTokens += run.outputTokens;
      s.messages += run.messages;
      s.runs += 1;
      if (run.byDay) {
        for (const [dayKey, d] of run.byDay) {
          if (!s.byDay.has(dayKey)) {
            s.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0, runs: 0 });
          }
          const sd = s.byDay.get(dayKey);
          sd.costUsd += d.costUsd;
          sd.outputTokens += d.outputTokens;
          sd.messages += d.messages;
        }
        // The run itself is attributed to its FIRST active day only, so
        // sum(byDay.runs) === s.runs even when a single run's usage spans
        // more than one calendar day (rare, but foldWorkflowSession makes
        // the same choice for workflow sessions for the same reason).
        const firstDayKey = [...run.byDay.keys()].sort()[0];
        if (firstDayKey) s.byDay.get(firstDayKey).runs += 1;
      }
    }
  }

  if (entries.length === 0) return;

  if (!workflows.has(rule.key)) {
    workflows.set(rule.key, {
      label: rule.label,
      costUsd: 0,
      outputTokens: 0,
      messages: 0,
      sessions: 0,
      // dayKey -> { costUsd, outputTokens, messages, sessions }. Only days
      // with actual cost or a session start get an entry (see below) -- not
      // zero-padded across the whole WINDOW_DAYS window, to keep this JSON
      // compact.
      byDay: new Map(),
    });
  }
  const w = workflows.get(rule.key);
  if (!isSubagent) {
    w.sessions += 1;
    // entries.length > 0 is guaranteed here (the early return above already
    // handled the zero-entries case), so entries[0] always exists.
    foldWorkflowSession(w, localDay(entries[0].timestamp));
  }

  for (const e of entries) {
    const family = modelFamily(e.model);
    const modelKey = isOpenAiModel(e.model) ? e.model : family;
    const cost = estimateCost(family, e, e.timestamp, e.model);
    const dayKey = localDay(e.timestamp);

    if (!days.has(dayKey)) days.set(dayKey, {});
    const dayModels = days.get(dayKey);
    if (!dayModels[modelKey]) {
      dayModels[modelKey] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        messages: 0,
        costUsd: 0,
      };
    }
    const bucket = dayModels[modelKey];
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

    foldWorkflowEntry(w, dayKey, cost, e.output_tokens);
  }
}

function createResponseDiagnostics() {
  const byProviderModel = new Map();
  const record = (entry, retained) => {
    const provider = /claude/i.test(entry.model || "") ? "claude" : isOpenAiModel(entry.model) ? "openai" : "other";
    const key = `${provider}\u0000${entry.model}`;
    if (!byProviderModel.has(key)) byProviderModel.set(key, { provider, model: entry.model, rawUsageRecords: 0, retainedResponses: 0, rawTokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, retainedTokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, rawCostUsd: 0, retainedCostUsd: 0 });
    const row = byProviderModel.get(key);
    const tokens = { input: entry.input_tokens, cacheRead: entry.cache_read_input_tokens, cacheWrite: entry.cache_creation_input_tokens, output: entry.output_tokens };
    const cost = estimateCost(modelFamily(entry.model), entry, entry.timestamp, entry.model);
    row.rawUsageRecords += retained === undefined ? 1 : 0;
    if (retained) row.retainedResponses += 1;
    for (const [bucket, value] of Object.entries(tokens)) {
      if (retained === undefined) row.rawTokens[bucket] += value;
      if (retained) row.retainedTokens[bucket] += value;
    }
    if (retained === undefined) row.rawCostUsd += cost;
    if (retained) row.retainedCostUsd += cost;
  };
  return {
    recordRaw: (entries) => entries.forEach((entry) => record(entry)),
    recordRetained: (entries) => entries.forEach((entry) => record(entry, true)),
    serialize() {
      const rows = [...byProviderModel.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
      return { rawUsageRecords: rows.reduce((sum, row) => sum + row.rawUsageRecords, 0), retainedResponses: rows.reduce((sum, row) => sum + row.retainedResponses, 0), byProviderModel: rows };
    },
  };
}

// Directory-based lock, same primitive as Operations/scripts/mint-task-id.mjs's atomic
// claim: fs.mkdir on a leaf path is atomic at the filesystem level, so two concurrent
// exporter runs racing to mkdir the same lock path have exactly one winner. Unlike the
// minter, this lock IS released (in a finally, below) because the exporter is a
// repeatable single-writer critical section, not a never-released id claim.
//
// Stale-lock recovery: a crashed holder (killed mid-run, OOM, host restart) leaves its
// lock directory behind forever with nothing to release it. A lock dir older than
// LOCK_STALE_MS is treated as abandoned and removed so later runs are not blocked
// permanently. Measured one real run against the live AIOS vault (~1,600 transcripts,
// 73.7k retained messages, 2026-09-18): 8.6s wall time. This vault routinely runs
// 10-20 concurrent Claude Code sessions, and a SessionStart hook firing across that many
// sessions can mean real contention for CPU/disk while a run is in flight, so the stale
// threshold is set to roughly 14x that single measured run rather than a tight multiple.
// Test-only override: a real fixture-vault test that wants to exercise stale-lock recovery,
// the race-safe steal, or the thundering-herd/slow-holder scenarios cannot wait 120 real
// seconds per case. Unset in production (falls back to the real 120_000 threshold above).
// All test-only overrides are inert unless this explicit gate is set by a synthetic
// fixture process. This prevents inherited USAGE_EXPORT_TEST_* values from altering a
// production SessionStart exporter, including failure injection and timing knobs.
const usageTestEnv = (name) => process.env.AIOS_USAGE_EXPORT_TEST_MODE === "1" ? process.env[name] : undefined;
const usageTestNumber = (name, fallback) => Number(usageTestEnv(name)) || fallback;
const LOCK_STALE_MS = usageTestNumber("USAGE_EXPORT_TEST_LOCK_STALE_MS", 120_000);

// Atomic publish for any small JSON artifact in `dir`: write to a uniquely named temp
// file (pid + timestamp, so two concurrent writers never collide on the temp name
// itself), fsync it, then rename over the target. A reader can only ever observe the
// prior complete file or the new complete file, never a partial write -- `rename(2)` is
// atomic on the same filesystem, and both usage-stats.json and its status sidecar live
// in the same directory as their temp files by construction.
// Test-only knob: a real fixture-sized usage-stats.json can write fast enough that no test
// process ever observes an in-progress write, which would make a concurrent-writer test
// unable to go red under a reverted (non-atomic) write. When set, the temp-file write is
// split into chunks with a delay between them, widening the window. Never read outside a
// test process (unset in production, no behavioral effect at 0).
const TEST_WRITE_CHUNK_DELAY_MS = usageTestNumber("USAGE_EXPORT_TEST_WRITE_CHUNK_DELAY_MS", 0);

// M1 (Reviewer round 2, R2-M1), residual widened-gap case: skipping ONLY the catch-block
// status write on lock loss (see the USAGE_EXPORT_LOCK_LOST branch in main()) closes the race
// for THAT write, but the attempt-start status write (unconditional, happens the instant a
// run acquires the lock, before it can know it will later lose it) is exposed to the exact
// same class of race: writeStatusMonotonic reads the CURRENT status once, up front, then (with
// USAGE_EXPORT_TEST_WRITE_CHUNK_DELAY_MS set) the actual disk write can take long enough for a
// genuinely newer holder to steal the lock AND publish its own success in the interim -- the
// slow write then lands on disk with an outcome computed from a now-stale read, silently
// erasing the newer holder's real success. Measured: with only the catch-block skip in place,
// 5/5 trials of the widened-gap harness (100ms hold, 150ms chunk delay, 80ms stale threshold)
// still showed the winning holder B's genuine, confirmed success (`b.stdout` was a real export
// success line, not busy) overwritten to `lastSuccessAt: null` by the losing holder A's
// attempt-start write landing after B's.
//
// Closing this needs the ownership recheck to happen as close as possible to the actual
// commit (fs.rename), not merely before the write is initiated -- an optional `beforeRename`
// callback, invoked immediately before the rename and skipping the write entirely (removing
// the temp file instead) if it resolves false. Every writeStatusMonotonic call in main() now
// passes one that re-verifies ownership at that last possible moment.
async function writeJsonAtomic(filePath, data, { beforeRename } = {}) {
  const dir = path.dirname(filePath);
  const tempFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const handle = await fs.open(tempFile, "wx");
    try {
      const json = JSON.stringify(data, null, 2) + "\n";
      if (TEST_WRITE_CHUNK_DELAY_MS > 0) {
        const chunkCount = 8;
        const chunkSize = Math.ceil(json.length / chunkCount) || 1;
        for (let i = 0; i < json.length; i += chunkSize) {
          await handle.write(json.slice(i, i + chunkSize), null, "utf8");
          await new Promise((resolve) => setTimeout(resolve, TEST_WRITE_CHUNK_DELAY_MS));
        }
      } else {
        await handle.writeFile(json, "utf8");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRename && !(await beforeRename())) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      return { skipped: true };
    }
    if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_SNAPSHOT_PUBLISH_FAIL") && path.basename(filePath) === "usage-stats.json") {
      throw new Error("synthetic snapshot publish failure requested via USAGE_EXPORT_TEST_FORCE_SNAPSHOT_PUBLISH_FAIL");
    }
    if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_SUCCESS_STATUS_WRITE_FAIL") && path.basename(filePath) === "usage-stats.status.json") {
      throw new Error("synthetic success-status write failure requested via USAGE_EXPORT_TEST_FORCE_SUCCESS_STATUS_WRITE_FAIL");
    }
    await fs.rename(tempFile, filePath);
    return { skipped: false };
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

// Status sidecar path: `usage-stats.json` -> `usage-stats.status.json`, same directory,
// so it publishes atomically the same way and a reader can locate it from the data path.
function statusPathFor(outFile) {
  return outFile.replace(/\.json$/, ".status.json");
}

async function readStatus(statusFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(statusFile, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // absent, unreadable, or invalid -- callers treat this the same as "no prior status"
  }
  return { lastAttemptAt: null, lastSuccessAt: null, lastError: null };
}

// Reviewer round 1, Important 1: writes were monotonic in intent but not in fact -- an older
// run that briefly lost a stale-stolen lock could still finish and stamp the status sidecar
// with its own (older) attempt/success timestamps AFTER a genuinely newer run had already
// recorded later ones, silently erasing the newer record. ISO 8601 timestamps of the same
// fixed-width shape sort lexicographically exactly the same as chronologically, so string
// comparison is enough here without parsing. Re-reads the CURRENT on-disk status immediately
// before merging (not the value captured back at attempt-start).
//
// CORRECTION (Reviewer round 2, M1/R2-M1): the read-merge-write here is NOT atomic across
// processes, and the belt-and-suspenders claim that used to sit here was false -- measured
// 3/3: a lock-lost run's failure-path write (see the USAGE_EXPORT_LOCK_LOST catch in main())
// can still read the status file BEFORE a winning holder's own success write lands, then
// write its own (older, failed) merged result AFTER, silently erasing the winner's clean
// success. This function's own compare-then-write is correct in isolation, but two
// *independent* writeStatusMonotonic calls from two different processes can still interleave
// around each other's read. The actual fix is upstream in main(): a run that has lost
// ownership of the lock now skips its failure-path status write entirely (see the
// USAGE_EXPORT_LOCK_LOST branch below) rather than relying on this function to arbitrate a
// race it structurally cannot see all of.
function isNewer(a, b) {
  return !!a && (!b || a > b);
}
async function writeStatusMonotonic(statusFile, next, { isStillOwner } = {}) {
  const current = await readStatus(statusFile);
  const attemptAdvances = isNewer(next.lastAttemptAt, current.lastAttemptAt);
  const merged = {
    lastAttemptAt: attemptAdvances ? next.lastAttemptAt : current.lastAttemptAt,
    lastSuccessAt: isNewer(next.lastSuccessAt, current.lastSuccessAt) ? next.lastSuccessAt : current.lastSuccessAt,
    // lastError travels with whichever attempt is the most recent -- only adopt this write's
    // error (or its clearing of a prior error) when THIS attempt is not older than the one
    // already on disk, so a slow/older run can never stomp a newer run's recorded outcome.
    lastError: attemptAdvances || next.lastAttemptAt === current.lastAttemptAt ? next.lastError : current.lastError,
  };
  // M1 (Reviewer round 2, R2-M1): `current` above was read once, up front -- by the time the
  // (possibly slow, chunk-delayed) write below actually commits, a different process may have
  // become the sole legitimate writer. `beforeRename` re-verifies immediately before the
  // commit, as close to it as this API allows, and skips the write (not just the merge
  // decision) if ownership was lost in the interim.
  await writeJsonAtomic(statusFile, merged, { beforeRename: isStillOwner });
}

// Owner token written inside the lock dir at acquisition. Release and the pre-publish
// ownership recheck both compare against this exact token (pid + random nonce), never against
// "a lock dir exists at this path" -- Reviewer round 1, Important 1: an unconditional rm on
// release/steal cannot tell "the lock I hold" from "a lock a completely different, later
// holder now holds after stealing mine."
function makeOwnerToken() {
  return { pid: process.pid, nonce: randomBytes(8).toString("hex"), acquiredAt: new Date().toISOString() };
}
function ownerFilePath(lockFile) {
  return path.join(lockFile, "owner.json");
}
async function readOwnerToken(lockFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(ownerFilePath(lockFile), "utf8"));
    if (parsed && typeof parsed.pid === "number" && typeof parsed.nonce === "string") return parsed;
  } catch {
    // lock dir absent, owner file absent/unreadable/invalid -- treated as "not us"
  }
  return null;
}
function sameOwner(a, b) {
  return !!a && !!b && a.pid === b.pid && a.nonce === b.nonce;
}
async function isCurrentOwner(lockFile, ownerToken) {
  return sameOwner(await readOwnerToken(lockFile), ownerToken);
}

// Best-effort sweep of orphaned temp files (a hard crash between fs.open and fs.rename in
// writeJsonAtomic leaves one behind; writeJsonAtomic's own catch only cleans up temps from
// THIS process's own throws) and stale rename-tombstones (see the steal logic in main() --
// each is cleaned up by its own creator immediately after a successful steal, but a crash
// between the rename and that cleanup would strand one). Anything matching our own naming
// convention and older than LOCK_STALE_MS is safe to remove: a legitimate write's tmp file
// lives for at most the length of one publish, never anywhere near the stale-lock horizon.
// Never throws -- this is housekeeping, not part of the write path's correctness.
async function sweepOrphanTemps(outDir, lockFile) {
  let entries;
  try {
    entries = await fs.readdir(outDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoffMs = Date.now() - LOCK_STALE_MS;
  const lockBase = path.basename(lockFile);
  for (const entry of entries) {
    const isOwnTemp = entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp");
    const isTombstone = entry.name.startsWith(`${lockBase}.stale-`);
    const isStealCoord = entry.name === `${lockBase}.steal-coord`;
    if (!isOwnTemp && !isTombstone && !isStealCoord) continue;
    const full = path.join(outDir, entry.name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoffMs) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    } catch {
      // vanished between readdir and stat -- nothing to do
    }
  }
}

export async function main({
  vaultRoot = process.argv[2] || process.cwd(),
  // Env overrides exist only so a CLI-spawned test process (real `node export-usage-stats.mjs
  // <vault>`, no way to pass programmatic options) can point at an isolated fixture instead of
  // the real ~/.claude/projects etc. Unset in production; the defaults below are unchanged.
  projectsRoot = usageTestEnv("USAGE_EXPORT_TEST_PROJECTS_ROOT") || path.join(os.homedir(), ".claude", "projects"),
  piRoot = usageTestEnv("USAGE_EXPORT_TEST_PI_ROOT") || path.join(os.homedir(), ".pi", "agent", "sessions"),
  bbRoot = usageTestEnv("USAGE_EXPORT_TEST_BB_ROOT") || path.join(os.homedir(), ".bb", "pi-bridge-sessions"),
  now = new Date(),
  lockWaitMs = usageTestNumber("USAGE_EXPORT_TEST_LOCK_WAIT_MS", 1000),
} = {}) {
  const outDir = path.join(vaultRoot, "Operations", "usage");
  const outFile = path.join(outDir, "usage-stats.json");
  const statusFile = statusPathFor(outFile);
  const scanStartedAt = now.toISOString();
  const cutoffMs = now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const upperBoundMs = now.getTime();
  const lockFile = `${outFile}.lock`;
  await fs.mkdir(outDir, { recursive: true });
  let acquired = false;
  let ownerToken = null;
  const deadline = Date.now() + lockWaitMs;
  // M3 (Reviewer round 2): tracks WHY the most recent iteration failed to acquire, so the
  // eventual busy message can say what is actually blocking instead of always claiming "a
  // live writer retained the lock" -- that was only ever true of one of several possible
  // reasons a deadline can be hit. Set fresh at the top of every iteration below.
  let lastBlockReason = "a live writer holds the lock and is producing an equally fresh snapshot";
  // Reviewer round 1, Important 2: every iteration that does NOT acquire the lock must go
  // through exactly one shared tail below (deadline check, then a single sleep) before looping
  // again -- no branch is allowed its own bare `continue`. The old code let a stale lock that
  // could not be removed, or any fs.stat error other than ENOENT, skip straight back to the
  // top with neither check, which spun at full CPU until something external killed it
  // (reproduced: SIGKILLed at 8005ms against a 1000ms lockWaitMs).
  while (!acquired) {
    try {
      await fs.mkdir(lockFile);
      ownerToken = makeOwnerToken();
      // M4 (Reviewer round 2): this write used to be swallowed (`.catch(() => {})`). A failed
      // write here (e.g. disk full, EACCES) left this process holding the lock dir with NO
      // owner.json -- isCurrentOwner/readOwnerToken then read that as "not us" for both the
      // pre-publish recheck and the release, so the run silently could not release its own
      // lock (blocking every other run for up to LOCK_STALE_MS/120s) and its real cause (the
      // write failure) was never surfaced -- instead it later reported the misleading
      // USAGE_EXPORT_LOCK_LOST "stolen after exceeding stale threshold" error, which is not
      // what actually happened. Must fail loudly with the real cause instead: remove the lock
      // dir we just created (so we do not leave an unowned lock behind) and rethrow.
      try {
        // Test-only failure injection, inert unless set (same pattern as
        // USAGE_EXPORT_TEST_FORCE_FAIL): every real cause of this write failing (disk full,
        // EACCES on a misconfigured Operations/usage dir) is awkward to reproduce
        // deterministically from outside a real filesystem race, so a test can force it here
        // to exercise the catch below with a real thrown error.
        if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL")) {
          throw new Error(`synthetic owner-token write failure requested via USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL=${process.env.USAGE_EXPORT_TEST_FORCE_OWNER_WRITE_FAIL}`);
        }
        await fs.writeFile(ownerFilePath(lockFile), JSON.stringify(ownerToken));
      } catch (ownerWriteError) {
        await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});
        throw new Error(`usage export: failed to write lock owner token: ${ownerWriteError?.message || ownerWriteError}`, { cause: ownerWriteError });
      }
      acquired = true;
      currentHeldLock = { lockFile, ownerToken };
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stat = null;
      try {
        stat = await fs.stat(lockFile);
      } catch {
        // Lock vanished between our EEXIST and this stat (released or stolen by someone
        // else in that instant). Nothing to steal; fall through to the shared tail and try
        // mkdir again next iteration.
        lastBlockReason = "the lock briefly vanished and reappeared between attempts (contended by other writers)";
      }
      if (stat) {
        lastBlockReason = Date.now() - stat.mtimeMs > LOCK_STALE_MS
          ? "a stale lock exists but has not yet been recovered"
          : "a live writer holds the lock and is producing an equally fresh snapshot";
      }
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        // Reviewer round 1, Important 1, round 2 residual: a first version of this steal used
        // `fs.rename` directly, reasoning that rename's own atomicity means at most one
        // concurrent renamer of the SAME source can win. True, but insufficient on its own --
        // measured (round 2, this exact 8-waiter test): a SLOW waiter's `stat` can read the
        // ORIGINAL stale lock, then before that same waiter's `rename` actually executes, a
        // DIFFERENT (faster) waiter can have already won the steal, released, AND had a THIRD,
        // legitimate process mkdir a brand-new, genuinely fresh lock at the same path -- the
        // slow waiter's rename does not know any of that happened and unconditionally renames
        // away whatever currently occupies `lockFile`, evicting a live, still-working holder
        // that has no idea it just lost its lock. Both the live holder and the evictor then
        // believe they hold the lock (max observed overlap 2-3 across 12 iterations before
        // this fix). rename(2) has no compare-and-swap form to close that check-then-act gap
        // directly, so instead the STEAL DECISION ITSELF is serialized through a second,
        // separate atomic mkdir (`.steal-coord`): only the one process that wins it is allowed
        // to even attempt the rename for this stale generation, and everyone else (losing the
        // coordination mkdir) just falls through to the shared wait tail below rather than
        // racing a rename at all. While the ORIGINAL stale entry still occupies `lockFile`, no
        // OTHER process can mkdir a fresh lock there (mkdir would hit EEXIST against the STALE
        // entry) -- so nothing can appear at that path for a slow single stealer to mistakenly
        // evict. The steal-coordination lock is itself best-effort (never itself the source of
        // a hang: any failure to acquire it just means "someone else is handling this stale
        // lock generation, wait"), and is always released in a finally.
        const stealCoordDir = `${lockFile}.steal-coord`;
        // The coordination lock itself needs its own stale-recovery, or a crash exactly
        // between winning it and its `finally` release would deadlock ALL future stale-lock
        // recovery forever (worse than the bug this fixes). Best-effort, unconditional: if
        // stealing wrongly races another recoverer in this already-rare crash-during-steal
        // edge case, the worst case is two processes racing the underlying rename directly for
        // this one recovery, which is safe on its own (rename's own atomicity was never the
        // problem -- only a THIRD process mkdir'ing a fresh lock into the gap was).
        try {
          const coordStat = await fs.stat(stealCoordDir);
          if (Date.now() - coordStat.mtimeMs > LOCK_STALE_MS) {
            await fs.rm(stealCoordDir, { recursive: true, force: true }).catch(() => {});
          }
        } catch {
          // absent -- nothing to recover
        }
        try {
          await fs.mkdir(stealCoordDir);
          try {
            // Re-check staleness fresh now that we are the exclusive stealer for this round --
            // the lock may have been released or renewed between our first `stat` above and
            // winning coordination.
            let freshStat = null;
            try {
              freshStat = await fs.stat(lockFile);
            } catch {
              // Already gone (released normally, or -- impossible while we hold
              // stealCoordDir and the old entry still occupies the path, but defensive
              // regardless): nothing to steal.
            }
            if (freshStat && Date.now() - freshStat.mtimeMs > LOCK_STALE_MS) {
              const tombstone = `${lockFile}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
              try {
                await fs.rename(lockFile, tombstone);
                await fs.rm(tombstone, { recursive: true, force: true }).catch(() => {});
              } catch (renameError) {
                // ENOENT: released in between (should not happen while nothing else can mkdir
                // over the old entry, but defensive). Any other error (e.g. EACCES: the lock
                // dir sits under a read-only parent) must NOT throw here -- Reviewer round 1,
                // Important 2's exact reproduction. Both fall through to the shared tail below.
                if (renameError?.code !== "ENOENT") {
                  // M3 (Reviewer round 2): this IS the honest cause when it drives us all the
                  // way to a busy exit -- no writer exists, the lock is just stale AND stuck.
                  lastBlockReason = `a stale lock exists but could not be removed (${renameError?.code || renameError?.message || renameError})`;
                }
              }
            }
          } finally {
            await fs.rm(stealCoordDir, { recursive: true, force: true }).catch(() => {});
          }
        } catch (stealCoordError) {
          // EEXIST: someone else is already the exclusive stealer for this stale generation.
          // Any OTHER error (e.g. EACCES: outDir itself sits under a read-only parent) must
          // NOT throw here either, for the same reason as the rename catch above (Reviewer
          // round 1, Important 2) -- both cases fall through to the shared wait tail and
          // re-evaluate next iteration rather than hanging or crash-looping.
          lastBlockReason = stealCoordError?.code === "EEXIST"
            ? "another process is already recovering the same stale lock"
            : `a stale lock exists but could not be recovered (${stealCoordError?.code || stealCoordError?.message || stealCoordError})`;
        }
      }
      // Shared tail for every non-acquiring path above: respect the deadline, then sleep once.
      if (Date.now() >= deadline) {
        // M3 (Reviewer round 2): the message used to unconditionally claim "existing writer
        // retained" even when the real, measured cause was a stale-but-unremovable lock or a
        // crashed steal-coordination lock -- situations where NO writer actually exists
        // (status and snapshot both untouched). lastBlockReason is set at every fall-through
        // point above and names the real cause; this is not a failure either way (the CLI
        // entry point below exits 0 for it), only the wording changes.
        const busy = new Error(`usage export busy; ${lastBlockReason}`);
        busy.code = "USAGE_EXPORT_BUSY";
        throw busy;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  // Test-only knobs: neither has any effect unless a test sets the env var. Together they
  // let a test prove the lock is the thing serializing the critical section, independent
  // of the atomic-rename write (which alone would hide a disabled lock -- see the mutation
  // test in exportUsageAtomicWrite.test.mjs for why both are needed). USAGE_EXPORT_TEST_MARK_DIR:
  // drop a marker file for the duration this process holds the lock, so a test can count how
  // many exporter processes are inside the critical section at once. USAGE_EXPORT_TEST_HOLD_MS:
  // sleep after acquiring the lock, widening that window long enough for a test's poll loop to
  // reliably observe overlapping holders if the lock is not actually serializing.
  const testMarkDir = usageTestEnv("USAGE_EXPORT_TEST_MARK_DIR") || null;
  const testHoldMs = usageTestNumber("USAGE_EXPORT_TEST_HOLD_MS", 0);
  const testMarkFile = testMarkDir ? path.join(testMarkDir, `${process.pid}-${Date.now()}.active`) : null;
  if (testMarkFile) await fs.writeFile(testMarkFile, "").catch(() => {});
  if (testHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, testHoldMs));
  const priorStatus = await readStatus(statusFile);
  const attemptIso = now.toISOString();
  // Pass the prior values straight through (not null placeholders) so this attempt-start
  // write only ever ADVANCES lastAttemptAt -- it must never clear lastError/lastSuccessAt
  // before this attempt's own outcome is known. writeStatusMonotonic still re-reads current
  // on-disk state itself, so a slow/older run's attempt-start write correctly fails to
  // advance anything if a newer run has already recorded a later lastAttemptAt.
  await writeStatusMonotonic(
    statusFile,
    { lastAttemptAt: attemptIso, lastSuccessAt: priorStatus.lastSuccessAt, lastError: priorStatus.lastError },
    { isStillOwner: () => isCurrentOwner(lockFile, ownerToken) }
  ).catch(() => {});
  try {
  // Test-only failure injection: every real failure mode this exporter can hit in practice
  // (disk full, permissions, a genuinely malformed transcript tripping a bug) is awkward to
  // reproduce deterministically from outside. This lets a test exercise the catch/status-
  // recording path with a real thrown error, at a real point inside the critical section,
  // without faking any part of the code under test.
  if (usageTestEnv("USAGE_EXPORT_TEST_FORCE_FAIL")) {
    throw new Error(`synthetic test failure requested via USAGE_EXPORT_TEST_FORCE_FAIL=${process.env.USAGE_EXPORT_TEST_FORCE_FAIL}`);
  }
  const transcripts = [
    ...(await findTranscripts(projectsRoot, cutoffMs)),
    ...(await findPiAndBbTranscripts(piRoot, bbRoot, cutoffMs)),
  ];
  const canonicalTranscripts = [...new Map(transcripts.map((t) => [path.resolve(t.filePath), t])).values()];
  const bridgeSessionIds = await loadBridgeSessionIds();
  const workflowRules = buildWorkflowRules(bridgeSessionIds);

  // dayKey -> family -> { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, messages, costUsd }
  const days = new Map();
  // projectName -> { costUsd, outputTokens, messages }
  const projects = new Map();
  // workflowKey -> { label, costUsd, outputTokens, messages, sessions }
  const workflows = new Map();
  // skillKey -> { costUsd, outputTokens, messages, runs }
  const skills = new Map();
  // agentType -> { costUsd, outputTokens, messages, runs, byDay } (System-browser
  // Agents section, Phase 3, 2026-08-05). Populated only from nested subagent
  // transcripts (a top-level session is never itself "an agent run").
  const agents = new Map();
  // One exporter run can discover the same response through separate
  // canonical paths. Apply the semantic record guard while parsing so every
  // aggregate (including skill runs) sees only the kept record.
  const usageDedupe = createUsageRecordDedupe();
  const responseDiagnostics = createResponseDiagnostics();
  const rejectedUsage = createRejectedUsageDiagnostics();

  // Top-level session files must be classified BEFORE any nested subagent
  // file, because a subagent's cost rolls up to its PARENT session's
  // workflow (a Sonnet builder dispatched during an "Interactive" session is
  // Interactive cost, not its own workflow) -- classifying by the subagent's
  // own content would be wrong and could even fabricate a bogus workflow out
  // of `agent-<hash>` "session ids". Directory-walk order is not guaranteed
  // to visit a session's own file before its subagents/ subtree, so split
  // and process top-level first regardless of discovery order.
  const topLevel = canonicalTranscripts.filter((t) => t.isTopLevel);
  const nested = canonicalTranscripts.filter((t) => !t.isTopLevel);

  // sessionId -> the workflow rule that session's own top-level transcript
  // resolved to, so every subagent dispatched under it can inherit the same
  // classification.
  const sessionRules = new Map();

  for (const { filePath, project, sessionId, sourceSessionId } of topLevel) {
    const { entries, rawEntries, firstUserContent, firstCommand, skillRuns } = await parseTranscript(filePath, cutoffMs, {
      sourceSessionId: sourceSessionId || sessionId,
      sourceRef: sourceSessionId,
      usageDedupe, upperBoundMs, rejectedUsage,
    });
    responseDiagnostics.recordRaw(rawEntries);
    responseDiagnostics.recordRetained(entries);
    const projectName = prettifyProject(project);
    const rule = classifyWorkflow(workflowRules, {
      project: projectName,
      sessionId,
      firstCommand,
      firstUserContent,
    });
    sessionRules.set(sessionId, rule);
    applyTranscriptToAggregates({ entries, skillRuns, projectName, rule, days, projects, workflows, skills });
  }

  for (const { filePath, project, sessionId, sourceSessionId } of nested) {
    const { entries, rawEntries, firstUserContent, firstCommand, skillRuns, attributionAgent } = await parseTranscript(
      filePath,
      cutoffMs,
      { sourceSessionId: sourceSessionId || sessionId, sourceRef: sourceSessionId, usageDedupe, upperBoundMs, rejectedUsage }
    );
    responseDiagnostics.recordRaw(rawEntries);
    responseDiagnostics.recordRetained(entries);
    const projectName = prettifyProject(project);
    // Prefer the parent session's own classification. Fall back to
    // classifying off this file's content only if the parent session's
    // top-level transcript wasn't discovered at all (e.g. it aged out of
    // the mtime prefilter while a subagent file it spawned was touched more
    // recently) -- zero-in-window-entries files still fall through
    // applyTranscriptToAggregates's existing empty-transcript guard, so this
    // never fabricates a workflow entry out of nothing.
    const rule =
      sessionRules.get(sessionId) ||
      classifyWorkflow(workflowRules, { project: projectName, sessionId, firstCommand, firstUserContent });
    applyTranscriptToAggregates({
      entries,
      skillRuns,
      projectName,
      rule,
      days,
      projects,
      workflows,
      skills,
      isSubagent: true,
    });
    applyAgentTranscript(agents, attributionAgent, entries);
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
    .map(([key, v]) => {
      const byDay = {};
      for (const [dayKey, d] of [...v.byDay.entries()].sort()) byDay[dayKey] = d;
      return { key, ...v, byDay };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  // Sorted by total cost, not run count: the point of this section is finding
  // the expensive skill, and the Runs column keeps frequency visible anyway.
  const skillList = [...skills.entries()]
    .map(([key, v]) => {
      const byDay = {};
      for (const [dayKey, d] of [...v.byDay.entries()].sort()) byDay[dayKey] = d;
      return {
        key,
        label: key,
        ...v,
        byDay,
        avgCostUsd: v.runs > 0 ? v.costUsd / v.runs : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  // Sorted by total cost, same convention as workflowList/skillList. `label`
  // mirrors skillList's own key-as-label choice (System tab joins by `key`
  // against ops-map's roster ids and only uses `label` as an unmapped
  // fallback display name), so this can reuse the same JSON shape/TS type
  // as UsageSkillStat.
  const agentList = [...agents.entries()]
    .map(([key, v]) => {
      const byDay = {};
      for (const [dayKey, d] of [...v.byDay.entries()].sort()) byDay[dayKey] = d;
      return { key, label: key, ...v, byDay, avgCostUsd: v.runs > 0 ? v.costUsd / v.runs : 0 };
    })
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

  const unpricedOpenAiModels = [...new Set(
    dayList.flatMap((day) => Object.keys(day.models).filter((model) => isOpenAiModel(model) && !openAiApiEquivalentRate(model)))
  )].sort();

  const output = {
    generatedAt: now.toISOString(),
    scanStartedAt,
    dayTimeZone: USAGE_DAY_TIME_ZONE,
    windowDays: WINDOW_DAYS,
    days: dayList,
    projects: projectList,
    workflows: workflowList,
    skills: skillList,
    agents: agentList,
    // Every graph value is a token-bucket API-equivalent estimate, never a
    // subscription charge, allowance, quota, or entitlement measurement.
    costSemantics: {
      claude: "api-equivalent estimate",
      openai: "api-equivalent estimate",
      openaiCodex: "api-equivalent estimate",
      openaiRateCard: OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_VERSION,
      openaiRateCardProvenance: OPENAI_CODEX_API_EQUIVALENT_RATE_CARD_PROVENANCE,
      // The local card has higher rates above 272K, but transcript entries do
      // not carry a reliable discriminator for that catalog threshold.
      openaiCodexTier: "base rates only; transcript fields lack a reliable per-entry 272K threshold discriminator",
      openaiCodexTierThresholdTokens: 272000,
      unknownOpenAi: "unpriced; rate card required",
    },
    unpricedOpenAiModels,
    dedupe: { skippedUsageRecords: usageDedupe.collisions.length, collisions: usageDedupe.collisions },
    // Additive audit counters. Existing messages remain retained-response counts.
    responseDiagnostics: responseDiagnostics.serialize(),
    rejectedUsage: rejectedUsage.serialize(),
    totals: { last7DaysCostUsd, last30DaysCostUsd, todayCostUsd },
  };

  // Reviewer round 1, Important 1: re-check ownership immediately before publishing. A run
  // that outlived LOCK_STALE_MS can have had its lock stolen by a newer holder while it was
  // still working; if that happened, a newer run may already be mid-publish or done, and this
  // (now unauthorized) run must never overwrite it. This is the specific gate the "slow-holder"
  // scenario needs -- monotonic status writes (writeStatusMonotonic) protect the sidecar
  // independently, but the data file has no timestamp-merge equivalent, so ownership is the
  // only thing standing between a slow holder and clobbering a newer snapshot.
  if (!(await isCurrentOwner(lockFile, ownerToken))) {
    const lost = new Error("usage export: lock lost mid-run (stolen after exceeding the stale threshold); refusing to publish over a possibly newer snapshot");
    lost.code = "USAGE_EXPORT_LOCK_LOST";
    throw lost;
  }
  await writeJsonAtomic(outFile, output);

  const totalMessages = dayList.reduce(
    (sum, d) => sum + Object.values(d.models).reduce((s, m) => s + m.messages, 0),
    0
  );
  const topWorkflow = workflowList[0];
  const topWorkflowText = topWorkflow
    ? `, top workflow ${topWorkflow.label} $${topWorkflow.costUsd.toFixed(2)}`
    : "";
  const topSkill = skillList[0];
  const topSkillText = topSkill
    ? `, top skill /${topSkill.label} $${topSkill.avgCostUsd.toFixed(2)}/run x${topSkill.runs}`
    : "";
  const topAgent = agentList[0];
  const topAgentText = topAgent
    ? `, top agent ${topAgent.key} $${topAgent.costUsd.toFixed(2)} x${topAgent.runs} run(s)`
    : "";
  console.log(
    `usage-stats: ${canonicalTranscripts.length} transcript(s), ${totalMessages} message(s), ` +
      `today $${todayCostUsd.toFixed(2)}, 7d $${last7DaysCostUsd.toFixed(2)}, 30d $${last30DaysCostUsd.toFixed(2)}${topWorkflowText}${topSkillText}${topAgentText} -> ${outFile}`
  );
  await writeStatusMonotonic(
    statusFile,
    { lastAttemptAt: attemptIso, lastSuccessAt: now.toISOString(), lastError: null },
    { isStillOwner: () => isCurrentOwner(lockFile, ownerToken) }
  ).catch(() => {});
  // Minor 10 (half): sweep orphaned temp files / stale rename-tombstones on a successful run.
  // Best-effort and never throws; a sweep failure must never turn a successful export into a
  // failed one.
  await sweepOrphanTemps(outDir, lockFile).catch(() => {});
  } catch (error) {
    // The previous valid usage-stats.json is untouched (writeJsonAtomic never renamed
    // over it), but the status sidecar must record the failure so the reader can warn
    // instead of silently showing an aging snapshot as if the pipeline were healthy.
    //
    // M1 (Reviewer round 2, R2-M1): a run that has lost ownership of the lock (see the
    // USAGE_EXPORT_LOCK_LOST throw above) must NOT write the status file at all. Only the
    // lock holder writes status. writeStatusMonotonic's own read-merge-write is not atomic
    // across processes (see the corrected comment above it), so this run's write can still
    // land AFTER a winning holder's own success write reads the file but BEFORE that
    // winner's write completes, silently erasing a clean success with this run's own stale
    // failure -- measured 3/3 by the Reviewer. Skipping the write here removes this run from
    // the race entirely: only the process that actually still owns the lock (and is
    // therefore the only legitimate writer of this attempt's outcome) ever writes status.
    if (error?.code !== "USAGE_EXPORT_LOCK_LOST") {
      await writeStatusMonotonic(
        statusFile,
        { lastAttemptAt: attemptIso, lastSuccessAt: null, lastError: String(error?.message || error) },
        { isStillOwner: () => isCurrentOwner(lockFile, ownerToken) }
      ).catch(() => {});
    }
    throw error;
  } finally {
    if (testMarkFile) await fs.rm(testMarkFile, { force: true }).catch(() => {});
    // Reviewer round 1, Important 1: only remove the lock dir if it still belongs to us. If a
    // newer holder stole it after we exceeded LOCK_STALE_MS, an unconditional rm here would
    // delete THEIR live lock out from under them (measured in round 1: "lock dir right after A
    // exits, B should still hold it: ABSENT").
    if (ownerToken && (await isCurrentOwner(lockFile, ownerToken))) {
      await fs.rm(lockFile, { recursive: true, force: true }).catch(() => {});
    }
    // This run no longer owns (or never acquired) a live lock the signal handler below needs to
    // know about, whether this finally actually removed it (normal exit) or found it already
    // stolen (left alone, on purpose, for the new owner).
    currentHeldLock = null;
  }
}

// Round 3, Reviewer Minor N1: without a handler, Node's DEFAULT SIGTERM/SIGINT action ends the
// process immediately -- main()'s own finally block (the owner-checked lock release above) never
// runs. Measured (Reviewer round 2, attack 2): a `child.kill()` (SIGTERM, the plugin's own 60s
// hang timeout) orphaned the lock dir; the next run then falsely reported "a live writer holds
// the lock" for up to LOCK_STALE_MS (~60s) after a 60s timeout, and every concurrent
// SessionStart-hook export in that window published nothing. `shuttingDown` guards against a
// second signal (or SIGTERM immediately followed by SIGINT) re-entering this mid-release.
let shuttingDown = false;
async function releaseOwnedLockAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // Same owner-checked release as main()'s own finally -- never unconditional: if this
    // process's lock was already stolen (aged past LOCK_STALE_MS) by a newer holder before the
    // signal arrived, an unconditional rm here would delete THAT holder's live lock instead.
    if (currentHeldLock && (await isCurrentOwner(currentHeldLock.lockFile, currentHeldLock.ownerToken))) {
      await fs.rm(currentHeldLock.lockFile, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Best-effort: a release failure here must not prevent the process from exiting.
  }
  process.exit(1);
}

// Run only on direct execution (node export-usage-stats.mjs ...), never on import.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  process.on("SIGTERM", () => { void releaseOwnedLockAndExit(); });
  process.on("SIGINT", () => { void releaseOwnedLockAndExit(); });
  main().catch((e) => {
    if (e?.code === "USAGE_EXPORT_BUSY") {
      // Not a failure: another writer holds the lock and is producing an equally fresh
      // snapshot. Exit 0 so nothing downstream (the plugin's own refreshUsageSnapshot
      // spawn included) reads this as a broken run. Reviewer round 1, Minor 12: this
      // exporter itself is NOT `&&`-chained in the real hook -- the project SessionStart
      // hook (~/AIOS/.claude/settings.json) runs `rebuild-task-index.mjs && export-usage-
      // stats.mjs ; export-ops-map.mjs ...`, i.e. this script sits on the RIGHT of the only
      // `&&` and is followed by `;`, so its own exit code gates nothing downstream in that
      // hook. Exiting 0 here still matters for other direct invocations of this CLI (the
      // plugin's manual/auto-refresh spawn, an interactive `node export-usage-stats.mjs`)
      // that DO branch on this process's own exit code.
      console.log(`usage-stats: ${e.message}`);
      return;
    }
    console.error("usage-stats: export failed:", e?.message || e);
    process.exitCode = 1;
  });
}
