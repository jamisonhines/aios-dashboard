// Pure view-model functions shared between main.ts and the test suites.
// No Obsidian dependency, no filesystem/network access, no wall-clock reads
// except where the caller passes a Date in explicitly. main.ts imports this
// module directly (esbuild bundles plain ESM fine); each *.test.mjs file
// imports the SAME functions instead of hand-copying them, so behavior can
// never silently drift between the plugin and its tests.
// Build 2.6 m1: de-mirror the tests.

// GL-011 session-coordination parsers: CANONICAL HOME is the vault's own
// ~/AIOS/Operations/scripts/lib/coordination-parse.mjs (three vault Node
// scripts also import it directly -- branch-inventory.mjs,
// coordination-report.mjs, and aios-health.mjs's Coordination drift
// section). This is the ONLY import site for that module inside the plugin;
// computeCoordinationView (below) is built on it, and spliceAnswer is
// re-exported as-is for main.ts's answer write-back path.
import {
  parseActiveSessions,
  parseLandingOrder,
  parseQuestionsOpen,
  hoursSince,
  spliceAnswer,
} from "../../AIOS/Operations/scripts/lib/coordination-parse.mjs";

export { spliceAnswer };

// ---------------------------------------------------------------------------
// Buckets / status sections (Projects + Tasks tabs)
// ---------------------------------------------------------------------------

/** @typedef {{ slug: string, label: string }} Bucket */

/** Default standalone-task buckets (used when the Dashboard note declares none). */
export const DEFAULT_BUCKETS = [
  { slug: "identity", label: "Identity" },
  { slug: "work", label: "Work" },
  { slug: "family", label: "Family" },
  { slug: "health", label: "Health" },
  { slug: "growth", label: "Growth" },
  { slug: "money", label: "Money" },
  { slug: "ai", label: "AI" },
  { slug: "web-design", label: "Web Design" },
  { slug: "georgian", label: "Georgian" },
];

/**
 * Resolve buckets from the host note's frontmatter `dashboard_buckets:`
 * (array of {slug,label}); fall back to DEFAULT_BUCKETS.
 * @param {Record<string, unknown> | undefined} fm
 * @returns {Bucket[]}
 */
export function resolveBuckets(fm) {
  const raw = fm?.["dashboard_buckets"];
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw
      .filter((b) => b && typeof b.slug === "string" && typeof b.label === "string")
      .map((b) => ({ slug: b.slug, label: b.label }));
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_BUCKETS;
}

/** @typedef {{ slug: string, label: string, open: boolean }} StatusSection */

/** @type {StatusSection[]} */
export const DEFAULT_STATUS_SECTIONS = [
  { slug: "active", label: "Active", open: true },
  { slug: "planning", label: "Planning", open: true },
  { slug: "paused", label: "Paused", open: true },
  { slug: "done", label: "Done", open: false },
  { slug: "archived", label: "Archived", open: false },
];

/**
 * Resolve status sections from the host note's `dashboard_project_statuses:`
 * (array of {slug,label,open?}); fall back to DEFAULT_STATUS_SECTIONS. `open`
 * defaults true unless explicitly false.
 * @param {Record<string, unknown> | undefined} fm
 * @returns {StatusSection[]}
 */
export function resolveStatusSections(fm) {
  const raw = fm?.["dashboard_project_statuses"];
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw
      .filter((b) => b && typeof b.slug === "string" && typeof b.label === "string")
      .map((b) => ({ slug: b.slug, label: b.label, open: b.open !== false }));
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_STATUS_SECTIONS;
}

/**
 * Bucket projects into ordered status groups. Returns ONLY non-empty groups,
 * in the order of `sections`; projects whose status is outside the
 * configured set are collected into a trailing "Other" group so drift is
 * surfaced, never silently dropped. Projects inside a group are sorted by
 * name.
 * @param {any[]} projects
 * @param {StatusSection[]} sections
 */
export function groupProjectsByStatus(projects, sections) {
  const known = new Set(sections.map((s) => s.slug));
  const byName = (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  const out = [];
  for (const sec of sections) {
    const inSec = projects.filter((p) => p.status === sec.slug).sort(byName);
    if (inSec.length > 0) {
      out.push({ slug: sec.slug, label: sec.label, open: sec.open, projects: inSec });
    }
  }
  const drift = projects.filter((p) => !known.has(p.status)).sort(byName);
  if (drift.length > 0) {
    out.push({ slug: "other", label: "Other", open: true, projects: drift });
  }
  return out;
}

// ---------------------------------------------------------------------------
// View-model helpers (Projects/Tasks tabs)
// ---------------------------------------------------------------------------

/**
 * Projects-tab status chips: one per non-empty status group, label + count,
 * order preserved (Other stays last). Derived from groupProjectsByStatus
 * output so the two never disagree.
 */
export function statusChipsFromGroups(groups) {
  return groups.map((g) => ({ slug: g.slug, label: g.label, count: g.projects.length }));
}

/**
 * Partition a project's tasks (caller passes non-cancelled tasks) into
 * in-progress / open / done buckets. Unknown statuses are ignored. Caller
 * sorts each bucket for display.
 */
export function splitProjectTasks(tasks) {
  return {
    doing: tasks.filter((t) => t.status === "in-progress"),
    open: tasks.filter((t) => t.status === "open"),
    done: tasks.filter((t) => t.status === "done"),
  };
}

/**
 * Tasks-tab category chips: one per bucket with >=1 standalone task, plus an
 * `inbox` entry when any standalone task has no recognized life-area. The
 * renderer prepends an "All" chip.
 */
export function categoryChipsFromTasks(standaloneTasks, buckets) {
  const out = [];
  for (const b of buckets) {
    const count = standaloneTasks.filter((t) => t.lifeAreas.includes(b.slug)).length;
    if (count > 0) out.push({ slug: b.slug, label: b.label, count });
  }
  const known = buckets.map((b) => b.slug);
  const inboxCount = standaloneTasks.filter((t) => !t.lifeAreas.some((a) => known.includes(a))).length;
  if (inboxCount > 0) out.push({ slug: "inbox", label: "Inbox", count: inboxCount });
  return out;
}

/**
 * The single category pill shown on a standalone task row: the first
 * recognized life-area (in bucket order), else Inbox.
 */
export function tagForTask(task, buckets) {
  for (const b of buckets) {
    if (task.lifeAreas.includes(b.slug)) return { slug: b.slug, label: b.label };
  }
  return { slug: "inbox", label: "Inbox" };
}

/**
 * Filter the flat standalone list by the selected category chip. `all` =
 * passthrough, `inbox` = tasks with no recognized life-area, otherwise tasks
 * tagged with that slug.
 */
export function filterStandaloneByCategory(standaloneTasks, categorySlug, buckets) {
  if (categorySlug === "all") return standaloneTasks;
  if (categorySlug === "inbox") {
    const known = buckets.map((b) => b.slug);
    return standaloneTasks.filter((t) => !t.lifeAreas.some((a) => known.includes(a)));
  }
  return standaloneTasks.filter((t) => t.lifeAreas.includes(categorySlug));
}

/** Shared task sort: priority asc (unset -> 5), then due asc (unset -> last), then title. */
export function sortTasks(a, b) {
  const pa = a.priority ?? 5;
  const pb = b.priority ?? 5;
  if (pa !== pb) return pa - pb;
  const da = a.due || "9999";
  const db = b.due || "9999";
  if (da !== db) return da < db ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/**
 * Tasks to show inside a phase given the two per-project toggles. Open shows
 * when showOpen, done shows when showComplete; in-progress lives in the
 * DOING NOW strip and cancelled is never shown. Sorted by the shared
 * sortTasks order so open and done interleave in sequence.
 */
export function visiblePhaseTasks(phaseTasks, showOpen, showComplete) {
  return phaseTasks
    .filter((t) => (t.status === "open" && showOpen) || (t.status === "done" && showComplete))
    .sort(sortTasks);
}

// ---------------------------------------------------------------------------
// Health model (pure). gatherHealthInput in main.ts is the impure half that
// turns live vault/metadataCache state into this plain-data shape.
// ---------------------------------------------------------------------------

// Canned Dispatch prompt per health-tile key, shown as "Fix with Dispatch" in
// the detail modal. Keyed by HealthTile.key (the internal computeHealth id,
// not the UI label). stale-in-progress and stale-open share the same
// reconcile prompt; orphan-tasks and status-mismatch share the same
// consistency-fix prompt.
export const HEALTH_TILE_PROMPTS = {
  intake:
    "Process the Intake inbox: route each item per AGENTS.md (Capture for personal, SOP-ingest-source for external content).",
  "journal-unmined":
    "List journal entries with ingested: false and ingest the ones worth mining per GL-007: create derived area notes linking back, then flip ingested to true.",
  "stale-in-progress":
    "Run a task reconcile pass per Dispatch's reconcile protocol: flip shipped tasks to done with evidence, cancel overtaken ones, list uncertain ones.",
  "stale-open":
    "Run a task reconcile pass per Dispatch's reconcile protocol: flip shipped tasks to done with evidence, cancel overtaken ones, list uncertain ones.",
  "orphan-tasks":
    "Fix task-layer consistency: repoint or fix tasks whose project slug matches no hub and tasks whose status disagrees with their folder.",
  "status-mismatch":
    "Fix task-layer consistency: repoint or fix tasks whose project slug matches no hub and tasks whose status disagrees with their folder.",
  "broken-links":
    "Fix broken wikilinks per GL-001: repoint renamed targets, convert out-of-vault targets to backtick paths, strip dead ones.",
};

/** Same rule main.ts uses to derive a task's status from its folder location. */
export function healthInferStatusFromPath(path) {
  if (path.includes("/done/")) return "done";
  if (path.includes("/cancelled/")) return "cancelled";
  if (path.includes("/in-progress/")) return "in-progress";
  return "open";
}

export function excludedBySource(source, excludes) {
  return excludes.some((ex) => source === ex || source.startsWith(ex + "/"));
}

/**
 * Compute the health tiles from plain, pre-gathered data. Tiles whose count
 * is zero are omitted entirely (calm when healthy). No Obsidian API calls
 * here.
 */
export function computeHealth(input) {
  const tiles = [];

  // 1. Intake backlog: exclude README.md and dotfiles.
  const intake = input.intakeFiles.filter((f) => f.name !== "README.md" && !f.name.startsWith("."));
  if (intake.length > 0) {
    const sorted = intake.slice().sort((a, b) => b.ageDays - a.ageDays);
    const oldest = sorted[0].ageDays;
    tiles.push({
      key: "intake",
      label: "Intake backlog",
      count: intake.length,
      summary: `${intake.length} · oldest ${oldest}d`,
      warn: oldest > input.thresholds.intakeWarnDays,
      items: sorted.map((f) => ({ path: f.path, label: f.name, detail: `${f.ageDays}d old` })),
      prompt: HEALTH_TILE_PROMPTS["intake"],
    });
  }

  // 2. Stale in-progress tasks.
  const staleInProgress = input.tasks.filter(
    (t) => t.status === "in-progress" && t.ageDays > input.thresholds.inProgressStaleDays
  );
  if (staleInProgress.length > 0) {
    tiles.push({
      key: "stale-in-progress",
      label: "Stale in-progress",
      count: staleInProgress.length,
      summary: `${staleInProgress.length}`,
      warn: true,
      items: staleInProgress
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((t) => ({ path: t.path, label: t.title, detail: `${t.ageDays}d since update` })),
      prompt: HEALTH_TILE_PROMPTS["stale-in-progress"],
    });
  }

  // 3. Stale open tasks.
  const staleOpen = input.tasks.filter(
    (t) => t.status === "open" && t.ageDays > input.thresholds.openStaleDays
  );
  if (staleOpen.length > 0) {
    tiles.push({
      key: "stale-open",
      label: "Stale open",
      count: staleOpen.length,
      summary: `${staleOpen.length}`,
      warn: true,
      items: staleOpen
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((t) => ({ path: t.path, label: t.title, detail: `${t.ageDays}d since update` })),
      prompt: HEALTH_TILE_PROMPTS["stale-open"],
    });
  }

  // 4. Un-mined journal entries (excludes INDEX.md).
  const unmined = input.journalFiles.filter((f) => f.name !== "INDEX.md" && !f.ingested);
  if (unmined.length > 0) {
    tiles.push({
      key: "journal-unmined",
      label: "journal not mined",
      count: unmined.length,
      summary: `${unmined.length}`,
      warn: false,
      items: unmined.map((f) => ({ path: f.path, label: f.name, detail: "not ingested" })),
      prompt: HEALTH_TILE_PROMPTS["journal-unmined"],
    });
  }

  // 5. Orphan tasks: project set but not a known project slug.
  const knownSlugs = new Set(input.projectSlugs);
  const orphans = input.tasks.filter((t) => t.project != null && !knownSlugs.has(t.project));
  if (orphans.length > 0) {
    tiles.push({
      key: "orphan-tasks",
      label: "Orphan tasks",
      count: orphans.length,
      summary: `${orphans.length}`,
      warn: true,
      items: orphans.map((t) => ({
        path: t.path,
        label: t.title,
        detail: `project: ${t.project}`,
      })),
      prompt: HEALTH_TILE_PROMPTS["orphan-tasks"],
    });
  }

  // 6. Status/folder mismatch: declared frontmatter status disagrees with folder.
  const mismatches = input.tasks.filter(
    (t) => t.declaredStatus != null && t.declaredStatus !== healthInferStatusFromPath(t.path)
  );
  if (mismatches.length > 0) {
    tiles.push({
      key: "status-mismatch",
      label: "Status/folder mismatch",
      count: mismatches.length,
      summary: `${mismatches.length}`,
      warn: true,
      items: mismatches.map((t) => ({
        path: t.path,
        label: t.title,
        detail: `status: ${t.declaredStatus}, folder: ${healthInferStatusFromPath(t.path)}`,
      })),
      prompt: HEALTH_TILE_PROMPTS["status-mismatch"],
    });
  }

  // 7. Broken links: unresolved wikilinks, excluding sources under linkCheckExcludes.
  const links = input.unresolvedLinks.filter((l) => !excludedBySource(l.source, input.linkCheckExcludes));
  const brokenTotal = links.reduce((sum, l) => sum + l.count, 0);
  if (brokenTotal > 0) {
    const bySource = new Map();
    for (const l of links) bySource.set(l.source, (bySource.get(l.source) || 0) + l.count);
    const items = Array.from(bySource.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({
        path: source,
        label: source,
        detail: `${count} broken link${count === 1 ? "" : "s"}`,
      }));
    tiles.push({
      key: "broken-links",
      label: "Broken links",
      count: brokenTotal,
      summary: `${brokenTotal}`,
      warn: true,
      items,
      prompt: HEALTH_TILE_PROMPTS["broken-links"],
    });
  }

  return tiles;
}

// ---------------------------------------------------------------------------
// Incidents strip (pure). Reads the plain-data view of Operations/incidents/
// notes (path + raw frontmatter, gathered by the impure half in main.ts) and
// returns only the open ones, newest-detected first. Notes are written by an
// unattended 3am script and possibly hand-edited afterwards, so every field
// is read defensively: a missing/malformed frontmatter, an absent or garbled
// `detected` date, a wrong-case `status`, or a `tags` value that isn't a list
// must all degrade gracefully rather than throw and take the whole dashboard
// down. A malformed note is not silently dropped merely for being malformed;
// it is dropped only if its status does not resolve to "open".
// ---------------------------------------------------------------------------

/**
 * @typedef {{ path: string, item: string, summary: string, property: string, ageDays: number, prompt: string }} IncidentRow
 */

/**
 * @param {{ notes: { path?: unknown, frontmatter?: unknown }[], now?: Date }} input
 * @returns {IncidentRow[]}
 */
export function computeIncidents(input) {
  const notes = Array.isArray(input?.notes) ? input.notes : [];
  const now = input?.now instanceof Date && !isNaN(input.now.getTime()) ? input.now : new Date();
  const nowMs = now.getTime();

  const rows = [];
  for (const note of notes) {
    if (!note || typeof note !== "object") continue;
    const path = typeof note.path === "string" && note.path.length > 0 ? note.path : null;
    if (!path) continue;

    const fm = note.frontmatter && typeof note.frontmatter === "object" ? note.frontmatter : {};

    const status = typeof fm.status === "string" ? fm.status.trim().toLowerCase() : "";
    if (status !== "open") continue; // resolved, missing, or unrecognized status: not surfaced

    const item = typeof fm.item === "string" && fm.item.trim() ? fm.item.trim() : path.split("/").pop();
    const summary = typeof fm.summary === "string" ? fm.summary.trim() : "";
    const property = typeof fm.property === "string" ? fm.property.trim() : "";

    const detectedMs = typeof fm.detected === "string" ? Date.parse(fm.detected) : NaN;
    const hasDetected = !isNaN(detectedMs);
    const ageDays = hasDetected ? Math.max(0, Math.floor((nowMs - detectedMs) / 86400000)) : 0;

    const rawPrompt = typeof fm.prompt === "string" ? fm.prompt.trim() : "";
    const prompt =
      rawPrompt.length > 0
        ? rawPrompt
        : `Read ${path} and pick up the incident from there. It has no canned starter prompt, so orient yourself from the note (what broke, what was done) before acting.`;

    rows.push({
      path,
      item,
      summary,
      property,
      ageDays,
      prompt,
      _sortMs: hasDetected ? detectedMs : -Infinity, // undated notes sink to the bottom, never lead
    });
  }

  rows.sort((a, b) => b._sortMs - a._sortMs);
  return rows.map(({ _sortMs, ...row }) => row);
}

// ---------------------------------------------------------------------------
// Usage model (pure). renderUsageTab in main.ts is the impure half that
// reads usage-stats.json off disk and turns it into this plain-data shape.
// ---------------------------------------------------------------------------

// Fixed family order: drives stacking order, legend order, and table order so
// the three views never disagree with each other.
export const USAGE_FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku", "other"];
export const USAGE_FAMILY_LABELS = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  other: "Other",
};

export function usagePad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

/** Local (not UTC) calendar-day key, matching the exporter's per-day bucketing. */
export function usageLocalDayKey(d) {
  return d.getFullYear() + "-" + usagePad2(d.getMonth() + 1) + "-" + usagePad2(d.getDate());
}

export function usageEmptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 0, costUsd: 0 };
}

