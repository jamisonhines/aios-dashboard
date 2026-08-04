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

// Kept as a fixed constant, not a CLI parameter, on purpose (Phase 1
// System-browser range toggle, 2026-08-04): the Usage tab's "All" range
// option shows every day this export already scanned rather than triggering
// a wider scan. Scanning is proportional to how many days of transcripts get
// opened, and this exporter runs on every Claude Code SessionStart hook --
// widening WINDOW_DAYS to "unbounded history" would make every session
// start slower forever, not just the one time someone clicks "All". If a
// genuinely unbounded history view is wanted later, it should be a separate
// opt-in export path, not the hook-triggered default.
const WINDOW_DAYS = 35;

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
export function estimateCost(family, usage, timestamp) {
  const rate =
    family === "sonnet" ? resolveSonnetRate(timestamp ? localDay(timestamp) : undefined) : RATES[family] || RATES.other;
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
      files.push({ filePath, project: entry.name, sessionId, isTopLevel });
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
      if (!active) return;
      const cost = estimateCost(family, entry, entry.timestamp);
      active.costUsd += cost;
      active.outputTokens += entry.output_tokens || 0;
      active.messages += 1;
      // Real callers (parseTranscript) always pass a timestamp -- entries
      // without one never reach this far (see the timestamp guard in
      // parseTranscript's main loop). Guarded defensively anyway so a caller
      // missing one (e.g. a test double) degrades to "no day attribution"
      // instead of polluting byDay with an Invalid Date key.
      if (!entry.timestamp) return;
      const dayKey = localDay(entry.timestamp);
      if (!active.byDay.has(dayKey)) {
        active.byDay.set(dayKey, { costUsd: 0, outputTokens: 0, messages: 0 });
      }
      const d = active.byDay.get(dayKey);
      d.costUsd += cost;
      d.outputTokens += entry.output_tokens || 0;
      d.messages += 1;
    },
    // Transcripts often end mid-run (session still open); keep that run.
    finish() {
      closeActive();
      return runs;
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
export async function parseTranscript(filePath, cutoffMs) {
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
  const segmenter = createSkillSegmenter();
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
    if (attributionAgent === undefined && typeof obj?.attributionAgent === "string" && obj.attributionAgent) {
      attributionAgent = obj.attributionAgent;
    }
    if (obj?.type === "user") {
      const content = obj.message?.content;
      if (firstUserContent === undefined) {
        firstUserContent = extractTextContent(content).slice(0, 500);
      }
      // Skill-run boundary: human turns only.
      if (obj.isSidechain !== true && !isToolResultContent(content)) {
        segmenter.boundary(extractTextContent(content).slice(0, 500));
      }
    }
    const usage = obj?.message?.usage;
    if (!usage) continue;
    const model = obj.message?.model;
    if (!model || model === "<synthetic>") continue;
    const timestamp = obj.timestamp;
    if (!timestamp) continue;
    const entryMs = new Date(timestamp).getTime();
    if (Number.isNaN(entryMs) || entryMs < cutoffMs) continue;
    const entry = {
      timestamp,
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    };
    entries.push(entry);
    if (obj.type === "assistant") segmenter.usage(modelFamily(model), entry);
  }
  if (firstUserContent === undefined) firstUserContent = "";
  const firstCommandMatch = FIRST_COMMAND_RE.exec(firstUserContent);
  const firstCommand = firstCommandMatch ? firstCommandMatch[1] : undefined;
  return { entries, firstUserContent, firstCommand, skillRuns: segmenter.finish(), attributionAgent };
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
    const cost = estimateCost(family, e, e.timestamp);
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
    const cost = estimateCost(family, e, e.timestamp);
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

    foldWorkflowEntry(w, dayKey, cost, e.output_tokens);
  }
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
  // skillKey -> { costUsd, outputTokens, messages, runs }
  const skills = new Map();
  // agentType -> { costUsd, outputTokens, messages, runs, byDay } (System-browser
  // Agents section, Phase 3, 2026-08-05). Populated only from nested subagent
  // transcripts (a top-level session is never itself "an agent run").
  const agents = new Map();

  // Top-level session files must be classified BEFORE any nested subagent
  // file, because a subagent's cost rolls up to its PARENT session's
  // workflow (a Sonnet builder dispatched during an "Interactive" session is
  // Interactive cost, not its own workflow) -- classifying by the subagent's
  // own content would be wrong and could even fabricate a bogus workflow out
  // of `agent-<hash>` "session ids". Directory-walk order is not guaranteed
  // to visit a session's own file before its subagents/ subtree, so split
  // and process top-level first regardless of discovery order.
  const topLevel = transcripts.filter((t) => t.isTopLevel);
  const nested = transcripts.filter((t) => !t.isTopLevel);

  // sessionId -> the workflow rule that session's own top-level transcript
  // resolved to, so every subagent dispatched under it can inherit the same
  // classification.
  const sessionRules = new Map();

  for (const { filePath, project, sessionId } of topLevel) {
    const { entries, firstUserContent, firstCommand, skillRuns } = await parseTranscript(filePath, cutoffMs);
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

  for (const { filePath, project, sessionId } of nested) {
    const { entries, firstUserContent, firstCommand, skillRuns, attributionAgent } = await parseTranscript(
      filePath,
      cutoffMs
    );
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

  const output = {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    days: dayList,
    projects: projectList,
    workflows: workflowList,
    skills: skillList,
    agents: agentList,
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
  const topSkill = skillList[0];
  const topSkillText = topSkill
    ? `, top skill /${topSkill.label} $${topSkill.avgCostUsd.toFixed(2)}/run x${topSkill.runs}`
    : "";
  const topAgent = agentList[0];
  const topAgentText = topAgent
    ? `, top agent ${topAgent.key} $${topAgent.costUsd.toFixed(2)} x${topAgent.runs} run(s)`
    : "";
  console.log(
    `usage-stats: ${transcripts.length} transcript(s), ${totalMessages} message(s), ` +
      `today $${todayCostUsd.toFixed(2)}, 7d $${last7DaysCostUsd.toFixed(2)}, 30d $${last30DaysCostUsd.toFixed(2)}${topWorkflowText}${topSkillText}${topAgentText} -> ${outFile}`
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
