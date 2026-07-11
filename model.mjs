// Pure view-model functions shared between main.ts and the test suites.
// No Obsidian dependency, no filesystem/network access, no wall-clock reads
// except where the caller passes a Date in explicitly. main.ts imports this
// module directly (esbuild bundles plain ESM fine); each *.test.mjs file
// imports the SAME functions instead of hand-copying them, so behavior can
// never silently drift between the plugin and its tests.
// Build 2.6 m1: de-mirror the tests.

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
 * Pure view-model function: turns the exporter's usage-stats.json shape plus
 * "now" into everything the Usage tab renders (tiles, chart, legend, table,
 * projects). `nowDate` is passed in (not read from the clock) so the tile
 * math (today/7d/30d boundaries) and the always-30-entries chart window are
 * unit-testable without mocking time.
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
    };
  });

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

// Per-workflow spend-spike detection (share of last-7-days cost vs share of
// prior-28-days cost) was SKIPPED for build 2.6 m3: usage-stats.json's
// `workflows` array is aggregated over the whole WINDOW_DAYS window with no
// per-day breakdown, so a workflow's 7-day and prior-28-day cost shares
// cannot be computed from the data the exporter currently writes. Per the
// spec's escape hatch, this was left undone rather than extending the
// exporter. See vault-scripts/export-usage-stats.mjs: `days[]` carries
// per-day totals and per-family model buckets, but workflow attribution is
// only accumulated once, window-wide.