/**
 * Compact number formatting for token counts: 1.2k, 3.4M, 4.2M, 1.5B. Plain
 * integers stay plain below 1000.
 */
export function formatCompactNumber(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return sign + Math.round(abs).toString();
}

export function formatUsd(n) {
  return "$" + n.toFixed(2);
}

/**
 * Per-model-family legend + breakdown table for an arbitrary continuous day
 * window. Extracted (Phase 1 System-browser range toggle, 2026-08-04) from
 * computeUsageView so the same aggregation can run over ANY window
 * (computeUsageWindow's range-scoped slice), not only the fixed 30-day one --
 * this is what lets the "Model breakdown" table follow the range toggle.
 */
export function usageFamilyBreakdown(windowDays) {
  const famTotals = new Map();
  for (const d of windowDays) {
    for (const fam of Object.keys(d.models)) {
      const b = d.models[fam];
      const acc = famTotals.get(fam) || usageEmptyBucket();
      acc.inputTokens += b.inputTokens;
      acc.outputTokens += b.outputTokens;
      acc.cacheReadTokens += b.cacheReadTokens;
      acc.cacheWriteTokens += b.cacheWriteTokens;
      acc.messages += b.messages;
      acc.costUsd += b.costUsd;
      famTotals.set(fam, acc);
    }
  }

  const legend = USAGE_FAMILY_ORDER.filter((f) => famTotals.has(f)).map((f) => ({
    family: f,
    label: USAGE_FAMILY_LABELS[f],
    costUsd: famTotals.get(f).costUsd,
  }));

  const totalCostUsd = USAGE_FAMILY_ORDER.reduce(
    (sum, f) => sum + (famTotals.has(f) ? famTotals.get(f).costUsd : 0),
    0
  );
  const safeTotalCostUsd = totalCostUsd > 0 ? totalCostUsd : 1;

  const table = USAGE_FAMILY_ORDER.filter((f) => famTotals.has(f)).map((f) => {
    const b = famTotals.get(f);
    return {
      family: f,
      label: USAGE_FAMILY_LABELS[f],
      messages: b.messages,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheReadTokens: b.cacheReadTokens,
      costUsd: b.costUsd,
      // Models breakdown section (header/tabs restructure, 2026-08): each
      // row's share of this window's total cost, so the "Models" table can
      // show a % column like the Workflows/Skills tables do without the
      // renderer re-deriving it from a running sum.
      sharePercent: (b.costUsd / safeTotalCostUsd) * 100,
    };
  });

  return { legend, table };
}

/**
 * Pure view-model function: turns the exporter's usage-stats.json shape plus
 * "now" into everything the Usage tab renders (tiles, chart, legend, table,
 * projects). `nowDate` is passed in (not read from the clock) so the tile
 * math (today/7d/30d boundaries) and the always-30-entries chart window are
 * unit-testable without mocking time.
 *
 * NOTE (Phase 1 System-browser range toggle, 2026-08-04): this fixed-30-day
 * view still exists and is still tested as-is (nothing here changed
 * behavior), but the Usage tab no longer renders its `tiles`/`legend`/
 * `table` directly -- those are now recomputed per the selected range via
 * computeUsageRangeTiles/usageFamilyBreakdown over computeUsageWindow's
 * slice. `hasData` and `projects` (which has no per-day breakdown to scope
 * by range) are still sourced from here.
 */
export function computeUsageView(stats, nowDate) {
  const dayByDate = new Map(stats.days.map((d) => [d.date, d]));

  // A continuous 30-calendar-day window ending today. Days with no transcript
  // activity are zero-cost placeholders, not omitted, so the chart always has
  // exactly 30 bars.
  const windowDays = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
    const key = usageLocalDayKey(d);
    windowDays.push(dayByDate.get(key) || { date: key, models: {}, totalCostUsd: 0, totalOutputTokens: 0 });
  }

  const todayKey = usageLocalDayKey(nowDate);
  const todayCostUsd = dayByDate.get(todayKey)?.totalCostUsd || 0;
  const last7DaysCostUsd = windowDays.slice(-7).reduce((s, d) => s + d.totalCostUsd, 0);
  const last30DaysCostUsd = windowDays.reduce((s, d) => s + d.totalCostUsd, 0);
  const last30DaysOutputTokens = windowDays.reduce((s, d) => s + d.totalOutputTokens, 0);

  const maxCost = Math.max(0, ...windowDays.map((d) => d.totalCostUsd));
  const safeMax = maxCost > 0 ? maxCost : 1;

  const chartDays = windowDays.map((d) => {
    const segments = [];
    for (const fam of USAGE_FAMILY_ORDER) {
      const bucket = d.models[fam];
      if (!bucket || bucket.costUsd <= 0) continue;
      segments.push({ family: fam, costUsd: bucket.costUsd, heightFraction: bucket.costUsd / safeMax });
    }
    return { date: d.date, totalCostUsd: d.totalCostUsd, totalFraction: d.totalCostUsd / safeMax, segments };
  });

  const gridlines = [1, 0.5, 0].map((frac) => ({
    fraction: frac,
    value: maxCost * frac,
    label: formatUsd(maxCost * frac),
  }));

  const xLabelIndices = [];
  for (let i = 0; i < windowDays.length; i += 7) xLabelIndices.push(i);
  if (xLabelIndices[xLabelIndices.length - 1] !== windowDays.length - 1) {
    xLabelIndices.push(windowDays.length - 1);
  }

  // 30d per-family totals, feeding both the legend and the breakdown table.
  const { legend, table } = usageFamilyBreakdown(windowDays);

  const projects = stats.projects
    .slice()
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8)
    .map((p) => ({ name: p.name, costUsd: p.costUsd, outputTokens: p.outputTokens }));

  return {
    hasData: stats.days.length > 0,
    tiles: {
      todayCostUsd,
      last7DaysCostUsd,
      last30DaysCostUsd,
      last30DaysOutputTokensCompact: formatCompactNumber(last30DaysOutputTokens),
    },
    chart: { days: chartDays, maxCost, gridlines, xLabelIndices },
    legend,
    table,
    projects,
  };
}

// ---------------------------------------------------------------------------
// Usage range window (build 2.8): 1D/7D/30D toggle + prev/next paging over the
// exporter's daily buckets. Pure; the impure half (render + resize) is in
// main.ts renderUsageTab.
// ---------------------------------------------------------------------------

/** Window length in days per range slug. "all" has no fixed length -- see computeUsageWindow. */
export const USAGE_RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30 };

/**
 * Human period label per range slug, for the sticky header and range-scoped
 * subheads ("Skills (Last 7 days)" etc). Distinct from the date-range label
 * computeUsageWindow returns ("Jul 8 - Jul 14") -- this is the fixed name of
 * the period itself, always legible even when the window is empty.
 */
export const USAGE_RANGE_LABELS = {
  "1d": "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All available",
};

const USAGE_MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-07-08" -> "Jul 8". Pure string math, no Date parsing (no TZ drift). */
export function formatUsageDayShort(key) {
  const parts = key.split("-");
  const month = USAGE_MONTHS_SHORT[Number(parts[1]) - 1] || parts[1];
  return month + " " + Number(parts[2]);
}

/** Window label: "Jul 8 - Jul 14" for multi-day, "Jul 14" for a single day. */
export function formatUsageWindowLabel(startKey, endKey) {
  if (startKey === endKey) return formatUsageDayShort(startKey);
  return formatUsageDayShort(startKey) + " - " + formatUsageDayShort(endKey);
}

/**
 * The visible usage window: a continuous zero-filled slice of `days` (the
 * exporter's sparse day buckets), `range` in {"1d","7d","30d","all"},
 * `offset` = how many windows back from the one ending today (0 = current,
 * ignored for "all"). Returns the slice plus label and canPrev/canNext for
 * the paging arrows: canNext is false at offset 0, canPrev is false once the
 * previous window would start before the earliest day present in the data.
 *
 * "all" (Phase 1 System-browser range toggle, 2026-08-04) is every day the
 * exporter scanned, not a fixed length: a continuous zero-filled span from
 * the earliest day present in `days` through today. Paging is meaningless
 * for a window that's already everything, so canPrev/canNext are always
 * false and `offset` is ignored.
 */
export function computeUsageWindow(days, range, offset, todayDate) {
  const dayByDate = new Map(days.map((d) => [d.date, d]));

  if (range === "all") {
    let earliest = null;
    for (const d of days) if (earliest === null || d.date < earliest) earliest = d.date;
    const todayKey = usageLocalDayKey(todayDate);
    const startKey = earliest !== null && earliest < todayKey ? earliest : todayKey;

    const windowDays = [];
    let cursor = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
    // Walk backward from today to startKey, then reverse -- simplest way to
    // get a correct calendar walk (handles month/year boundaries) without
    // computing a day-count first.
    while (usageLocalDayKey(cursor) >= startKey) {
      const key = usageLocalDayKey(cursor);
      windowDays.unshift(dayByDate.get(key) || { date: key, models: {}, totalCostUsd: 0, totalOutputTokens: 0 });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
    }

    return {
      range,
      offset: 0,
      days: windowDays,
      label: formatUsageWindowLabel(windowDays[0].date, windowDays[windowDays.length - 1].date),
      canPrev: false,
      canNext: false,
    };
  }

  const len = USAGE_RANGE_DAYS[range] || 7;
  const safeOffset = Math.max(0, offset | 0);

  const windowDays = [];
  for (let i = len - 1; i >= 0; i--) {
    const shift = safeOffset * len + i;
    const d = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - shift);
    const key = usageLocalDayKey(d);
    windowDays.push(
      dayByDate.get(key) || { date: key, models: {}, totalCostUsd: 0, totalOutputTokens: 0 }
    );
  }

  let earliest = null;
  for (const d of days) if (earliest === null || d.date < earliest) earliest = d.date;

  const startKey = windowDays[0].date;
  const endKey = windowDays[windowDays.length - 1].date;
  return {
    range,
    offset: safeOffset,
    days: windowDays,
    label: formatUsageWindowLabel(startKey, endKey),
    canPrev: earliest !== null && earliest < startKey,
    canNext: safeOffset > 0,
  };
}

/**
 * Offset-aware period label (Reviewer M4, 2026-08-04): USAGE_RANGE_LABELS is
 * only true at offset 0 -- "Last 7 days" paged back one window is actually
 * last-last week, and "Today" paged back one day is actually yesterday.
 * Falls back to the window's own concrete date-range label (`win.label`,
 * e.g. "Jul 1 - Jul 7") whenever offset != 0, so a scoped number is never
 * shown under a period name that no longer describes it. "all" never pages
 * (computeUsageWindow always returns offset: 0 for it), so it always reads
 * "All available" here.
 */
export function usageScopedRangeLabel(win) {
  if (win.offset === 0) return USAGE_RANGE_LABELS[win.range] || win.label;
  return win.label;
}

/**
 * Total spend + output tokens tiles for an arbitrary continuous day window
 * (Phase 1 System-browser range toggle, 2026-08-04). Replaces the old fixed
 * Today/7d/30d tiles: the Usage tab now shows exactly two numbers, both
 * scoped to whatever range is selected, so the tiles never disagree with the
 * chart/tables below them. `rangeLabel` (from USAGE_RANGE_LABELS) is passed
 * straight through so the renderer doesn't need to re-derive it.
 */
export function computeUsageRangeTiles(windowDays, rangeLabel) {
  const costUsd = windowDays.reduce((s, d) => s + d.totalCostUsd, 0);
  const outputTokens = windowDays.reduce((s, d) => s + d.totalOutputTokens, 0);
  return {
    rangeLabel,
    costUsd,
    outputTokens,
    outputTokensCompact: formatCompactNumber(outputTokens),
  };
}

/**
 * Stacked-bar chart data for an arbitrary continuous day window: same shape
 * as computeUsageView's fixed 30-day chart (segments per family, gridlines,
 * sparse x labels), generalized to any window length. Short windows label
 * every day; long ones label every 7th plus the last.
 */
export function usageChartFromWindow(windowDays) {
  const maxCost = Math.max(0, ...windowDays.map((d) => d.totalCostUsd));
  const safeMax = maxCost > 0 ? maxCost : 1;

  const chartDays = windowDays.map((d) => {
    const segments = [];
    for (const fam of USAGE_FAMILY_ORDER) {
      const bucket = d.models[fam];
      if (!bucket || bucket.costUsd <= 0) continue;
      segments.push({ family: fam, costUsd: bucket.costUsd, heightFraction: bucket.costUsd / safeMax });
    }
    return { date: d.date, totalCostUsd: d.totalCostUsd, totalFraction: d.totalCostUsd / safeMax, segments };
  });

  const gridlines = [1, 0.5, 0].map((frac) => ({
    fraction: frac,
    value: maxCost * frac,
    label: formatUsd(maxCost * frac),
  }));

  const step = windowDays.length > 10 ? 7 : 1;
  const xLabelIndices = [];
  for (let i = 0; i < windowDays.length; i += step) xLabelIndices.push(i);
  if (xLabelIndices[xLabelIndices.length - 1] !== windowDays.length - 1) {
    xLabelIndices.push(windowDays.length - 1);
  }

  return { days: chartDays, maxCost, gridlines, xLabelIndices };
}

/**
 * Per-family grouped bars for the 1D view: one bar per model family active
 * that day, fraction relative to the costliest family. Empty days return
 * an empty bars array (the renderer shows an empty-state hint).
 */
export function usageDayFamilyBars(day) {
  const raw = [];
  for (const fam of USAGE_FAMILY_ORDER) {
    const bucket = day.models[fam];
    if (!bucket || bucket.costUsd <= 0) continue;
    raw.push({ family: fam, label: USAGE_FAMILY_LABELS[fam], costUsd: bucket.costUsd });
  }
  const maxCost = Math.max(0, ...raw.map((b) => b.costUsd));
  const safeMax = maxCost > 0 ? maxCost : 1;
  const bars = raw.map((b) => ({ ...b, fraction: b.costUsd / safeMax }));
  const gridlines = [1, 0.5, 0].map((frac) => ({
    fraction: frac,
    value: maxCost * frac,
    label: formatUsd(maxCost * frac),
  }));
  return { date: day.date, bars, maxCost, gridlines };
}

// Known workflow keys in the exporter's classification order. Drives a
// stable color index per key so the share bar, legend, and table dots never
// disagree and colors don't shift as costs change between runs.
export const USAGE_WORKFLOW_COLOR_ORDER = [
  "telegram-bridge",
  "telegram-ingest",
  "email-router",
  "email-followups",
  "email-postmortem",
  "email-other",
  "learning-scan",
  "interactive",
];
export const USAGE_WORKFLOW_COLOR_COUNT = 8;

/**
 * Stable color index for a workflow key: known keys map to a fixed slot; any
 * future key (added to the exporter's rule table later) falls back to a
 * deterministic hash so it still always lands on the same color.
 */
export function usageWorkflowColorIndex(key) {
  const idx = USAGE_WORKFLOW_COLOR_ORDER.indexOf(key);
  if (idx >= 0) return idx;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % USAGE_WORKFLOW_COLOR_COUNT;
}

/**
 * Pure view-model function: turns the exporter's optional `workflows` block
 * into the share-bar + table shapes the Usage tab renders. Missing/empty
 * `workflows` (old JSON, or a window with no transcripts) yields hasData:
 * false so the caller can hide the whole section. Order is preserved as
 * delivered by the exporter (sorted by costUsd desc).
 */
export function computeWorkflowsView(stats) {
  const workflows = stats.workflows;
  if (!Array.isArray(workflows) || workflows.length === 0) {
    return { hasData: false, shareBar: [], table: [] };
  }

  const total = workflows.reduce((s, w) => s + w.costUsd, 0);
  const safeTotal = total > 0 ? total : 1;

  const shareBar = workflows.map((w) => ({
    key: w.key,
    label: w.label,
    costUsd: w.costUsd,
    sharePercent: (w.costUsd / safeTotal) * 100,
    colorIndex: usageWorkflowColorIndex(w.key),
  }));

  const table = workflows.map((w) => ({ ...w, colorIndex: usageWorkflowColorIndex(w.key) }));

  return { hasData: true, shareBar, table };
}

/**
 * Range-scoped workflows view (Phase 1 System-browser range toggle,
 * 2026-08-04): recomputes cost/tokens/messages/sessions from each workflow's
 * `byDay` breakdown summed over `windowDays` (computeUsageWindow's slice),
 * instead of always showing the fixed all-time total under whatever range
 * button happens to be active.
 *
 * A workflow entry with no `byDay` at all (JSON written before build 2.9
 * slice 2) has no per-day data to scope -- its full-time total is shown
 * regardless of range, flagged `partial: true` so the caller can label it
 * honestly rather than silently mislabeling an all-time number as
 * range-scoped. Workflows with `byDay` but zero activity inside the window
 * are dropped (nothing to show for that range). Sorted by costUsd desc.
 *
 * Reviewer M3 (2026-08-04, found against Jaymo's live usage-stats.json):
 * `byDay` can exist WITHOUT a `sessions` key on its day buckets -- that's
 * exactly the shape every workflow in JSON written before the per-day
 * session fold (this same Phase 1 slice) has. Cost/tokens/messages are
 * still genuinely scoped from that byDay, but summing a missing `sessions`
 * key silently produces 0 for every range, which reads as "this workflow
 * had zero runs this week" -- a wrong number, not an honest one. Detected
 * per-workflow (`hasSessionsPerDay`) and, when absent, the Runs column
 * falls back to the workflow's all-time session count and the row is
 * flagged `sessionsPartial: true` so the renderer can label just that
 * column honestly, without also declaring the (correctly scoped)
 * cost/tokens/messages partial.
 */
export function computeWorkflowsViewForRange(stats, windowDays, range) {
  const workflows = stats.workflows;
  if (!Array.isArray(workflows) || workflows.length === 0) {
    return { hasData: false, shareBar: [], table: [] };
  }

  const dateKeys = windowDays.map((d) => d.date);
  const rows = [];
  for (const w of workflows) {
    if (!w.byDay) {
      rows.push({
        key: w.key,
        label: w.label,
        costUsd: w.costUsd,
        outputTokens: w.outputTokens,
        messages: w.messages,
        sessions: w.sessions,
        partial: true,
        sessionsPartial: true,
      });
      continue;
    }
    const hasSessionsPerDay = Object.values(w.byDay).some((d) => typeof d.sessions === "number");

    // "all" already covers the workflow's whole recorded history (its
    // byDay never has entries outside what windowDays spans), so summing
    // over the exact same date keys is correct for every range including
    // "all" -- no special case needed here.
    let costUsd = 0, outputTokens = 0, messages = 0, sessions = 0;
    for (const dk of dateKeys) {
      const d = w.byDay[dk];
      if (!d) continue;
      costUsd += d.costUsd;
      outputTokens += d.outputTokens;
      messages += d.messages;
      if (hasSessionsPerDay) sessions += d.sessions || 0;
    }
    // The Runs/sessions fallback uses the workflow's ALL-TIME session count
    // when there's no per-day session data to scope -- honestly wrong-scope
    // (a real number, just not range-limited) instead of silently wrong
    // (zero, which reads as "no activity"). The zero-activity drop below
    // deliberately ignores `sessions` for this reason: a workflow with zero
    // in-window cost/messages must still be dropped even though its
    // fallback `sessions` value is a nonzero all-time count.
    if (!hasSessionsPerDay) sessions = w.sessions || 0;
    if (costUsd <= 0 && messages === 0) continue;
    rows.push({
      key: w.key,
      label: w.label,
      costUsd,
      outputTokens,
      messages,
      sessions,
      partial: false,
      sessionsPartial: !hasSessionsPerDay,
    });
  }
  rows.sort((a, b) => b.costUsd - a.costUsd);

  const total = rows.reduce((s, w) => s + w.costUsd, 0);
  const safeTotal = total > 0 ? total : 1;

  const shareBar = rows.map((w) => ({
    key: w.key,
    label: w.label,
    costUsd: w.costUsd,
    sharePercent: (w.costUsd / safeTotal) * 100,
    colorIndex: usageWorkflowColorIndex(w.key),
  }));

  const table = rows.map((w) => ({ ...w, colorIndex: usageWorkflowColorIndex(w.key) }));

  return { hasData: table.length > 0, shareBar, table, range };
}

// Skills section shows this many rows collapsed; the rest hide behind the
// show-more toggle.
export const USAGE_SKILLS_TOP_N = 5;

/**
 * Pure view-model function: turns the exporter's optional `skills` block (one
 * entry per skill/slash-command, aggregated across per-invocation runs) into
 * the collapsed-or-expanded table the Usage tab renders. Missing/empty
 * `skills` (JSON written before build 2.9) yields hasData: false so the
 * caller hides the whole section. Order is preserved as delivered by the
 * exporter (sorted by costUsd desc).
 */
export function computeSkillsView(stats, expanded) {
  const skills = stats.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    return { hasData: false, rows: [], hiddenCount: 0, expanded: false, totalCount: 0 };
  }
  const isExpanded = !!expanded;
  const rows = isExpanded ? skills.slice() : skills.slice(0, USAGE_SKILLS_TOP_N);
  return {
    hasData: true,
    rows,
    hiddenCount: Math.max(0, skills.length - rows.length),
    expanded: isExpanded,
    totalCount: skills.length,
  };
}

/**
 * Range-scoped skills view (Phase 1 System-browser range toggle,
 * 2026-08-04): recomputes cost/tokens/messages/runs/avgCostUsd from each
 * skill's `byDay` breakdown summed over `windowDays`, same idea as
 * computeWorkflowsViewForRange.
 *
 * `rangeSupported` is section-level, not per-row: if ANY skill in the
 * exported set predates the `byDay` field (build before Phase 1), the whole
 * section falls back to all-time totals rather than silently mixing
 * range-scoped rows with all-time rows in the same table -- one honest label
 * ("Skills (All available data)") beats a table where some rows quietly mean
 * something different than others.
 */
export function computeSkillsViewForRange(stats, windowDays, range, expanded) {
  const skills = stats.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    return { hasData: false, rows: [], hiddenCount: 0, expanded: false, totalCount: 0, rangeSupported: false };
  }

  const rangeSupported = skills.every((s) => s && typeof s.byDay === "object" && s.byDay !== null);

  let source;
  if (!rangeSupported || range === "all") {
    source = skills.slice();
  } else {
    const dateKeys = windowDays.map((d) => d.date);
    source = skills
      .map((s) => {
        let costUsd = 0, outputTokens = 0, messages = 0, runs = 0;
        const byDay = s.byDay || {};
        for (const dk of dateKeys) {
          const d = byDay[dk];
          if (!d) continue;
          costUsd += d.costUsd;
          outputTokens += d.outputTokens;
          messages += d.messages;
          runs += d.runs || 0;
        }
        return {
          key: s.key,
          label: s.label,
          costUsd,
          outputTokens,
          messages,
          runs,
          avgCostUsd: runs > 0 ? costUsd / runs : 0,
        };
      })
      .filter((s) => s.runs > 0 || s.costUsd > 0 || s.messages > 0)
      .sort((a, b) => b.costUsd - a.costUsd);
  }

  const isExpanded = !!expanded;
  const rows = isExpanded ? source.slice() : source.slice(0, USAGE_SKILLS_TOP_N);
  return {
    hasData: true,
    rows,
    hiddenCount: Math.max(0, source.length - rows.length),
    expanded: isExpanded,
    totalCount: source.length,
    rangeSupported,
  };
}

// ---------------------------------------------------------------------------
// Ops map model (pure). Reads Operations/ops-map.json (written by
// export-ops-map.mjs) and lays out a deterministic 5-column graph: Agents,
// Workflows, SOPs, Guidelines, Skills.
// ---------------------------------------------------------------------------

export const OPS_MAP_COLUMNS = [
  { type: "agent", label: "Agents" },
  { type: "workflow", label: "Workflows" },
  { type: "sop", label: "SOPs" },
  { type: "guideline", label: "Guidelines" },
  { type: "skill", label: "Skills" },
];

export const OPS_MAP_DEFAULTS = {
  columnWidth: 220,
  rowHeight: 40,
  nodeWidth: 180,
  nodeHeight: 28,
  paddingX: 24,
  paddingY: 40,
};

export const OPS_MAP_SKILL_SUMMARY_ID = "__skills_summary__";

/** Deterministic: no randomness, no wall-clock. */
export function computeOpsMapLayout(manifest, opts) {
  const o = { ...OPS_MAP_DEFAULTS, ...(opts || {}) };
  const nodes = manifest?.nodes || [];
  const edges = manifest?.edges || [];

  // Skill visibility rule: a skill is shown individually when it is flagged
  // registered (listed in Operations/skill-registry.md) OR has at least one
  // edge to/from a NON-skill node (agent, sop, workflow, guideline).
  // Skill-pack-internal cross-references (skill->skill only) collapse into
  // the "+N other skills" summary so third-party packs don't swamp the ops
  // map.
  const typeById = new Map();
  for (const n of nodes) typeById.set(n.id, n.type);
  const opsConnected = new Set();
  for (const e of edges) {
    const fromType = typeById.get(e.from);
    const toType = typeById.get(e.to);
    if (fromType === undefined || toType === undefined) continue;
    if (fromType === "skill" && toType !== "skill") opsConnected.add(e.from);
    if (toType === "skill" && fromType !== "skill") opsConnected.add(e.to);
  }

  const columns = [];
  const positioned = [];
  const positionById = new Map();

  OPS_MAP_COLUMNS.forEach((col, columnIndex) => {
    const colX = o.paddingX + columnIndex * o.columnWidth;
    let colNodes = nodes.filter((n) => n.type === col.type);

    let collapsedNames = [];
    if (col.type === "skill") {
      const isVisible = (n) => n.registered === true || opsConnected.has(n.id);
      const collapsed = colNodes.filter((n) => !isVisible(n));
      colNodes = colNodes.filter(isVisible);
      collapsedNames = collapsed.map((n) => n.label).sort((a, b) => a.localeCompare(b));
    }

    // Deterministic ordering: sort nodes by id within column.
    colNodes = [...colNodes].sort((a, b) => a.id.localeCompare(b.id));

    let rowIndex = 0;
    for (const n of colNodes) {
      const pos = {
        id: n.id,
        type: n.type,
        label: n.label,
        description: n.description,
        path: n.path,
        external: n.external,
        column: columnIndex,
        x: colX,
        y: o.paddingY + rowIndex * o.rowHeight,
        width: o.nodeWidth,
        height: o.nodeHeight,
      };
      positioned.push(pos);
      positionById.set(n.id, pos);
      rowIndex += 1;
    }

    if (collapsedNames.length > 0) {
      const summary = {
        id: OPS_MAP_SKILL_SUMMARY_ID,
        type: "skill-summary",
        label: `+${collapsedNames.length} other skills`,
        column: columnIndex,
        x: colX,
        y: o.paddingY + rowIndex * o.rowHeight,
        width: o.nodeWidth,
        height: o.nodeHeight,
        collapsedNames,
      };
      positioned.push(summary);
      rowIndex += 1;
    }

    columns.push({ type: col.type, label: col.label, count: colNodes.length, x: colX });
  });

  // Resolved edges: drop any edge whose endpoint is not a laid-out node
  // (unknown token, or an endpoint that collapsed into the skills summary).
  const resolvedEdges = [];
  for (const e of edges) {
    const from = positionById.get(e.from);
    const to = positionById.get(e.to);
    if (!from || !to) continue;
    resolvedEdges.push({
      from: e.from,
      to: e.to,
      viaType: e.viaType,
      x1: from.x + from.width,
      y1: from.y + from.height / 2,
      x2: to.x,
      y2: to.y + to.height / 2,
    });
  }

  const rowCounts = OPS_MAP_COLUMNS.map((col, i) => {
    const base = columns[i].count;
    const hasSummary = positioned.some((n) => n.type === "skill-summary" && n.column === i);
    return base + (hasSummary ? 1 : 0);
  });
  const maxRows = Math.max(1, ...rowCounts);

  const width = o.paddingX + OPS_MAP_COLUMNS.length * o.columnWidth;
  const height = o.paddingY + maxRows * o.rowHeight + o.paddingY;

  return { columns, nodes: positioned, edges: resolvedEdges, width, height };
}

// ---------------------------------------------------------------------------
// Automation model (pure). renderAutomationSection in main.ts is the impure
// half that reads automation-health.json off disk and turns it into this
// plain-data shape. The exporter (vault-scripts/export-automation-health.mjs)
// already derives state per job; this side only handles presentation:
// red-first ordering, prefix stripping, relative time, the per-job Dispatch
// prompt, and the counts-by-state summary milestone 3 needs for the Today tab.
// ---------------------------------------------------------------------------

// Red-first order, mirrored from the exporter's STATE_ORDER (kept as its own
// constant so the plugin never has to import the exporter).
export const AUTOMATION_STATE_ORDER = ["unknown", "error", "overdue", "running", "ok"];

// UI label per state: "unknown" means the label is missing from
// `launchctl list`, so we surface it as "not loaded" (a red state).
export const AUTOMATION_STATE_LABELS = {
  unknown: "not loaded",
  error: "error",
  overdue: "overdue",
  running: "running",
  ok: "ok",
};

// Reverse-DNS prefixes stripped from tile labels. Matches the exporter's
// DEFAULT_LABEL_PREFIXES.
export const AUTOMATION_LABEL_PREFIXES = ["com.jaymo.", "com.aios.", "ge.vagabondadventures."];

/** "com.jaymo.morning-brief" -> "morning-brief"; unknown prefixes pass through. */
export function stripAutomationPrefix(label, prefixes = AUTOMATION_LABEL_PREFIXES) {
  for (const p of prefixes) {
    if (label.startsWith(p) && label.length > p.length) return label.slice(p.length);
  }
  return label;
}

/**
 * Compact relative time for a tile: "just now", "5m ago", "3h ago", "2d ago".
 * Future timestamps (clock skew) clamp to "just now". Null/invalid input
 * renders "no activity".
 * @param {string | null} iso
 * @param {Date} now
 */
export function formatRelativeAgo(iso, now) {
  if (!iso) return "no activity";
  const t = Date.parse(iso);
  if (isNaN(t)) return "no activity";
  const diffMs = Math.max(0, now.getTime() - t);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Compact relative time for a future timestamp: "in 3h", "in 2d"; past -> "now". */
export function formatRelativeUntil(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const diffMs = t - now.getTime();
  if (diffMs <= 0) return "now";
  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Canned "Fix with Dispatch" prompt for one automation job. */
export function automationFixPrompt(job) {
  const exit = job.lastExitStatus != null ? job.lastExitStatus : "unknown";
  const log = job.logPath || "none";
  return (
    `The launchd job ${job.label} is in state ${AUTOMATION_STATE_LABELS[job.state] || job.state} ` +
    `(last exit ${exit}, log ${log}). Diagnose why and propose a fix; ` +
    `do not restart anything without confirming the root cause first.`
  );
}

/**
 * Counts by state over the job list (every state key always present, zero
 * when absent). Milestone 3's Today-tab summary consumes this.
 * @param {{ state: string }[]} jobs
 * @returns {{ unknown: number, error: number, overdue: number, running: number, ok: number }}
 */
export function automationSummaryCounts(jobs) {
  const counts = { unknown: 0, error: 0, overdue: 0, running: 0, ok: 0 };
  for (const j of jobs || []) {
    if (counts[j.state] != null) counts[j.state] += 1;
  }
  return counts;
}

/**
 * Turn the raw automation-health.json payload into render-ready tiles,
 * red-first (unknown/error, overdue, running, ok), label a-z within a state.
 * Defensive: null/malformed input yields an empty tile list.
 * @param {{ jobs?: any[] } | null} health
 * @param {Date} now
 */
export function computeAutomationView(health, now) {
  const jobs = Array.isArray(health?.jobs) ? health.jobs : [];
  const tiles = jobs
    .filter((j) => j && typeof j.label === "string")
    .map((j) => {
      const state = AUTOMATION_STATE_ORDER.includes(j.state) ? j.state : "unknown";
      return {
        label: j.label,
        shortLabel: stripAutomationPrefix(j.label),
        state,
        stateLabel: AUTOMATION_STATE_LABELS[state],
        relativeLastActivity: formatRelativeAgo(j.lastActivity ?? null, now),
        schedule: j.schedule || "unscheduled",
        lastExitStatus: j.lastExitStatus ?? null,
        pid: j.pid ?? null,
        nextExpected: j.nextExpected ?? null,
        nextExpectedRelative: formatRelativeUntil(j.nextExpected ?? null, now),
        logPath: j.logPath ?? null,
        prompt: automationFixPrompt({
          label: j.label,
          state,
          lastExitStatus: j.lastExitStatus ?? null,
          logPath: j.logPath ?? null,
        }),
      };
    })
    .sort(
      (a, b) =>
        AUTOMATION_STATE_ORDER.indexOf(a.state) - AUTOMATION_STATE_ORDER.indexOf(b.state) ||
        a.label.localeCompare(b.label)
    );
  return { tiles, counts: automationSummaryCounts(tiles) };
}

// ---------------------------------------------------------------------------
// Launch Dispatch: build a launch command. Three modes: terminal (macOS
// Terminal.app via AppleScript), iterm (iTerm2 via AppleScript), app
// (activate/auto-session an IDE), custom (a user shell template run
// directly).
//
// QUOTING: the inner shell command (cd into the vault, run the claude
// binary, pass the prompt as a single argument) is built with POSIX
// single-quoting (each argument wrapped in '...', embedded single quotes
// escaped as '\''). That whole string is then embedded as an AppleScript
// double-quoted string literal for terminal/iterm modes, so it needs its own
// escaping pass (backslash and double-quote). Getting the order right
// (shell-quote first, then AppleScript-quote the result) is what keeps
// prompts with quotes safe.
// ---------------------------------------------------------------------------

/**
 * Wrap a single shell argument in POSIX single quotes, escaping any embedded
 * single quotes with the standard '\'' technique.
 */
export function shellQuoteSingle(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function escapeAppleScriptString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Like buildInnerShellCommand but without the cd: the IDE's integrated
 * terminal already opens in the workspace folder.
 */
export function buildInnerShellCommandNoCd(claudeBinary, prompt) {
  const parts = [shellQuoteSingle(claudeBinary)];
  if (prompt != null) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

/**
 * The shell command run inside the terminal: cd into the vault, then run the
 * claude binary with the prompt as a single trailing argument (omitted when
 * prompt is null, giving a plain interactive session).
 */
export function buildInnerShellCommand(claudeBinary, vaultPath, prompt) {
  const parts = ["cd", shellQuoteSingle(vaultPath), "&&", shellQuoteSingle(claudeBinary)];
  if (prompt != null) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

/**
 * Pure: returns the exact argv to spawn for a given launch mode. Never
 * touches the filesystem or a process, so it is fully unit-testable.
 * @param {"terminal" | "iterm" | "app" | "custom"} mode
 */
export function buildLaunchCommand(
  mode,
  claudeBinary,
  vaultPath,
  prompt,
  customCommand,
  ideAppName,
  openVaultFolder,
  autoSession,
  sessionTarget,
  newSessionCommand
) {
  // "app" activates a macOS app (IDE) via open -a; no CLI on PATH required.
  // By default it does NOT pass the vault path: VS Code forks treat a folder
  // argument as "open a new workspace window", which yanks the user away
  // from the window their Claude session already lives in. Activate-only
  // brings the last-used window forward instead. The prompt cannot be
  // injected into an IDE session, so the caller copies it to the clipboard
  // (see launchDispatch in main.ts). With autoSession, a System Events
  // script (needs Accessibility permission for Obsidian) opens a fresh
  // integrated terminal in the IDE and paste-runs the claude command with
  // the prompt: the true one-click flow.
  if (mode === "app") {
    const appName = ideAppName || "Antigravity";
    if (autoSession && sessionTarget === "extension") {
      // Drive the command palette to open a fresh Claude Code extension
      // session, then paste the prompt into its input and send it.
      const paletteCmd = newSessionCommand || "Claude Code: New Session";
      let script =
        `tell application "${escapeAppleScriptString(appName)}" to activate\n` +
        `delay 1.5\n` +
        `tell application "System Events"\n` +
        `keystroke "p" using {command down, shift down}\n` +
        `end tell\n` +
        `delay 0.5\n` +
        `set the clipboard to "${escapeAppleScriptString(paletteCmd)}"\n` +
        `tell application "System Events"\n` +
        `keystroke "v" using {command down}\n` +
        `delay 0.4\n` +
        `key code 36\n` +
        `end tell\n` +
        `delay 1.5\n`;
      if (prompt != null) {
        script +=
          `set the clipboard to "${escapeAppleScriptString(prompt)}"\n` +
          `tell application "System Events"\n` +
          `keystroke "v" using {command down}\n` +
          `delay 0.3\n` +
          `key code 36\n` +
          `end tell`;
      }
      return ["osascript", "-e", script.trimEnd()];
    }
    if (autoSession) {
      const shellCmd = buildInnerShellCommandNoCd(claudeBinary, prompt);
      const script =
        `tell application "${escapeAppleScriptString(appName)}" to activate\n` +
        `delay 1.5\n` +
        `tell application "System Events"\n` +
        `keystroke "\`" using {control down, shift down}\n` +
        `end tell\n` +
        `delay 1.2\n` +
        `set the clipboard to "${escapeAppleScriptString(shellCmd)}"\n` +
        `tell application "System Events"\n` +
        `keystroke "v" using {command down}\n` +
        `delay 0.3\n` +
        `key code 36\n` +
        `end tell`;
      return ["osascript", "-e", script];
    }
    const argv = ["open", "-a", appName];
    if (openVaultFolder) argv.push(vaultPath);
    return argv;
  }
  if (mode === "custom") {
    const vaultArg = shellQuoteSingle(vaultPath);
    const promptArg = prompt != null ? shellQuoteSingle(prompt) : "";
    const substituted = customCommand
      .split("{vault}")
      .join(vaultArg)
      .split("{prompt}")
      .join(promptArg);
    return ["/bin/sh", "-c", substituted];
  }

  const inner = buildInnerShellCommand(claudeBinary, vaultPath, prompt);
  const escaped = escapeAppleScriptString(inner);

  if (mode === "iterm") {
    const script =
      `tell application "iTerm2"\n` +
      `activate\n` +
      `create window with default profile\n` +
      `tell current session of current window\n` +
      `write text "${escaped}"\n` +
      `end tell\n` +
      `end tell`;
    return ["osascript", "-e", script];
  }

  // terminal
  const script =
    `tell application "Terminal"\n` +
    `activate\n` +
    `do script "${escaped}"\n` +
    `end tell`;
  return ["osascript", "-e", script];
}

// ---------------------------------------------------------------------------
// Today tab (pure). renderTodayTab in main.ts is the impure half that gathers
// tasks/usage-stats/automation-health and calls these. Build 2.6 m3.
// ---------------------------------------------------------------------------

/**
 * The 3 highest-priority open/in-progress tasks: priority asc (unset -> 5,
 * matching sortTasks' convention), then created asc (unset sorts last), then
 * title for a fully deterministic order.
 * @template {{ status: string, priority: number|null, created: string|null, title: string }} T
 * @param {T[]} tasks
 * @param {number} [limit]
 * @returns {T[]}
 */
export function topTasks(tasks, limit = 3) {
  const eligible = (tasks || []).filter(
    (t) => t.status === "open" || t.status === "in-progress"
  );
  const sorted = eligible.slice().sort((a, b) => {
    const pa = a.priority ?? 5;
    const pb = b.priority ?? 5;
    if (pa !== pb) return pa - pb;
    const ca = a.created || "9999";
    const cb = b.created || "9999";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return (a.title || "").localeCompare(b.title || "");
  });
  return sorted.slice(0, limit);
}

/** Intake backlog count, reusing the health strip's already-computed intake tile. */
export function intakeBacklogCount(healthTiles) {
  const tile = (healthTiles || []).find((t) => t.key === "intake");
  return tile ? tile.count : 0;
}

/**
 * Compact automation summary for the Today tab, e.g. "2 failing, 1 overdue,
 * 9 ok". "failing" folds in "unknown" (not-loaded, also a red state);
 * "ok" folds in "running" (a healthy state, not a problem to surface here).
 * @param {{ unknown?: number, error?: number, overdue?: number, running?: number, ok?: number }} counts
 */
export function automationSummaryText(counts) {
  const c = counts || {};
  const failing = (c.error || 0) + (c.unknown || 0);
  const overdue = c.overdue || 0;
  const ok = (c.ok || 0) + (c.running || 0);
  return {
    failing,
    overdue,
    ok,
    text: `${failing} failing, ${overdue} overdue, ${ok} ok`,
    hasFailing: failing > 0,
  };
}

// ---------------------------------------------------------------------------
// Quick capture (pure). submitQuickCapture in main.ts is the impure half that
// writes the file through the Obsidian vault API.
// ---------------------------------------------------------------------------

/**
 * Filename stem (no extension) for a quick-capture note, from local wall-clock
 * time: "YYYY-MM-DD-HHmm-quick-capture".
 * @param {Date} d
 */
export function quickCaptureFileStem(d) {
  const p2 = (n) => (n < 10 ? "0" + n : "" + n);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-` +
    `${p2(d.getHours())}${p2(d.getMinutes())}-quick-capture`
  );
}

/**
 * Collision-safe filename stem: if `baseStem` is already taken, append -2,
 * -3, ... until a free name is found.
 * @param {string} baseStem
 * @param {Iterable<string>} existingStems
 */
export function resolveCaptureFileName(baseStem, existingStems) {
  const exists = new Set(existingStems || []);
  if (!exists.has(baseStem)) return baseStem;
  let n = 2;
  while (exists.has(`${baseStem}-${n}`)) n += 1;
  return `${baseStem}-${n}`;
}

/**
 * Quick-capture note body: the captured text plus a `captured:` frontmatter
 * line.
 * @param {string} text
 * @param {string} capturedIso
 */
export function buildQuickCaptureContent(text, capturedIso) {
  const body = (text || "").trim();
  return `---\ncaptured: ${capturedIso}\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Spend guardrail (pure). renderTodayTab and renderUsageTab in main.ts both
// call this with the same inputs so the two warning tiles never disagree.
// ---------------------------------------------------------------------------

/**
 * Null when the guardrail is off (dailyBudgetUsd <= 0) or not triggered
 * (today's cost is at or under budget); otherwise the warning payload.
 * @param {number} todayCostUsd
 * @param {number} dailyBudgetUsd
 */
export function budgetGuardrail(todayCostUsd, dailyBudgetUsd) {
  if (!dailyBudgetUsd || dailyBudgetUsd <= 0) return null;
  if (todayCostUsd <= dailyBudgetUsd) return null;
  return {
    todayCostUsd,
    dailyBudgetUsd,
    message: `Today $${todayCostUsd.toFixed(2)} of $${dailyBudgetUsd.toFixed(2)} budget (API-equivalent)`,
  };
}

// ---------------------------------------------------------------------------
// Workflow spend-spike detection (build 2.9 slice 3). Compares each
// workflow's cost SHARE (of total workflow spend, not absolute dollars) over
// the last 7 days against its share over the prior 28 days (days 8-35 ago --
// the rest of the exporter's 35-day window). A workflow whose share has
// risen materially is flagged; flat or shrinking shares stay silent. Needs
// per-workflow `byDay` (build 2.9 slice 2); older JSON without it degrades to
// an empty alert list rather than throwing.
//
// Design decisions:
//  - SPIKE_MIN_RECENT_COST_USD ($1.00) is an absolute floor on last-7-day
//    cost. Without it, a workflow that went from $0.02 to $0.10 (tripling
//    its share) would flag despite moving a trivial amount of money.
//  - A spike requires BOTH a percentage-point floor
//    (SPIKE_MIN_SHARE_INCREASE_PP, 10pp) AND a relative-growth floor
//    (SPIKE_MIN_SHARE_MULTIPLIER, 1.5x). The pp floor stops an
//    already-dominant workflow from re-flagging on tiny wobbles (80% -> 85%);
//    the multiplier floor stops a workflow with a large absolute swing but a
//    small relative one. Both together keep the bar at "materially risen",
//    not "moved at all".
//  - A workflow with zero cost anywhere in the prior 28 days has no baseline
//    to compare against, so it's reported as kind: "new" rather than an
//    infinite/undefined percentage spike.
// ---------------------------------------------------------------------------

export const SPIKE_MIN_RECENT_COST_USD = 1.0;
export const SPIKE_MIN_SHARE_INCREASE_PP = 10;
export const SPIKE_MIN_SHARE_MULTIPLIER = 1.5;

/**
 * Pure. `nowDate` drives the 7d (recent) / 28d (baseline) window boundaries,
 * so this is unit-testable without mocking the clock. Returns alerts sorted
 * by recentCostUsd desc (empty when nothing qualifies):
 * [{key, label, kind: "new"|"spike", recentCostUsd, recentSharePercent, baselineSharePercent}]
 */
export function computeWorkflowSpikes(stats, nowDate) {
  const workflows = stats.workflows;
  if (!Array.isArray(workflows) || workflows.length === 0) return [];

  const recentSet = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
    recentSet.add(usageLocalDayKey(d));
  }
  const baselineSet = new Set();
  for (let i = 7; i < 35; i++) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
    baselineSet.add(usageLocalDayKey(d));
  }

  function sumByDay(byDay, daySet) {
    if (!byDay) return 0;
    let sum = 0;
    for (const [dayKey, d] of Object.entries(byDay)) {
      if (daySet.has(dayKey)) sum += d.costUsd || 0;
    }
    return sum;
  }

  const perWorkflow = workflows.map((w) => ({
    key: w.key,
    label: w.label,
    recentCostUsd: sumByDay(w.byDay, recentSet),
    baselineCostUsd: sumByDay(w.byDay, baselineSet),
  }));

  const recentTotal = perWorkflow.reduce((s, w) => s + w.recentCostUsd, 0);
  const baselineTotal = perWorkflow.reduce((s, w) => s + w.baselineCostUsd, 0);
  const safeRecentTotal = recentTotal > 0 ? recentTotal : 1;
  const safeBaselineTotal = baselineTotal > 0 ? baselineTotal : 1;

  const alerts = [];
  for (const w of perWorkflow) {
    if (w.recentCostUsd < SPIKE_MIN_RECENT_COST_USD) continue;
    const recentSharePercent = (w.recentCostUsd / safeRecentTotal) * 100;
    if (w.baselineCostUsd <= 0) {
      alerts.push({
        key: w.key,
        label: w.label,
        kind: "new",
        recentCostUsd: w.recentCostUsd,
        recentSharePercent,
        baselineSharePercent: 0,
      });
      continue;
    }
    const baselineSharePercent = (w.baselineCostUsd / safeBaselineTotal) * 100;
    const deltaPp = recentSharePercent - baselineSharePercent;
    const multiplier = recentSharePercent / baselineSharePercent;
    if (deltaPp >= SPIKE_MIN_SHARE_INCREASE_PP && multiplier >= SPIKE_MIN_SHARE_MULTIPLIER) {
      alerts.push({
        key: w.key,
        label: w.label,
        kind: "spike",
        recentCostUsd: w.recentCostUsd,
        recentSharePercent,
        baselineSharePercent,
      });
    }
  }

  alerts.sort((a, b) => b.recentCostUsd - a.recentCostUsd);
  return alerts;
}

// ---------------------------------------------------------------------------
// Today-tab trend sparkline (build 2.9 slice 4). Only the spend stat card has
// a daily history to draw from -- intake backlog and the automations summary
// (healthTiles / automation-health.json) carry no per-day series in the
// current data model, so this only covers "Today's spend". Pure series-
// shaping only; the SVG itself is drawn in main.ts.
//
// Window: 7 days. Matches the existing "Today's spend" tile's own cadence
// (it's a daily number) and the Usage tab's default 7D range toggle (build
// 2.8), so a reader who flips to the Usage tab sees the same window they
// just glanced at here. Also short enough to read as "this week's direction"
// in a ~60px-wide sparkline without the line getting too noisy.
// ---------------------------------------------------------------------------

export const SPARKLINE_WINDOW_DAYS = 7;

/**
 * Pure. Degrades to `hasData: false` (never throws) when `stats` is missing
 * or has fewer than 2 days of history -- a single data point can't show a
 * direction, so there's nothing worth drawing yet. Otherwise returns a
 * zero-filled 7-day window (missing days = $0, same convention as
 * computeUsageView) as both raw costUsd values and 0..1-normalized points
 * (0 = cheapest/zero day in the window, 1 = costliest) ready for an SVG
 * polyline.
 */
export function computeSpendSparkline(stats, nowDate) {
  if (!stats || !Array.isArray(stats.days) || stats.days.length < 2) {
    return { hasData: false, values: [], points: [] };
  }

  const dayByDate = new Map(stats.days.map((d) => [d.date, d]));
  const values = [];
  for (let i = SPARKLINE_WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
    const key = usageLocalDayKey(d);
    values.push(dayByDate.get(key)?.totalCostUsd || 0);
  }

  const max = Math.max(...values);
  const safeMax = max > 0 ? max : 1;
  const points = values.map((v) => v / safeMax);

  return { hasData: true, values, points, max };
}

// ---------------------------------------------------------------------------
// System tab: Skills section (build 2026-08-04). Pure view-model joining
// ops-map.json's skill nodes (name, description, disable-model-invocation
// flag, usedBy edges) with usage-stats.json's optional skills array (cost,
// runs, avg/run) by key. No Obsidian deps; unit tested in
// systemSkillsModel.test.mjs. This is a NEW region -- keep additions here
// separate from the Usage tab's own skills sub-table above
// (computeSkillsView / computeSkillsViewForRange), which a sibling branch is
// actively touching.
// ---------------------------------------------------------------------------

// Generic multi-skill suites collapse into an expandable group with a count
// so 150+ rows stay scannable; anything not matching one of these prefixes
// is treated as standalone/business-critical and always lists openly.
export const SYSTEM_SKILLS_SUITE_PREFIXES = [
  "blog-",
  "firecrawl-",
  "gsd-",
  "seo-",
  "printing-press-",
];

// Returns the suite's display label ("blog", "gsd", "superpowers", ...) for
// a skill id that either (a) is colon-namespaced -- every plugin-origin
// skill id (superpowers:brainstorming, context-mode:*), grouped the same
// way the generic hyphenated suites below are (Reviewer cosmetic minor,
// phase-2 report, 2026-08-04: the 35 plugin skills previously rendered as
// 35 standalone rows instead of grouped suites) -- or (b) matches one of the
// known generic-suite prefixes. Returns null for a genuinely standalone
// skill. Colon-namespacing is checked first: a plugin could theoretically
// ship a skill whose bare id also happens to start with a generic prefix
// (e.g. "gsd-tools" inside some future "gsd:" plugin), and the namespace is
// the more specific, more useful grouping in that case.
export function systemSkillsSuiteFor(id, prefixes = SYSTEM_SKILLS_SUITE_PREFIXES) {
  const colonIdx = id.indexOf(":");
  if (colonIdx > 0) return id.slice(0, colonIdx);
  const hit = prefixes.find((p) => id.startsWith(p));
  return hit ? hit.slice(0, -1) : null;
}

// Resolves one skill node's `usedBy` id list (agents/SOPs/workflows/skills
// that reference it, from export-ops-map.mjs's edge denormalization) into
// display rows: a label plus an optional vault-relative path for internal
// nodes (openLinkText candidates) -- external/skill targets carry no path,
// so the caller renders them as plain text.
export function systemSkillUsedByRows(node, nodesById) {
  const ids = node.usedBy || [];
  return ids.map((id) => {
    const target = nodesById.get(id);
    return {
      id,
      label: target ? target.label || id : id,
      path: target && !target.external ? target.path : undefined,
    };
  });
}

// Joins one ops-map skill node with its usage-stats row (if any). Returns
// null (not a dash) for cost/runs/avgCostUsd when no usage row exists, so
// the renderer decides the dash presentation, not the model.
export function systemSkillRowFromNode(node, nodesById, usageByKey) {
  const usage = usageByKey.get(node.id);
  return {
    id: node.id,
    description: node.description || "(no description)",
    disableModelInvocation: Boolean(node.disableModelInvocation),
    path: node.path,
    external: Boolean(node.external),
    // Reviewer M3 (2026-08-04): "skills-dir" (~/.claude/skills, the original
    // and still-default source), "plugin" (an installed Claude Code
    // plugin's own skills/, namespaced pluginName:skillId), or "command"
    // (the vault's .claude/commands/*.md slash commands). Falls back to
    // "skills-dir" for a node written before this field existed.
    origin: node.origin || "skills-dir",
    usedBy: systemSkillUsedByRows(node, nodesById),
    costUsd: usage ? usage.costUsd : null,
    runs: usage ? usage.runs : null,
    avgCostUsd: usage ? usage.avgCostUsd : null,
  };
}

function systemSkillRowMatchesFilter(row, needle) {
  if (!needle) return true;
  if (row.id.toLowerCase().includes(needle)) return true;
  if (row.description.toLowerCase().includes(needle)) return true;
  return row.usedBy.some((u) => u.label.toLowerCase().includes(needle));
}

/**
 * Full System tab Skills-section view: filters ops-map's skill nodes by
 * `filterText` (id, description, or used-by label, case-insensitive), joins
 * usage, then splits into `standalone` rows (render openly) and `groups`
 * (generic suites, render collapsed behind a count until expanded), sorted
 * largest-group-first. Both `standalone` and each group's `rows` are sorted
 * alphabetically by id so the table order is stable across re-renders.
 */
export function computeSystemSkillsView(opsMap, usageStats, filterText) {
  const nodes = (opsMap && opsMap.nodes) || [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const usageByKey = new Map(((usageStats && usageStats.skills) || []).map((s) => [s.key, s]));
  const skillNodes = nodes.filter((n) => n.type === "skill");

  const needle = (filterText || "").trim().toLowerCase();
  const rows = skillNodes
    .map((n) => systemSkillRowFromNode(n, nodesById, usageByKey))
    .filter((row) => systemSkillRowMatchesFilter(row, needle))
    .sort((a, b) => a.id.localeCompare(b.id));

  const groupsByLabel = new Map();
  const standalone = [];
  for (const row of rows) {
    const suite = systemSkillsSuiteFor(row.id);
    if (suite) {
      if (!groupsByLabel.has(suite)) groupsByLabel.set(suite, []);
      groupsByLabel.get(suite).push(row);
    } else {
      standalone.push(row);
    }
  }
  // Cheap nit (Reviewer, 2026-08-05): a suite with exactly ONE matching skill
  // gets no benefit from the collapse-behind-a-count UI (there's nothing to
  // hide), so it renders as a plain standalone row instead of a 1-member
  // group header. `separator` (":" for a colon-namespaced plugin suite like
  // superpowers:*, "-" for a generic hyphen-prefixed suite like gsd-*) is
  // derived once here from the group's own first row id, so the renderer
  // never has to re-guess it from suite text alone.
  const groups = [];
  for (const [suite, groupRows] of groupsByLabel) {
    if (groupRows.length === 1) {
      standalone.push(...groupRows);
      continue;
    }
    const separator = groupRows[0].id.startsWith(suite + ":") ? ":" : "-";
    groups.push({ suite, rows: groupRows, count: groupRows.length, separator });
  }
  standalone.sort((a, b) => a.id.localeCompare(b.id));
  groups.sort((a, b) => b.count - a.count || a.suite.localeCompare(b.suite));

  return {
    totalCount: skillNodes.length,
    filteredCount: rows.length,
    // Reviewer M6 (2026-08-04): the caller needs to know whether a filter is
    // ACTUALLY narrowing the set (not just present-but-empty) to decide
    // whether a group should auto-expand -- see systemSkillsGroupIsOpen.
    filterActive: needle.length > 0,
    standalone,
    groups,
  };
}

// Reviewer M6 (2026-08-04, measured): typing a filter updated each group's
// count in the header but left the group itself collapsed, so a search that
// matched exactly one skill inside a 65-member group showed "gsd-* (1
// skill)" with nothing visible underneath until the user also clicked
// Show. A group present in `view.groups` after filtering ALREADY contains
// only rows that matched (computeSystemSkillsView filters before grouping),
// so while a filter is active every surviving group should render open.
// The caller's `expandedGroups` set (the user's own manual Show/Hide
// choices) is read but NEVER mutated by the filter -- clearing the filter
// falls straight back to whatever the user had manually expanded before,
// with no extra bookkeeping needed to "restore" it.
export function systemSkillsGroupIsOpen(suite, expandedGroups, filterActive) {
  if (filterActive) return true;
  return Boolean(expandedGroups && expandedGroups.has(suite));
}

// ---------------------------------------------------------------------------
// System tab: Agents section (Phase 3, 2026-08-05). Pure view-model joining
// ops-map.json's roster agent nodes (name, model, one-line description,
// contract path) with their wired-to edges (workflows/SOPs/skills their
// contract references) and usage-stats.json's optional `agents` array (cost,
// runs, byDay), keyed by the SAME id the exporter uses for both (ops-map
// agent node id === usage-stats attributionAgent value for every roster
// name: capture/coder/curate/recruit/research/reviewer/tooling/web-builder).
// No Obsidian deps; unit tested in a systemAgentsModel-focused test file.
// ---------------------------------------------------------------------------

/**
 * Resolves one agent node's outgoing edges into the three wired-to buckets
 * the System tab shows: workflows, sops, and skills. Guidelines and other
 * agents are deliberately excluded -- the task asks for "the workflows,
 * SOPs, and skills its contract references", not the full edge set. Each
 * row carries a clickable path for internal (non-external) nodes, same
 * convention as systemSkillUsedByRows.
 */
export function systemAgentWiredToRows(agentId, edges, nodesById) {
  const workflows = [];
  const sops = [];
  const skills = [];
  for (const e of edges) {
    if (e.from !== agentId) continue;
    const target = nodesById.get(e.to);
    if (!target) continue;
    const row = { id: target.id, label: target.label || target.id, path: target.external ? undefined : target.path };
    if (target.type === "workflow") workflows.push(row);
    else if (target.type === "sop") sops.push(row);
    else if (target.type === "skill") skills.push(row);
  }
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  return { workflows: workflows.sort(byLabel), sops: sops.sort(byLabel), skills: skills.sort(byLabel) };
}

/**
 * Joins one ops-map agent node with its usage-stats `agents[]` row (if any).
 * Returns null (not a dash) for cost/runs/avgCostUsd when no usage row
 * exists, mirroring systemSkillRowFromNode -- the renderer decides the dash
 * presentation, not the model.
 */
export function systemAgentRowFromNode(node, edges, nodesById, usageByKey) {
  const usage = usageByKey.get(node.id);
  return {
    id: node.id,
    label: node.label || node.id,
    model: node.model || null,
    description: node.description || "(no description)",
    path: node.path,
    wiredTo: systemAgentWiredToRows(node.id, edges, nodesById),
    costUsd: usage ? usage.costUsd : null,
    runs: usage ? usage.runs : null,
    avgCostUsd: usage ? usage.avgCostUsd : null,
  };
}

/**
 * One row in the "Generic subagents" group: a usage-stats.agents entry whose
 * key does NOT match any roster agent node id (general-purpose, Explore,
 * workflow-subagent, Plan, seo-*, claude-code-guide, the UNKNOWN_AGENT_TYPE
 * fallback, and any future non-roster subagent_type). No contract, no
 * model badge, no wired-to -- these are real dollars with no specialist
 * behind them, plain cost/runs/avg rows only.
 */
export function systemGenericSubagentRowFromUsage(usage) {
  return {
    id: usage.key,
    label: usage.label || usage.key,
    costUsd: usage.costUsd,
    runs: usage.runs,
    avgCostUsd: usage.avgCostUsd,
  };
}

/**
 * Full System tab Agents-section view: one row per roster agent node
 * (ops-map's type:"agent" nodes), in the order export-ops-map.mjs discovered
 * them (alphabetical by id, since agentFiles comes from a sorted readdir),
 * plus a `genericSubagents` group (Dispatch escalation, 2026-08-05): every
 * usage-stats.agents entry that does NOT match a roster agent id, sorted by
 * cost descending, so the section's totals stop hiding the (often majority)
 * share of delegated spend that has no specialist contract behind it.
 */
export function computeSystemAgentsView(opsMap, usageStats) {
  const nodes = (opsMap && opsMap.nodes) || [];
  const edges = (opsMap && opsMap.edges) || [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const usageEntries = (usageStats && usageStats.agents) || [];
  const usageByKey = new Map(usageEntries.map((a) => [a.key, a]));
  const agentNodes = nodes.filter((n) => n.type === "agent");
  const rosterIds = new Set(agentNodes.map((n) => n.id));

  const genericSubagents = usageEntries
    .filter((a) => !rosterIds.has(a.key))
    .map(systemGenericSubagentRowFromUsage)
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    totalCount: agentNodes.length,
    rows: agentNodes.map((n) => systemAgentRowFromNode(n, edges, nodesById, usageByKey)),
    genericSubagents,
    genericSubagentsCostUsd: genericSubagents.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

/**
 * "Available hires" view: pass-through of export-ops-map.mjs's
 * `availableHires` (parsed from SOP-001's "Reference pattern" section when
 * present) shaped for the renderer, which always needs a clickable fallback
 * link to SOP-001 regardless of whether parsing found a heading.
 */
export function computeAvailableHiresView(opsMap) {
  const raw = (opsMap && opsMap.availableHires) || { found: false, items: [] };
  return {
    found: Boolean(raw.found),
    items: Array.isArray(raw.items) ? raw.items : [],
    sopId: raw.sopId || "SOP-001-how-to-add-a-new-specialist",
    sopPath: raw.sopPath,
  };
}

// ---------------------------------------------------------------------------
// System tab: Workflows & SOPs sub-tab (header/tabs restructure, 2026-08).
// Pure view-model over ops-map.json's own workflow/sop nodes plus their
// incoming edges -- "what references them" is every OTHER node with an edge
// pointing AT this workflow/SOP, deduped by referencing node id (an agent
// contract can link the same SOP more than once; the reader only needs to
// know it's referenced, not how many times). No Obsidian deps; unit tested
// in opsMapModel.test.mjs. Firing counts (how many sessions actually
// invoked a workflow/SOP) are explicitly OUT of scope here -- phase 4 -- so
// this view carries no such field to fake.
// ---------------------------------------------------------------------------

/**
 * Every node with an edge -> `nodeId`, deduped by the referencing node's id
 * and sorted by label. Mirrors systemSkillUsedByRows/systemAgentWiredToRows'
 * row shape ({id, label, path?}) so the renderer's existing used-by-style
 * cell (clickable for internal nodes, plain text for external/unresolvable
 * ones) works unchanged for this table too.
 */
export function systemReferencedByRows(nodeId, edges, nodesById) {
  const seen = new Set();
  const rows = [];
  for (const e of edges) {
    if (e.to !== nodeId) continue;
    if (seen.has(e.from)) continue;
    seen.add(e.from);
    const target = nodesById.get(e.from);
    rows.push({
      id: e.from,
      label: target ? target.label || e.from : e.from,
      path: target && !target.external ? target.path : undefined,
    });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/** Joins one ops-map workflow/SOP node with its referencedBy rows. */
export function systemWorkflowSopRowFromNode(node, edges, nodesById) {
  return {
    id: node.id,
    label: node.label || node.id,
    path: node.external ? undefined : node.path,
    referencedBy: systemReferencedByRows(node.id, edges, nodesById),
  };
}

/**
 * Full System tab Workflows & SOPs view: two lists (workflows, sops), each
 * sorted by id for a stable render order, each row carrying who references
 * it. Empty `nodes`/`edges` (no manifest yet) degrade to two empty lists,
 * not a throw -- same convention as computeSystemAgentsView.
 */
export function computeSystemWorkflowsSopsView(opsMap) {
  const nodes = (opsMap && opsMap.nodes) || [];
  const edges = (opsMap && opsMap.edges) || [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const workflowNodes = nodes.filter((n) => n.type === "workflow").sort((a, b) => a.id.localeCompare(b.id));
  const sopNodes = nodes.filter((n) => n.type === "sop").sort((a, b) => a.id.localeCompare(b.id));

  return {
    workflows: workflowNodes.map((n) => systemWorkflowSopRowFromNode(n, edges, nodesById)),
    sops: sopNodes.map((n) => systemWorkflowSopRowFromNode(n, edges, nodesById)),
  };
}

// ---------------------------------------------------------------------------
// Dashboard undo (build 2026-08-05): an in-memory stack of the PLUGIN'S OWN
// vault mutations (task status changes + file moves, quick-add task
// creation, quick capture). Every function here is pure -- no vault access,
// no Notice, no DOM. main.ts owns the impure read/write/rename/delete calls
// and the WeakMap<rootEl, stack> that gives each open dashboard its own
// history; these functions just decide what the stack looks like next and
// what to say about it.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UndoEntry
 * @property {string} id
 * @property {string} label - human-readable description, e.g. `Marked "X" done`
 * @property {"edit-move"|"create"} kind
 * @property {string} pathAfter - where the file lives right now (post-mutation)
 * @property {string} contentAfter - exact content the plugin wrote/left behind
 * @property {string} [pathBefore] - edit-move only: path before the mutation
 * @property {string} [contentBefore] - edit-move only: content before the mutation
 */

export const UNDO_STACK_CAP = 20;

/**
 * Push a new entry onto the undo stack, evicting the oldest entry once the
 * cap is exceeded. Returns a NEW array; never mutates `stack`. This is the
 * stack's only "expiry" rule -- capacity-based, not time-based.
 * @param {UndoEntry[]} stack
 * @param {UndoEntry} entry
 * @returns {UndoEntry[]}
 */
export function pushUndoEntry(stack, entry) {
  const next = stack.concat([entry]);
  return next.length > UNDO_STACK_CAP ? next.slice(next.length - UNDO_STACK_CAP) : next;
}

/**
 * Pop the most recent entry off the stack (LIFO). Returns `{ entry: null,
 * stack }` (the same, empty-or-not, array reference) when there is nothing
 * to undo. Never mutates `stack`.
 * @param {UndoEntry[]} stack
 * @returns {{ entry: UndoEntry|null, stack: UndoEntry[] }}
 */
export function popUndoEntry(stack) {
  if (stack.length === 0) return { entry: null, stack };
  return { entry: stack[stack.length - 1], stack: stack.slice(0, -1) };
}

/**
 * True when the file's current on-disk content is EXACTLY what the plugin
 * last wrote for this entry -- i.e. nothing has touched the file since the
 * mutation. Undo must refuse to clobber a concurrent edit, so this gate runs
 * before any restore/delete is attempted.
 * @param {UndoEntry} entry
 * @param {string} currentContent
 * @returns {boolean}
 */
export function undoEntryStillSafe(entry, currentContent) {
  return typeof currentContent === "string" && currentContent === entry.contentAfter;
}

/**
 * Toast text shown right after a plugin mutation is recorded. The clickable
 * "Undo" link (built by the caller, not this string) always works
 * regardless of surface; the TEXT only claims the Cmd+Z shortcut when
 * `canUseCmdZ` is true (the dashboard leaf view, where Cmd+Z is actually
 * bound). An embedded dashboard has no keymap for it, so its toast must not
 * make that promise -- "no surface may show a promise it cannot keep".
 * @param {UndoEntry} entry
 * @param {boolean} canUseCmdZ
 * @returns {string}
 */
export function mutationNoticeText(entry, canUseCmdZ) {
  return canUseCmdZ ? `${entry.label}. Cmd+Z to undo.` : `${entry.label}.`;
}

/** Toast text shown after a successful undo. */
export function undoNoticeText(entry) {
  return `Undone: ${entry.label}.`;
}

/** Toast text for the safety-refusal path (changed on disk since). */
export function undoConflictNoticeText() {
  return "AIOS: changed on disk since, not undoing.";
}

/** Toast text for the empty-stack path (Cmd+Z / command with nothing to undo). */
export function undoEmptyNoticeText() {
  return "AIOS: nothing to undo.";
}

/** Toast text when the move-back destination is already occupied (Min2). */
export function undoCollisionNoticeText(path) {
  return `AIOS: could not undo -- "${path}" already exists.`;
}

/**
 * True when a Cmd+Z/Ctrl+Z keypress landed on something with its own native
 * undo (a text input, a textarea, or a contenteditable region) and should
 * be left alone rather than intercepted for the dashboard's undo stack
 * (Reviewer M1: swallowing native text undo in the quick-capture/filter
 * inputs is a regression, not a feature).
 * @param {string|null|undefined} tagName
 * @param {boolean} isContentEditable
 * @returns {boolean}
 */
export function isEditableEventTarget(tagName, isContentEditable) {
  if (isContentEditable) return true;
  const t = (tagName || "").toUpperCase();
  return t === "INPUT" || t === "TEXTAREA";
}

/** Human label for a task status transition, used both in the mutation
 * toast and (prefixed "Undone: ") in the undo toast.
 * @param {string} verb - "Started" | "Completed" | "Cancelled" | "Reopened"
 * @param {string} title
 * @returns {string}
 */
export function taskStatusActionLabel(verb, title) {
  if (verb === "Completed") return `Marked "${title}" done`;
  return `${verb} "${title}"`;
}

// ---------------------------------------------------------------------------
// Coordination panel (GL-011, pure). Today tab, one card per participating
// project (any Projects/<slug>/ with a work-ledger.md -- decided by the
// impure gather half in main.ts, not here). Mirrors the EXACT definitions in
// Operations/scripts/coordination-report.mjs so the panel and the
// session-start report can never disagree: active = a row's status,
// lowercased, equals "active"; stale = active AND hoursSince(lastUpdate) >
// 24; merge queue size ("unlanded") = parseLandingOrder items where landed
// is false.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ session: string, branch: string, lastUpdate: string, stale: boolean }} CoordinationActiveSession
 * @typedef {{ id: string, date: string, title: string, context: string, answer: string }} CoordinationQuestion
 * @typedef {{ slug: string, activeSessions: CoordinationActiveSession[], unlanded: number, questions: CoordinationQuestion[] }} CoordinationProjectView
 * @typedef {"unanswered" | "answered" | "all"} CoordinationQuestionFilter
 */

/**
 * @param {{ slug: string, ledgerContent: string, questionsContent?: string|null }[]} inputs
 * @param {Date} now
 * @returns {CoordinationProjectView[]}
 */
export function computeCoordinationView(inputs, now) {
  const list = Array.isArray(inputs) ? inputs : [];
  return list.map((input) => {
    const ledgerContent = typeof input?.ledgerContent === "string" ? input.ledgerContent : "";
    const questionsContent = typeof input?.questionsContent === "string" ? input.questionsContent : "";

    const activeSessions = parseActiveSessions(ledgerContent)
      .filter((s) => (s.status || "").toLowerCase() === "active")
      .map((s) => {
        const h = hoursSince(s.lastUpdate, now);
        return {
          session: s.session,
          branch: s.branch,
          lastUpdate: s.lastUpdate,
          stale: h !== null && h > 24,
        };
      });

    const unlanded = parseLandingOrder(ledgerContent).filter((item) => !item.landed).length;

    const questions = parseQuestionsOpen(questionsContent).map((q) => ({
      id: q.id,
      date: q.date,
      title: q.title,
      context: q.context,
      answer: q.answer,
    }));

    return { slug: input?.slug, activeSessions, unlanded, questions };
  });
}

// Owner feedback 2026-08-30: "lets put a filtered tab (answered, unanswered,
// all) next to Open Questions? So i can see only the things i want/need."
//
// The single shared predicate: a question counts as answered when its file
// answer, trimmed, is non-empty -- exactly the same test the "answered"
// pill in main.ts uses (renderCoordinationQuestion calls this function
// instead of repeating .trim().length > 0 inline, so the pill and the
// filter can never disagree). A whitespace-only answer (e.g. the file
// literally has "- Answer:    ") trims to "" and counts as UNANSWERED.
/**
 * @param {CoordinationQuestion} q
 * @returns {boolean}
 */
export function isCoordinationQuestionAnswered(q) {
  return typeof q?.answer === "string" && q.answer.trim().length > 0;
}

/**
 * @param {CoordinationQuestion[]} questions
 * @param {CoordinationQuestionFilter} filter
 * @returns {CoordinationQuestion[]}
 */
export function filterCoordinationQuestions(questions, filter) {
  const list = Array.isArray(questions) ? questions : [];
  if (filter === "answered") return list.filter(isCoordinationQuestionAnswered);
  if (filter === "unanswered") return list.filter((q) => !isCoordinationQuestionAnswered(q));
  return list.slice();
}

/**
 * @param {CoordinationQuestion[]} questions
 * @returns {{ unanswered: number, answered: number, all: number }}
 */
export function coordinationQuestionFilterCounts(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const answered = list.filter(isCoordinationQuestionAnswered).length;
  return { unanswered: list.length - answered, answered, all: list.length };
}
