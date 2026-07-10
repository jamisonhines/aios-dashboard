import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIEW_TYPE = "aios-dashboard";

// Default standalone-task buckets (used when the Dashboard note declares none).
const DEFAULT_BUCKETS: { slug: string; label: string }[] = [
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

// Resolve buckets from the host note's frontmatter `dashboard_buckets:` (array of
// {slug,label}); fall back to DEFAULT_BUCKETS. Keeps the plugin config-driven so
// each fork sets its own buckets without editing code.
function resolveBuckets(
  fm: Record<string, unknown> | undefined
): { slug: string; label: string }[] {
  const raw = fm?.["dashboard_buckets"];
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw
      .filter(
        (b): b is { slug: string; label: string } =>
          !!b &&
          typeof (b as Record<string, unknown>).slug === "string" &&
          typeof (b as Record<string, unknown>).label === "string"
      )
      .map((b) => ({
        slug: (b as Record<string, unknown>).slug as string,
        label: (b as Record<string, unknown>).label as string,
      }));
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_BUCKETS;
}

// Project hub status sections. Rendered top-to-bottom in THIS fixed order; each
// section is collapsible and empty sections are not rendered at all. `open` is the
// default expand state (active work expanded, the done/archived graveyard collapsed).
// A module default that resolveStatusSections() can override from frontmatter, so a
// fork tunes labels/order/defaults as data, not code (fork-playbook: variation is data).
interface StatusSection {
  slug: string;
  label: string;
  open: boolean;
}

const DEFAULT_STATUS_SECTIONS: StatusSection[] = [
  { slug: "active", label: "Active", open: true },
  { slug: "planning", label: "Planning", open: true },
  { slug: "paused", label: "Paused", open: true },
  { slug: "done", label: "Done", open: false },
  { slug: "archived", label: "Archived", open: false },
];

// Resolve status sections from the host note's `dashboard_project_statuses:` (array of
// {slug,label,open?}); fall back to DEFAULT_STATUS_SECTIONS. `open` defaults true unless
// explicitly false. Mirrors resolveBuckets so forks configure sectioning without code edits.
function resolveStatusSections(
  fm: Record<string, unknown> | undefined
): StatusSection[] {
  const raw = fm?.["dashboard_project_statuses"];
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw
      .filter(
        (b): b is Record<string, unknown> =>
          !!b &&
          typeof (b as Record<string, unknown>).slug === "string" &&
          typeof (b as Record<string, unknown>).label === "string"
      )
      .map((b) => ({
        slug: b.slug as string,
        label: b.label as string,
        open: (b as Record<string, unknown>).open !== false,
      }));
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_STATUS_SECTIONS;
}

const OPEN_STATUSES = ["open", "in-progress"];
// Statuses that count toward a progress denominator (cancelled work is excluded).
const PROGRESS_STATUSES = ["open", "in-progress", "done"];

// ---------------------------------------------------------------------------
// Settings (PluginSettingTab + loadData/saveData). Every fork sets its own
// roots and note paths here instead of editing code; frontmatter overrides on
// the Dashboard note (dashboard_buckets, dashboard_project_statuses) still take
// precedence over these where both exist.
// ---------------------------------------------------------------------------

interface AiosDashboardSettings {
  tasksRoot: string;
  projectsRoot: string;
  dashboardNote: string;
  headerTitle: string;
  intakeFolder: string;
  journalFolder: string;
  showHealthStrip: boolean;
  intakeWarnDays: number;
  inProgressStaleDays: number;
  openStaleDays: number;
  linkCheckExcludes: string; // comma-separated list
  actionsEnabled: boolean;
  launchMode: "terminal" | "iterm" | "app" | "custom";
  customCommand: string; // shell template, {vault} and {prompt} placeholders
  claudeBinary: string;
  ideAppName: string; // macOS app name for the "app" launch mode (open -a)
  ideOpenVaultFolder: boolean; // pass the vault path to the app (may spawn a new window)
  ideAutoSession: boolean; // auto-open a terminal in the IDE and paste-run the claude command
  ideSessionTarget: "terminal" | "extension"; // where auto-session runs: integrated terminal (claude CLI) or the Claude Code extension panel
  ideNewSessionCommand: string; // command-palette entry used for the extension target
  usageStatsPath: string; // vault-relative path to the exporter's usage-stats.json
}

const DEFAULT_SETTINGS: AiosDashboardSettings = {
  tasksRoot: "Operations/tasks",
  projectsRoot: "Projects",
  dashboardNote: "Projects/Dashboard.md",
  headerTitle: "AIOS",
  intakeFolder: "Intake",
  journalFolder: "Wiki/Journal",
  showHealthStrip: true,
  intakeWarnDays: 7,
  inProgressStaleDays: 7,
  openStaleDays: 45,
  linkCheckExcludes: "Wiki/daily, Wiki/finances, Wiki/ea, Operations/Templates, _archive",
  actionsEnabled: true,
  launchMode: "terminal",
  customCommand: "",
  claudeBinary: "claude",
  ideAppName: "Antigravity",
  ideOpenVaultFolder: false,
  ideAutoSession: false,
  ideSessionTarget: "terminal",
  ideNewSessionCommand: "Claude Code: New Session",
  usageStatsPath: "Operations/usage/usage-stats.json",
};

// Parse the comma list into trimmed, non-empty path prefixes.
function parseExcludeList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskItem {
  path: string;
  id: string;
  title: string;
  status: string;
  priority: number | null;
  project: string | null;
  phase: string | null;
  lifeAreas: string[];
  due: string | null;
  updated: string | null;
}

interface ProjectItem {
  path: string;
  slug: string;
  name: string;
  status: string;
  venture: string | null;
  keyElement: string | null;
  targetDate: string | null;
  phases: string[]; // declared phase order from the hub frontmatter (may be empty)
}

interface Progress {
  done: number;
  total: number;
  pct: number; // 0-100, 0 when total is 0
}

// Per-view UI state that must survive the debounced live re-render (v1 was stateless).
// Not persisted to disk: resets to defaults when Obsidian restarts.
interface ViewState {
  activeTab: "projects" | "tasks" | "usage";
  activeStatus: string | null; // null = first non-empty status group
  activeCategory: string; // "all" | bucket slug | "inbox"
  expanded: Set<string>; // keys of expanded project cards and phase cards
  openOff: Set<string>; // project slugs whose Open toggle is OFF (default: Open ON)
  completeOn: Set<string>; // project slugs whose Complete toggle is ON (default: Complete OFF)
}

function makeViewState(): ViewState {
  return {
    activeTab: "projects",
    activeStatus: null,
    activeCategory: "all",
    expanded: new Set(),
    openOff: new Set(),
    completeOn: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

function nowIso(): string {
  const d = new Date();
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    ":" +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function isoDate(): string {
  const d = new Date();
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

function yearMonth(): { y: string; m: string } {
  const d = new Date();
  return { y: "" + d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1) };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

function asArray(v: any): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => ("" + x).trim());
  return [("" + v).trim()];
}

function isNull(v: any): boolean {
  return v == null || v === "null" || v === "";
}

function computeProgress(tasks: TaskItem[]): Progress {
  const counted = tasks.filter((t) => PROGRESS_STATUSES.includes(t.status));
  const done = counted.filter((t) => t.status === "done").length;
  const total = counted.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function inferStatusFromPath(path: string): string {
  if (path.includes("/done/")) return "done";
  if (path.includes("/cancelled/")) return "cancelled";
  if (path.includes("/in-progress/")) return "in-progress";
  return "open";
}

function readTasks(app: App, tasksRoot: string): TaskItem[] {
  const out: TaskItem[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(tasksRoot + "/")) continue;
    if (!file.basename.startsWith("tsk-")) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
    const status = fm.status ? ("" + fm.status) : inferStatusFromPath(file.path);
    const priority =
      fm.priority != null && fm.priority !== "" ? Number(fm.priority) : null;
    out.push({
      path: file.path,
      id: fm.id ? "" + fm.id : file.basename,
      title: fm.title ? ("" + fm.title) : file.basename,
      status,
      priority: isNaN(priority as number) ? null : priority,
      project: isNull(fm.project) ? null : ("" + fm.project).trim(),
      phase: isNull(fm.phase) ? null : ("" + fm.phase).trim(),
      lifeAreas: asArray(fm.linked_my_life),
      due: isNull(fm.due) ? null : "" + fm.due,
      updated: isNull(fm.updated) ? null : "" + fm.updated,
    });
  }
  return out;
}

function readProjects(app: App, projectsRoot: string): ProjectItem[] {
  const out: ProjectItem[] = [];
  const rootParts = projectsRoot.split("/").filter(Boolean);
  for (const file of app.vault.getMarkdownFiles()) {
    const parts = file.path.split("/");
    // <projectsRoot>/<slug>/<slug>.md
    if (parts.length !== rootParts.length + 2) continue;
    if (!rootParts.every((p, i) => parts[i] === p)) continue;
    const slug = parts[rootParts.length];
    if (parts[rootParts.length + 1] !== slug + ".md") continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
    out.push({
      path: file.path,
      slug,
      name: fm.name ? ("" + fm.name) : slug,
      status: fm.status ? ("" + fm.status) : "active",
      venture: isNull(fm.venture) ? null : "" + fm.venture,
      keyElement: isNull(fm.key_element) ? null : "" + fm.key_element,
      targetDate: isNull(fm.target_date) ? null : "" + fm.target_date,
      phases: asArray(fm.phases),
    });
  }
  return out;
}

// Resolve the ordered phase list for a project: declared phases first (in order),
// then any phases found on its tasks that weren't declared, in first-seen order.
function resolvePhaseOrder(project: ProjectItem, projectTasks: TaskItem[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const p of project.phases) {
    if (p && !seen.has(p)) {
      seen.add(p);
      order.push(p);
    }
  }
  for (const t of projectTasks) {
    if (t.phase && !seen.has(t.phase)) {
      seen.add(t.phase);
      order.push(t.phase);
    }
  }
  return order;
}

interface ProjectStatusGroup {
  slug: string;
  label: string;
  open: boolean;
  projects: ProjectItem[];
}

// Bucket projects into ordered status groups. Returns ONLY non-empty groups, in the
// order of `sections`; projects whose status is outside the configured set are collected
// into a trailing "Other" group so drift is surfaced, never silently dropped. Projects
// inside a group are sorted by name.
function groupProjectsByStatus(
  projects: ProjectItem[],
  sections: StatusSection[]
): ProjectStatusGroup[] {
  const known = new Set(sections.map((s) => s.slug));
  // Sort by display name, tie-broken by the unique slug so ordering is deterministic
  // across machines even when two projects share a name (readProjects order is FS-dependent).
  const byName = (a: ProjectItem, b: ProjectItem) =>
    a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  const out: ProjectStatusGroup[] = [];
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
// View-model helpers (pure: no Obsidian deps; unit-tested in viewModel.test.mjs)
// ---------------------------------------------------------------------------

interface Chip {
  slug: string;
  label: string;
  count: number;
}

// Projects-tab status chips: one per non-empty status group, label + count, order preserved
// (Other stays last). Derived from groupProjectsByStatus output so the two never disagree.
function statusChipsFromGroups(groups: ProjectStatusGroup[]): Chip[] {
  return groups.map((g) => ({ slug: g.slug, label: g.label, count: g.projects.length }));
}

interface SplitTasks {
  doing: TaskItem[];
  open: TaskItem[];
  done: TaskItem[];
}

// Partition a project's tasks (caller passes non-cancelled tasks) into in-progress / open /
// done buckets. Unknown statuses are ignored. Caller sorts each bucket for display.
function splitProjectTasks(tasks: TaskItem[]): SplitTasks {
  return {
    doing: tasks.filter((t) => t.status === "in-progress"),
    open: tasks.filter((t) => t.status === "open"),
    done: tasks.filter((t) => t.status === "done"),
  };
}

// Tasks-tab category chips: one per bucket with >=1 standalone task, plus an `inbox` entry
// when any standalone task has no recognized life-area. The renderer prepends an "All" chip.
function categoryChipsFromTasks(
  standaloneTasks: TaskItem[],
  buckets: { slug: string; label: string }[]
): Chip[] {
  const out: Chip[] = [];
  for (const b of buckets) {
    const count = standaloneTasks.filter((t) => t.lifeAreas.includes(b.slug)).length;
    if (count > 0) out.push({ slug: b.slug, label: b.label, count });
  }
  const known = buckets.map((b) => b.slug);
  const inboxCount = standaloneTasks.filter(
    (t) => !t.lifeAreas.some((a) => known.includes(a))
  ).length;
  if (inboxCount > 0) out.push({ slug: "inbox", label: "Inbox", count: inboxCount });
  return out;
}

// The single category pill shown on a standalone task row: the first recognized life-area
// (in bucket order), else Inbox.
function tagForTask(
  task: TaskItem,
  buckets: { slug: string; label: string }[]
): { slug: string; label: string } {
  for (const b of buckets) {
    if (task.lifeAreas.includes(b.slug)) return { slug: b.slug, label: b.label };
  }
  return { slug: "inbox", label: "Inbox" };
}

// Filter the flat standalone list by the selected category chip. `all` = passthrough,
// `inbox` = tasks with no recognized life-area, otherwise tasks tagged with that slug.
function filterStandaloneByCategory(
  standaloneTasks: TaskItem[],
  categorySlug: string,
  buckets: { slug: string; label: string }[]
): TaskItem[] {
  if (categorySlug === "all") return standaloneTasks;
  if (categorySlug === "inbox") {
    const known = buckets.map((b) => b.slug);
    return standaloneTasks.filter((t) => !t.lifeAreas.some((a) => known.includes(a)));
  }
  return standaloneTasks.filter((t) => t.lifeAreas.includes(categorySlug));
}

// ---------------------------------------------------------------------------
// Health model (pure: no Obsidian deps; unit-tested in healthModel.test.mjs).
// gatherHealthInput (below, in the Renderers section) is the impure half that
// turns live vault/metadataCache state into this plain-data shape.
// ---------------------------------------------------------------------------

interface HealthItem {
  path: string;
  label: string;
  detail: string;
}

interface HealthTile {
  key: string;
  label: string;
  count: number;
  summary: string;
  warn: boolean;
  items: HealthItem[];
  prompt: string;
}

// Canned Dispatch prompt per health-tile key, shown as "Fix with Dispatch" in the
// detail modal. Keyed by HealthTile.key (the internal computeHealth id, not the
// UI label). stale-in-progress and stale-open share the same reconcile prompt;
// orphan-tasks and status-mismatch share the same consistency-fix prompt.
const HEALTH_TILE_PROMPTS: Record<string, string> = {
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

interface HealthTaskInput {
  path: string;
  title: string;
  status: string; // effective status (frontmatter or folder-inferred)
  declaredStatus: string | null; // raw frontmatter status, null when absent
  project: string | null;
  ageDays: number; // days since `updated` (fallback: file mtime)
}

interface HealthInput {
  intakeFiles: { path: string; name: string; ageDays: number }[];
  journalFiles: { path: string; name: string; ingested: boolean }[];
  tasks: HealthTaskInput[];
  projectSlugs: string[];
  unresolvedLinks: { source: string; target: string; count: number }[];
  linkCheckExcludes: string[];
  thresholds: {
    intakeWarnDays: number;
    inProgressStaleDays: number;
    openStaleDays: number;
  };
}

// Same rule main.ts uses to derive a task's status from its folder location.
// Mirrored here (not reused) so the health model stays a standalone pure unit,
// matching the pattern of the other MIRRORED functions in the test suite.
function healthInferStatusFromPath(path: string): string {
  if (path.includes("/done/")) return "done";
  if (path.includes("/cancelled/")) return "cancelled";
  if (path.includes("/in-progress/")) return "in-progress";
  return "open";
}

function excludedBySource(source: string, excludes: string[]): boolean {
  return excludes.some((ex) => source === ex || source.startsWith(ex + "/"));
}

// Compute the health tiles from plain, pre-gathered data. Tiles whose count is
// zero are omitted entirely (calm when healthy). No Obsidian API calls here.
function computeHealth(input: HealthInput): HealthTile[] {
  const tiles: HealthTile[] = [];

  // 1. Intake backlog: exclude README.md and dotfiles.
  const intake = input.intakeFiles.filter(
    (f) => f.name !== "README.md" && !f.name.startsWith(".")
  );
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
    const bySource = new Map<string, number>();
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
// Usage model (pure: no Obsidian deps; unit-tested in usageModel.test.mjs).
// renderUsageTab (below, in the Renderers section) is the impure half that
// reads usage-stats.json off disk and turns it into this plain-data shape.
// ---------------------------------------------------------------------------

interface UsageFamilyBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messages: number;
  costUsd: number;
}

interface UsageDay {
  date: string;
  models: Record<string, UsageFamilyBucket>;
  totalCostUsd: number;
  totalOutputTokens: number;
}

interface UsageProjectStat {
  name: string;
  costUsd: number;
  outputTokens: number;
  messages: number;
}

interface UsageWorkflowStat {
  key: string;
  label: string;
  costUsd: number;
  outputTokens: number;
  messages: number;
  sessions: number;
}

interface UsageStats {
  generatedAt: string;
  windowDays: number;
  days: UsageDay[];
  projects: UsageProjectStat[];
  // Optional: absent in JSON written before build 2.5. The Usage tab hides
  // the workflows section entirely when this is missing.
  workflows?: UsageWorkflowStat[];
  totals: { last7DaysCostUsd: number; last30DaysCostUsd: number; todayCostUsd: number };
}

interface UsageChartSegment {
  family: string;
  costUsd: number;
  heightFraction: number;
}

interface UsageChartDay {
  date: string;
  totalCostUsd: number;
  totalFraction: number;
  segments: UsageChartSegment[];
}

interface UsageGridline {
  fraction: number;
  value: number;
  label: string;
}

interface UsageChart {
  days: UsageChartDay[];
  maxCost: number;
  gridlines: UsageGridline[];
  xLabelIndices: number[];
}

interface UsageLegendItem {
  family: string;
  label: string;
  costUsd: number;
}

interface UsageTableRow {
  family: string;
  label: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface UsageProjectRow {
  name: string;
  costUsd: number;
  outputTokens: number;
}

interface UsageView {
  hasData: boolean;
  tiles: {
    todayCostUsd: number;
    last7DaysCostUsd: number;
    last30DaysCostUsd: number;
    last30DaysOutputTokensCompact: string;
  };
  chart: UsageChart;
  legend: UsageLegendItem[];
  table: UsageTableRow[];
  projects: UsageProjectRow[];
}

// Fixed family order: drives stacking order, legend order, and table order so
// the three views never disagree with each other.
const USAGE_FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku", "other"];
const USAGE_FAMILY_LABELS: Record<string, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  other: "Other",
};

function usagePad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

// Local (not UTC) calendar-day key, matching the exporter's per-day bucketing.
function usageLocalDayKey(d: Date): string {
  return d.getFullYear() + "-" + usagePad2(d.getMonth() + 1) + "-" + usagePad2(d.getDate());
}

function usageEmptyBucket(): UsageFamilyBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 0, costUsd: 0 };
}

// Compact number formatting for token counts: 1.2k, 3.4M, 4.2M, 1.5B. Plain
// integers stay plain below 1000. MIRRORED in usageModel.test.mjs.
function formatCompactNumber(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return sign + Math.round(abs).toString();
}

function formatUsd(n: number): string {
  return "$" + n.toFixed(2);
}

// Pure view-model function: turns the exporter's usage-stats.json shape plus
// "now" into everything the Usage tab renders (tiles, chart, legend, table,
// projects). `nowDate` is passed in (not read from the clock) so the tile
// math (today/7d/30d boundaries) and the always-30-entries chart window are
// unit-testable without mocking time. MIRRORED in usageModel.test.mjs.
function computeUsageView(stats: UsageStats, nowDate: Date): UsageView {
  const dayByDate = new Map(stats.days.map((d) => [d.date, d]));

  // A continuous 30-calendar-day window ending today. Days with no transcript
  // activity are zero-cost placeholders, not omitted, so the chart always has
  // exactly 30 bars.
  const windowDays: UsageDay[] = [];
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

  const chartDays: UsageChartDay[] = windowDays.map((d) => {
    const segments: UsageChartSegment[] = [];
    for (const fam of USAGE_FAMILY_ORDER) {
      const bucket = d.models[fam];
      if (!bucket || bucket.costUsd <= 0) continue;
      segments.push({ family: fam, costUsd: bucket.costUsd, heightFraction: bucket.costUsd / safeMax });
    }
    return { date: d.date, totalCostUsd: d.totalCostUsd, totalFraction: d.totalCostUsd / safeMax, segments };
  });

  const gridlines: UsageGridline[] = [1, 0.5, 0].map((frac) => ({
    fraction: frac,
    value: maxCost * frac,
    label: formatUsd(maxCost * frac),
  }));

  const xLabelIndices: number[] = [];
  for (let i = 0; i < windowDays.length; i += 7) xLabelIndices.push(i);
  if (xLabelIndices[xLabelIndices.length - 1] !== windowDays.length - 1) {
    xLabelIndices.push(windowDays.length - 1);
  }

  // 30d per-family totals, feeding both the legend and the breakdown table.
  const famTotals = new Map<string, UsageFamilyBucket>();
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

  const legend: UsageLegendItem[] = USAGE_FAMILY_ORDER.filter((f) => famTotals.has(f)).map((f) => ({
    family: f,
    label: USAGE_FAMILY_LABELS[f],
    costUsd: famTotals.get(f)!.costUsd,
  }));

  const table: UsageTableRow[] = USAGE_FAMILY_ORDER.filter((f) => famTotals.has(f)).map((f) => {
    const b = famTotals.get(f)!;
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

  const projects: UsageProjectRow[] = stats.projects
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

// Known workflow keys in the exporter's classification order. Drives a stable
// color index per key so the share bar, legend, and table dots never disagree
// and colors don't shift as costs change between runs. MIRRORED in
// usageModel.test.mjs.
const USAGE_WORKFLOW_COLOR_ORDER = [
  "telegram-bridge",
  "telegram-ingest",
  "email-router",
  "email-followups",
  "email-postmortem",
  "email-other",
  "learning-scan",
  "interactive",
];
const USAGE_WORKFLOW_COLOR_COUNT = 8;

// Stable color index for a workflow key: known keys map to a fixed slot;
// any future key (added to the exporter's rule table later) falls back to a
// deterministic hash so it still always lands on the same color.
function usageWorkflowColorIndex(key: string): number {
  const idx = USAGE_WORKFLOW_COLOR_ORDER.indexOf(key);
  if (idx >= 0) return idx;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % USAGE_WORKFLOW_COLOR_COUNT;
}

interface UsageWorkflowShareRow {
  key: string;
  label: string;
  costUsd: number;
  sharePercent: number;
  colorIndex: number;
}

interface UsageWorkflowTableRow extends UsageWorkflowStat {
  colorIndex: number;
}

interface UsageWorkflowsView {
  hasData: boolean;
  shareBar: UsageWorkflowShareRow[];
  table: UsageWorkflowTableRow[];
}

// Pure view-model function: turns the exporter's optional `workflows` block
// into the share-bar + table shapes the Usage tab renders. Missing/empty
// `workflows` (old JSON, or a window with no transcripts) yields hasData:
// false so the caller can hide the whole section. Order is preserved as
// delivered by the exporter (sorted by costUsd desc). MIRRORED in
// usageModel.test.mjs.
function computeWorkflowsView(stats: UsageStats): UsageWorkflowsView {
  const workflows = stats.workflows;
  if (!Array.isArray(workflows) || workflows.length === 0) {
    return { hasData: false, shareBar: [], table: [] };
  }

  const total = workflows.reduce((s, w) => s + w.costUsd, 0);
  const safeTotal = total > 0 ? total : 1;

  const shareBar: UsageWorkflowShareRow[] = workflows.map((w) => ({
    key: w.key,
    label: w.label,
    costUsd: w.costUsd,
    sharePercent: (w.costUsd / safeTotal) * 100,
    colorIndex: usageWorkflowColorIndex(w.key),
  }));

  const table: UsageWorkflowTableRow[] = workflows.map((w) => ({
    ...w,
    colorIndex: usageWorkflowColorIndex(w.key),
  }));

  return { hasData: true, shareBar, table };
}

// ---------------------------------------------------------------------------
// Writers (the interactive half)
// ---------------------------------------------------------------------------

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  let cur = "";
  for (const p of parts) {
    cur = cur ? cur + "/" + p : p;
    const exists = await app.vault.adapter.exists(cur);
    if (!exists) {
      try {
        await app.vault.createFolder(cur);
      } catch (e) {
        /* race: another create won; ignore */
      }
    }
  }
}

function folderForStatus(tasksRoot: string, status: string): string {
  if (status === "done") {
    const { y, m } = yearMonth();
    return `${tasksRoot}/done/${y}/${m}`;
  }
  if (status === "cancelled") {
    const { y, m } = yearMonth();
    return `${tasksRoot}/cancelled/${y}/${m}`;
  }
  if (status === "in-progress") return `${tasksRoot}/in-progress`;
  return `${tasksRoot}/open`;
}

// Set a task's status, stamp `updated`, and move the file to the folder that
// mirrors the new status (per the AIOS task lifecycle, SOP-close-task).
async function setTaskStatus(
  app: App,
  tasksRoot: string,
  path: string,
  newStatus: string
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice("AIOS: task file not found: " + path);
    return;
  }
  await app.fileManager.processFrontMatter(file, (fm: any) => {
    fm.status = newStatus;
    fm.updated = nowIso();
    if (newStatus === "done" || newStatus === "cancelled") {
      if ("blocked_reason" in fm) fm.blocked_reason = null;
      if ("blocked_by" in fm) fm.blocked_by = null;
    }
  });
  const destFolder = folderForStatus(tasksRoot, newStatus);
  await ensureFolder(app, destFolder);
  const newPath = `${destFolder}/${file.name}`;
  if (file.path !== newPath) {
    try {
      await app.fileManager.renameFile(file, newPath);
    } catch (e) {
      new Notice("AIOS: could not move task file. " + (e?.message || e));
    }
  }
}

async function nextTaskId(app: App, day: string): Promise<string> {
  let max = 0;
  const prefix = "tsk-" + day + "-";
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.basename.startsWith(prefix)) continue;
    const rest = file.basename.slice(prefix.length);
    const num = parseInt(rest.slice(0, 3), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return prefix + pad3(max + 1);
}

function pad3(n: number): string {
  let s = "" + n;
  while (s.length < 3) s = "0" + s;
  return s;
}

// Phase names and titles routinely contain ": " (e.g. "Phase 0: Storefront"),
// which is illegal in an unquoted YAML scalar and silently breaks the
// metadata cache. Always emit a double-quoted, escaped scalar.
function yamlQuote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function createQuickTask(
  app: App,
  tasksRoot: string,
  opts: { title: string; project: string | null; phase: string | null; keyElement: string | null }
): Promise<void> {
  const title = opts.title.trim();
  if (!title) return;
  const day = isoDate();
  const id = await nextTaskId(app, day);
  const slug = slugify(title) || "task";
  const folder = `${tasksRoot}/open`;
  await ensureFolder(app, folder);
  const path = `${folder}/${id}-${slug}.md`;
  const now = nowIso();
  const phaseLine =
    opts.project != null && opts.phase ? `phase: ${yamlQuote(opts.phase)}\n` : "";
  const lifeLine =
    opts.project == null && opts.keyElement
      ? `linked_my_life: [${yamlQuote(opts.keyElement)}]\n`
      : "";
  const projectVal = opts.project == null ? "null" : opts.project;
  const content =
    `---\n` +
    `id: ${id}\n` +
    `title: ${yamlQuote(title)}\n` +
    `status: open\n` +
    `project: ${projectVal}\n` +
    phaseLine +
    lifeLine +
    `created: ${now}\n` +
    `updated: ${now}\n` +
    `tags: [quick]\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `## What this is\n` +
    `Quick task created from the AIOS Dashboard. Enrich later if it grows (see [[SOP-create-task]]).\n\n` +
    `## Updates\n` +
    `- ${day} (dashboard) - created\n`;
  try {
    await app.vault.create(path, content);
    new Notice("AIOS: added task " + id);
  } catch (e) {
    new Notice("AIOS: could not create task. " + (e?.message || e));
  }
}

// ---------------------------------------------------------------------------
// Launch Dispatch: build a launch command (pure, unit-tested in
// launchModel.test.mjs) and run it (impure, desktop-only). Three modes:
// terminal (macOS Terminal.app via AppleScript), iterm (iTerm2 via
// AppleScript), custom (a user shell template run directly).
//
// QUOTING: the inner shell command (cd into the vault, run the claude binary,
// pass the prompt as a single argument) is built with POSIX single-quoting
// (each argument wrapped in '...', embedded single quotes escaped as '\'').
// That whole string is then embedded as an AppleScript double-quoted string
// literal for terminal/iterm modes, so it needs its own escaping pass
// (backslash and double-quote). Getting the order right (shell-quote first,
// then AppleScript-quote the result) is what keeps prompts with quotes safe.
// ---------------------------------------------------------------------------

// Wrap a single shell argument in POSIX single quotes, escaping any embedded
// single quotes with the standard '\'' technique.
function shellQuoteSingle(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Escape a string for embedding inside an AppleScript double-quoted literal.
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Like buildInnerShellCommand but without the cd: the IDE's integrated
// terminal already opens in the workspace folder.
function buildInnerShellCommandNoCd(claudeBinary: string, prompt: string | null): string {
  const parts = [shellQuoteSingle(claudeBinary)];
  if (prompt != null) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

// The shell command run inside the terminal: cd into the vault, then run the
// claude binary with the prompt as a single trailing argument (omitted when
// prompt is null, giving a plain interactive session).
function buildInnerShellCommand(
  claudeBinary: string,
  vaultPath: string,
  prompt: string | null
): string {
  const parts = ["cd", shellQuoteSingle(vaultPath), "&&", shellQuoteSingle(claudeBinary)];
  if (prompt != null) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

// Pure: returns the exact argv to spawn for a given launch mode. Never touches
// the filesystem or a process, so it is fully unit-testable.
function buildLaunchCommand(
  mode: "terminal" | "iterm" | "app" | "custom",
  claudeBinary: string,
  vaultPath: string,
  prompt: string | null,
  customCommand: string,
  ideAppName?: string,
  openVaultFolder?: boolean,
  autoSession?: boolean,
  sessionTarget?: "terminal" | "extension",
  newSessionCommand?: string
): string[] {
  // "app" activates a macOS app (IDE) via open -a; no CLI on PATH required.
  // By default it does NOT pass the vault path: VS Code forks treat a folder
  // argument as "open a new workspace window", which yanks the user away from
  // the window their Claude session already lives in. Activate-only brings the
  // last-used window forward instead. The prompt cannot be injected into an
  // IDE session, so the caller copies it to the clipboard (see launchDispatch).
  // With autoSession, a System Events script (needs Accessibility permission
  // for Obsidian) opens a fresh integrated terminal in the IDE and paste-runs
  // the claude command with the prompt: the true one-click flow.
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

// Impure: spawns the argv built above. Detached and unref'd so the plugin does
// not wait on (or block Obsidian on) the launched process. Never throws into
// the render path; failures surface via Notice.
function runLaunchCommand(argv: string[], cwd?: string): void {
  try {
    // Desktop-only Obsidian ships Node/Electron; `require` resolves at runtime.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = require("child_process");
    const [cmd, ...args] = argv;
    const child = cp.spawn(cmd, args, { cwd, detached: true, stdio: "ignore" });
    child.unref();
  } catch (e) {
    new Notice("AIOS: could not launch Dispatch. " + (e?.message || e));
  }
}

// The thin orchestrator called from UI: resolves desktop-only, builds the
// command, and runs it. `prompt` null gives a plain interactive session.
function launchDispatch(
  settings: AiosDashboardSettings,
  vaultAbsolutePath: string,
  prompt: string | null
): void {
  if (!Platform.isDesktop) {
    new Notice("AIOS: Dispatch actions are desktop-only.");
    return;
  }
  try {
    const argv = buildLaunchCommand(
      settings.launchMode,
      settings.claudeBinary,
      vaultAbsolutePath,
      prompt,
      settings.customCommand,
      settings.ideAppName,
      settings.ideOpenVaultFolder,
      settings.ideAutoSession,
      settings.ideSessionTarget,
      settings.ideNewSessionCommand
    );
    const cwd = settings.launchMode === "custom" ? vaultAbsolutePath : undefined;
    runLaunchCommand(argv, cwd);
    if (settings.launchMode === "app" && settings.ideAutoSession) {
      new Notice(
        "AIOS: launching a Claude session in the IDE. If nothing types, grant Obsidian Accessibility permission (System Settings > Privacy & Security > Accessibility)."
      );
      return;
    }
    // An IDE can't receive the prompt as an argument; hand it over via clipboard.
    if (settings.launchMode === "app" && prompt != null) {
      navigator.clipboard
        .writeText(prompt)
        .then(() => new Notice("AIOS: opened IDE. Prompt copied, paste it into Claude there."))
        .catch(() => new Notice("AIOS: opened IDE, but could not copy the prompt."));
    }
  } catch (e) {
    new Notice("AIOS: could not launch Dispatch. " + (e?.message || e));
  }
}

// Resolve the vault's absolute filesystem path via the desktop adapter. Returns
// null (and surfaces a Notice) when unavailable, e.g. a non-desktop adapter.
function getVaultBasePath(app: App): string | null {
  const adapter = app.vault.adapter as any;
  const base = adapter?.getBasePath?.();
  if (typeof base !== "string" || !base) {
    new Notice("AIOS: could not resolve the vault's file path.");
    return null;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Quick-add modal
// ---------------------------------------------------------------------------

class AddTaskModal extends Modal {
  private title = "";
  private category: string | null = null; // null = Inbox / none
  private contextLabel: string;
  private buckets: { slug: string; label: string }[];
  private onSubmit: (title: string, category: string | null) => void;

  constructor(
    app: App,
    contextLabel: string,
    buckets: { slug: string; label: string }[],
    onSubmit: (title: string, category: string | null) => void
  ) {
    super(app);
    this.contextLabel = contextLabel;
    this.buckets = buckets;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("aios-modal");
    contentEl.createEl("h3", { text: "New task" });
    contentEl.createEl("div", {
      cls: "aios-modal-context",
      text: this.contextLabel,
    });

    const setting = new Setting(contentEl).setName("Title").addText((t) => {
      t.setPlaceholder("What needs doing?");
      t.onChange((v) => (this.title = v));
      t.inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    setting.settingEl.addClass("aios-modal-setting");

    // Category picker only when buckets are offered (standalone add). Project/phase adds
    // pass an empty buckets array and skip it.
    if (this.buckets.length > 0) {
      new Setting(contentEl).setName("Category").addDropdown((d) => {
        d.addOption("", "Inbox / none");
        for (const b of this.buckets) d.addOption(b.slug, b.label);
        d.setValue("");
        d.onChange((v) => (this.category = v === "" ? null : v));
      });
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Add task")
        .setCta()
        .onClick(() => this.submit())
    );
  }

  private submit() {
    const t = this.title.trim();
    if (!t) {
      new Notice("AIOS: a task needs a title.");
      return;
    }
    this.onSubmit(t, this.category);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Shared renderer (used by both the ItemView and the inline code block)
// ---------------------------------------------------------------------------

function priorityMeta(p: number | null): { label: string; cls: string } {
  switch (p) {
    case 1:
      return { label: "P1", cls: "aios-p1" };
    case 2:
      return { label: "P2", cls: "aios-p2" };
    case 3:
      return { label: "P3", cls: "aios-p3" };
    case 4:
      return { label: "P4", cls: "aios-p4" };
    default:
      return { label: "", cls: "" };
  }
}

function sortTasks(a: TaskItem, b: TaskItem): number {
  const pa = a.priority ?? 5;
  const pb = b.priority ?? 5;
  if (pa !== pb) return pa - pb;
  const da = a.due || "9999";
  const db = b.due || "9999";
  if (da !== db) return da < db ? -1 : 1;
  return a.title.localeCompare(b.title);
}

// Tasks to show inside a phase given the two per-project toggles. Open shows when showOpen,
// done shows when showComplete; in-progress lives in the DOING NOW strip and cancelled is
// never shown. Sorted by the shared sortTasks order so open and done interleave in sequence.
// MIRRORED in viewModel.test.mjs; keep the two in sync.
function visiblePhaseTasks(
  phaseTasks: TaskItem[],
  showOpen: boolean,
  showComplete: boolean
): TaskItem[] {
  return phaseTasks
    .filter(
      (t) => (t.status === "open" && showOpen) || (t.status === "done" && showComplete)
    )
    .sort(sortTasks);
}

// A progress bar: a multi-color gradient (red -> amber -> green) revealed up to pct,
// plus a "done/total · pct%" label. Calculated, honest (0 when empty). The fill width
// is driven by the --aios-pct CSS var; the empty portion is masked in CSS.
function renderProgressBar(container: HTMLElement, p: Progress, extraCls?: string) {
  const wrap = container.createDiv({ cls: "aios-bar-wrap" + (extraCls ? " " + extraCls : "") });
  const track = wrap.createDiv({ cls: "aios-bar" });
  track.style.setProperty("--aios-pct", p.pct + "%");
  if (p.pct === 100 && p.total > 0) track.addClass("aios-bar-complete");
  wrap.createSpan({
    cls: "aios-bar-label",
    text: p.total === 0 ? "no tasks yet" : `${p.done}/${p.total} · ${p.pct}%`,
  });
}

// Visual meta for a task's current status: the control pill label + class.
function statusCtlMeta(status: string): { label: string; cls: string } {
  switch (status) {
    case "in-progress":
      return { label: "In progress", cls: "aios-ctl-inprogress" };
    case "done":
      return { label: "Done", cls: "aios-ctl-done" };
    case "cancelled":
      return { label: "Cancelled", cls: "aios-ctl-cancelled" };
    default:
      return { label: "Open", cls: "aios-ctl-open" };
  }
}

// The per-task status control: a pill button that opens a menu of valid transitions.
// Replaces the v1 checkbox + Start button. Every transition calls setTaskStatus, shows a
// toast, and (for Done) offers Undo back to the prior status. Deliberate menu selection
// means no single mis-tap can complete or lose a task.
function renderStatusDropdown(
  app: App,
  tasksRoot: string,
  row: HTMLElement,
  task: TaskItem,
  refresh: () => void
) {
  const meta = statusCtlMeta(task.status);
  const btn = row.createEl("button", { cls: "aios-status-ctl " + meta.cls });
  btn.createSpan({ cls: "aios-ctl-label", text: meta.label });
  btn.createSpan({ cls: "aios-ctl-caret", text: "▾" });
  btn.setAttr("aria-label", "Change task status");

  const apply = async (newStatus: string, verb: string, undoTo: string | null) => {
    await setTaskStatus(app, tasksRoot, task.path, newStatus);
    const n = new Notice("", 6000);
    n.noticeEl.createSpan({ text: `${verb}: ${task.title}` });
    if (undoTo) {
      const undo = n.noticeEl.createEl("a", { cls: "aios-undo", text: "  Undo" });
      undo.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await setTaskStatus(app, tasksRoot, task.path, undoTo);
        n.hide();
        refresh();
      });
    }
    refresh();
  };

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const menu = new Menu();
    if (task.status === "open") {
      menu.addItem((i) =>
        i.setTitle("Start (in progress)").setIcon("play").onClick(() => apply("in-progress", "Started", null))
      );
      menu.addItem((i) =>
        i.setTitle("Done").setIcon("check").onClick(() => apply("done", "Completed", "open"))
      );
      menu.addItem((i) =>
        i.setTitle("Cancel task").setIcon("x").onClick(() => apply("cancelled", "Cancelled", "open"))
      );
    } else if (task.status === "in-progress") {
      menu.addItem((i) =>
        i.setTitle("Done").setIcon("check").onClick(() => apply("done", "Completed", "in-progress"))
      );
      menu.addItem((i) =>
        i.setTitle("Back to open").setIcon("rotate-ccw").onClick(() => apply("open", "Reopened", null))
      );
      menu.addItem((i) =>
        i.setTitle("Cancel task").setIcon("x").onClick(() => apply("cancelled", "Cancelled", "in-progress"))
      );
    } else {
      // done or any other terminal state: allow reopening.
      menu.addItem((i) =>
        i.setTitle("Reopen").setIcon("rotate-ccw").onClick(() => apply("open", "Reopened", null))
      );
    }
    menu.showAtMouseEvent(ev as MouseEvent);
  });
}

function renderTaskRow(
  app: App,
  tasksRoot: string,
  container: HTMLElement,
  task: TaskItem,
  refresh: () => void,
  tag?: { slug: string; label: string } | null
) {
  const row = container.createDiv({ cls: "aios-task" });
  if (task.status === "in-progress") row.addClass("aios-task-inprogress");
  if (task.status === "done") row.addClass("aios-task-done");

  const main = row.createDiv({ cls: "aios-task-main" });
  const titleEl = main.createDiv({ cls: "aios-task-title", text: task.title });
  titleEl.addEventListener("click", () => {
    app.workspace.openLinkText(task.path, "", false);
  });

  const meta = main.createDiv({ cls: "aios-task-meta" });
  if (tag) meta.createSpan({ cls: "aios-pill aios-tag", text: tag.label });
  const pm = priorityMeta(task.priority);
  if (pm.label) meta.createSpan({ cls: "aios-pill " + pm.cls, text: pm.label });
  if (task.due) {
    const overdue = task.due < isoDate();
    meta.createSpan({
      cls: "aios-pill aios-due" + (overdue ? " aios-overdue" : ""),
      text: "due " + task.due,
    });
  }

  renderStatusDropdown(app, tasksRoot, row, task, refresh);
}

function addButton(
  container: HTMLElement,
  app: App,
  tasksRoot: string,
  contextLabel: string,
  project: string | null,
  phase: string | null,
  keyElement: string | null,
  refresh: () => void
) {
  const btn = container.createEl("button", { cls: "aios-add", text: "+ Add task" });
  btn.addEventListener("click", () => {
    // Project/phase adds do not offer a category picker (buckets = []).
    new AddTaskModal(app, contextLabel, [], async (title, _category) => {
      await createQuickTask(app, tasksRoot, { title, project, phase, keyElement });
      refresh();
    }).open();
  });
}

// Two per-project view toggles in the card header. Open shows open tasks, Complete shows
// done tasks (both off = neither; both on = interleaved). State is in-memory in ViewState.
// stopPropagation so clicking a toggle does not also collapse the card head.
function renderProjectToggles(
  container: HTMLElement,
  proj: ProjectItem,
  viewState: ViewState,
  refresh: () => void
) {
  const row = container.createDiv({ cls: "aios-toggles" });
  const mk = (label: string, on: boolean, flip: () => void) => {
    const b = row.createEl("button", {
      cls: "aios-toggle" + (on ? " aios-toggle-on" : ""),
      text: label,
    });
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      flip();
      refresh();
    });
  };
  mk("Open", !viewState.openOff.has(proj.slug), () => {
    if (viewState.openOff.has(proj.slug)) viewState.openOff.delete(proj.slug);
    else viewState.openOff.add(proj.slug);
  });
  mk("Complete", viewState.completeOn.has(proj.slug), () => {
    if (viewState.completeOn.has(proj.slug)) viewState.completeOn.delete(proj.slug);
    else viewState.completeOn.add(proj.slug);
  });
}

function renderProjectCard(
  app: App,
  tasksRoot: string,
  section: HTMLElement,
  proj: ProjectItem,
  allTasks: TaskItem[],
  viewState: ViewState,
  refresh: () => void
) {
  // All non-cancelled tasks for this project (drives progress + display).
  const projTasks = allTasks.filter(
    (t) => t.project === proj.slug && t.status !== "cancelled"
  );

  const card = section.createDiv({ cls: "aios-card aios-proj-card" });
  const expandKey = "proj:" + proj.slug;
  if (viewState.expanded.has(expandKey)) card.addClass("aios-expanded");

  // Collapsed head: chevron + name (+ open-note) on the left, overall bar on the right.
  const head = card.createDiv({ cls: "aios-card-head aios-proj-head" });
  const left = head.createDiv({ cls: "aios-head-left" });
  left.createSpan({ cls: "aios-chevron", text: "▸" });
  const nameBlock = left.createDiv({ cls: "aios-name-block" });
  const nameRow = nameBlock.createDiv({ cls: "aios-name-row" });
  nameRow.createSpan({ cls: "aios-card-title", text: proj.name });
  const open = nameRow.createSpan({ cls: "aios-open-note", text: "↗" });
  open.setAttr("aria-label", "Open project note");
  open.addEventListener("click", (ev) => {
    ev.stopPropagation();
    app.workspace.openLinkText(proj.path, "", false);
  });
  const tag = proj.venture || proj.keyElement;
  nameBlock.createDiv({ cls: "aios-card-sub" }).setText(
    [proj.status, tag].filter(Boolean).join(" · ")
  );

  const right = head.createDiv({ cls: "aios-head-right" });
  renderProgressBar(right, computeProgress(projTasks), "aios-bar-project");
  renderProjectToggles(right, proj, viewState, refresh);

  head.addEventListener("click", () => {
    const nowExpanded = card.classList.toggle("aios-expanded");
    if (nowExpanded) viewState.expanded.add(expandKey);
    else viewState.expanded.delete(expandKey);
  });

  // Collapsible body.
  const body = card.createDiv({ cls: "aios-card-body" });
  const split = splitProjectTasks(projTasks);

  // Doing now strip: in-progress tasks pinned at the top with an accent.
  if (split.doing.length > 0) {
    const strip = body.createDiv({ cls: "aios-doing" });
    strip.createDiv({ cls: "aios-doing-label", text: "DOING NOW" });
    const list = strip.createDiv({ cls: "aios-list" });
    for (const t of split.doing.slice().sort(sortTasks)) renderTaskRow(app, tasksRoot, list, t, refresh);
  }

  // Per-project view toggles: Open shows open tasks, Complete shows done tasks. In-progress
  // lives in the DOING NOW strip above; cancelled is never shown.
  const showOpen = !viewState.openOff.has(proj.slug);
  const showComplete = viewState.completeOn.has(proj.slug);

  // A phase rendered as a collapsible card. Head (name + project-style bar + chevron) is
  // always visible; body (the toggle-filtered task list + add button) shows only when the
  // phase card is expanded. Default collapsed: expanded only when its key is in viewState.
  const renderPhaseCard = (
    phaseName: string | null,
    phaseTasks: TaskItem[],
    addCtxLabel: string
  ) => {
    const pcard = body.createDiv({ cls: "aios-card aios-phase-card" });
    const pkey = "phase:" + proj.slug + ":" + (phaseName ?? "__none__");
    if (viewState.expanded.has(pkey)) pcard.addClass("aios-expanded");

    const phead = pcard.createDiv({ cls: "aios-card-head aios-phase-head" });
    const pleft = phead.createDiv({ cls: "aios-head-left" });
    pleft.createSpan({ cls: "aios-chevron", text: "▸" });
    pleft.createSpan({ cls: "aios-phase-name", text: phaseName ?? "No phase" });
    const pright = phead.createDiv({ cls: "aios-head-right" });
    renderProgressBar(pright, computeProgress(phaseTasks), "aios-bar-project");
    phead.addEventListener("click", () => {
      const nowOpen = pcard.classList.toggle("aios-expanded");
      if (nowOpen) viewState.expanded.add(pkey);
      else viewState.expanded.delete(pkey);
    });

    const pbody = pcard.createDiv({ cls: "aios-card-body" });
    const list = pbody.createDiv({ cls: "aios-list" });
    const visible = visiblePhaseTasks(phaseTasks, showOpen, showComplete);
    if (visible.length === 0) {
      list.createDiv({ cls: "aios-empty", text: "No tasks match the current view." });
    } else {
      for (const t of visible) renderTaskRow(app, tasksRoot, list, t, refresh);
    }
    addButton(pbody, app, tasksRoot, addCtxLabel, proj.slug, phaseName, null, refresh);
  };

  const phaseOrder = resolvePhaseOrder(proj, projTasks);
  const hasPhases = phaseOrder.length > 0 && projTasks.some((t) => t.phase);

  if (hasPhases) {
    for (const phase of phaseOrder) {
      const phaseTasks = projTasks.filter((t) => t.phase === phase);
      if (phaseTasks.length === 0) continue;
      renderPhaseCard(phase, phaseTasks, `${proj.name} - ${phase}`);
    }
    const unphased = projTasks.filter((t) => !t.phase);
    if (unphased.length > 0) renderPhaseCard(null, unphased, `${proj.name} - unphased`);
  } else {
    renderPhaseCard(null, projTasks, `Project: ${proj.name}`);
  }
}

// A single-select chip row. One engine for both the status chips (Projects tab) and the
// category chips (Tasks tab): variation is data, not code.
function renderChips(
  container: HTMLElement,
  chips: Chip[],
  activeSlug: string,
  onPick: (slug: string) => void
) {
  const row = container.createDiv({ cls: "aios-chips" });
  for (const c of chips) {
    const chip = row.createEl("button", {
      cls: "aios-chip" + (c.slug === activeSlug ? " aios-chip-active" : ""),
    });
    chip.createSpan({ cls: "aios-chip-label", text: c.label });
    chip.createSpan({ cls: "aios-chip-count", text: String(c.count) });
    chip.addEventListener("click", () => onPick(c.slug));
  }
}

// Projects tab: status filter chips + the cards for the selected status. Empty statuses
// produce no chip. Selection persists in viewState across live re-renders.
function renderProjectsTab(
  app: App,
  tasksRoot: string,
  container: HTMLElement,
  projects: ProjectItem[],
  tasks: TaskItem[],
  viewState: ViewState,
  refresh: () => void,
  hostFm: Record<string, unknown> | undefined
) {
  const statusSections = resolveStatusSections(hostFm);
  const groups = groupProjectsByStatus(projects, statusSections);

  if (groups.length === 0) {
    container.createDiv({ cls: "aios-empty", text: "No projects yet." });
    return;
  }

  const chips = statusChipsFromGroups(groups);
  // Keep the selection if it still has projects, else fall back to the first group.
  let active = viewState.activeStatus;
  if (!active || !groups.some((g) => g.slug === active)) {
    active = groups[0].slug;
    viewState.activeStatus = active;
  }
  renderChips(container, chips, active, (slug) => {
    viewState.activeStatus = slug;
    refresh();
  });

  const group = groups.find((g) => g.slug === active);
  if (!group) return;
  for (const proj of group.projects) {
    renderProjectCard(app, tasksRoot, container, proj, tasks, viewState, refresh);
  }
}

// Tasks tab: one flat list of standalone tasks, each tagged with its category pill, with
// category filter chips and a single Add button (category chosen in the modal). A Completed
// dropdown holds recently-done standalone tasks.
function renderTasksTab(
  app: App,
  tasksRoot: string,
  container: HTMLElement,
  tasks: TaskItem[],
  buckets: { slug: string; label: string }[],
  viewState: ViewState,
  refresh: () => void
) {
  const standaloneOpen = tasks.filter(
    (t) => t.project == null && OPEN_STATUSES.includes(t.status)
  );

  const catChips = categoryChipsFromTasks(standaloneOpen, buckets);
  const allChips: Chip[] = [
    { slug: "all", label: "All", count: standaloneOpen.length },
    ...catChips,
  ];

  // Keep the selection if it still has tasks, else fall back to "all".
  let active = viewState.activeCategory || "all";
  if (active !== "all" && !catChips.some((c) => c.slug === active)) {
    active = "all";
    viewState.activeCategory = "all";
  }

  // Bar: chips on the left, the single Add button on the right.
  const bar = container.createDiv({ cls: "aios-tasks-bar" });
  renderChips(bar, allChips, active, (slug) => {
    viewState.activeCategory = slug;
    refresh();
  });
  const addWrap = bar.createDiv({ cls: "aios-tasks-add" });
  const addBtn = addWrap.createEl("button", { cls: "aios-add", text: "+ Add task" });
  addBtn.addEventListener("click", () => {
    new AddTaskModal(app, "New standalone task", buckets, async (title, categorySlug) => {
      await createQuickTask(app, tasksRoot, { title, project: null, phase: null, keyElement: categorySlug });
      refresh();
    }).open();
  });

  // Flat tagged list.
  const filtered = filterStandaloneByCategory(standaloneOpen, active, buckets).slice().sort(sortTasks);
  const list = container.createDiv({ cls: "aios-list aios-tasks-list" });
  if (filtered.length === 0) {
    list.createDiv({ cls: "aios-empty", text: "Nothing here." });
  } else {
    for (const t of filtered) renderTaskRow(app, tasksRoot, list, t, refresh, tagForTask(t, buckets));
  }

  // Completed (standalone, last 7 days).
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const done = tasks
    .filter(
      (t) =>
        t.project == null &&
        t.status === "done" &&
        t.updated &&
        Date.parse(t.updated) >= cutoff
    )
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  if (done.length > 0) {
    const dKey = "done:standalone";
    const det = container.createEl("details", { cls: "aios-completed" });
    if (viewState.expanded.has(dKey)) det.setAttr("open", "");
    const sum = det.createEl("summary", { cls: "aios-completed-summary" });
    sum.createSpan({ cls: "aios-done-check", text: "✓" });
    sum.createSpan({ text: ` Completed (${done.length})` });
    det.addEventListener("toggle", () => {
      if (det.open) viewState.expanded.add(dKey);
      else viewState.expanded.delete(dKey);
    });
    const dlist = det.createDiv({ cls: "aios-list" });
    for (const t of done) renderTaskRow(app, tasksRoot, dlist, t, refresh, tagForTask(t, buckets));
  }
}

// ---------------------------------------------------------------------------
// Health strip: gather (impure) + render + modal.
// ---------------------------------------------------------------------------

// Days between `iso` (or a file's mtime when iso is absent) and now.
function ageDaysFor(app: App, path: string, iso: string | null): number {
  let ms = iso ? Date.parse(iso) : NaN;
  if (isNaN(ms)) {
    const file = app.vault.getAbstractFileByPath(path);
    ms = file instanceof TFile ? file.stat.mtime : Date.now();
  }
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

// Direct-child files of a folder (not recursive). Returns [] when the folder
// does not exist, so a missing intake/journal folder degrades to "no data"
// instead of an error.
function directChildFiles(app: App, folderPath: string): TFile[] {
  const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!(folder instanceof TFolder)) return [];
  return folder.children.filter((c): c is TFile => c instanceof TFile);
}

// Builds the plain-data HealthInput from live vault/metadataCache state. Reuses
// the tasks/projects already read for the main dashboard render (no extra
// vault-wide scan) and adds one direct-child listing each for the intake and
// journal folders, plus the metadataCache's existing unresolvedLinks map.
function gatherHealthInput(
  app: App,
  settings: AiosDashboardSettings,
  tasks: TaskItem[],
  projects: ProjectItem[]
): HealthInput {
  const intakeFiles = directChildFiles(app, settings.intakeFolder).map((f) => ({
    path: f.path,
    name: f.name,
    ageDays: ageDaysFor(app, f.path, null),
  }));

  const journalFiles = directChildFiles(app, settings.journalFolder)
    .filter((f) => f.extension === "md")
    .map((f) => {
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      return { path: f.path, name: f.name, ingested: fm?.ingested === true };
    });

  const healthTasks: HealthTaskInput[] = tasks.map((t) => {
    const file = app.vault.getAbstractFileByPath(t.path);
    const fm =
      file instanceof TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const declaredStatus = fm?.status ? "" + fm.status : null;
    return {
      path: t.path,
      title: t.title,
      status: t.status,
      declaredStatus,
      project: t.project,
      ageDays: ageDaysFor(app, t.path, t.updated),
    };
  });

  const unresolvedLinks: { source: string; target: string; count: number }[] = [];
  const raw = app.metadataCache.unresolvedLinks || {};
  for (const source of Object.keys(raw)) {
    const targets = raw[source] || {};
    for (const target of Object.keys(targets)) {
      const count = targets[target];
      if (count > 0) unresolvedLinks.push({ source, target, count });
    }
  }

  return {
    intakeFiles,
    journalFiles,
    tasks: healthTasks,
    projectSlugs: projects.map((p) => p.slug),
    unresolvedLinks,
    linkCheckExcludes: parseExcludeList(settings.linkCheckExcludes),
    thresholds: {
      intakeWarnDays: settings.intakeWarnDays,
      inProgressStaleDays: settings.inProgressStaleDays,
      openStaleDays: settings.openStaleDays,
    },
  };
}

// Lists the offending files for one health tile; click a row to open it. When
// actions are enabled and we are on desktop, the footer also offers a "Fix
// with Dispatch" button (launches Claude Code with the tile's canned prompt)
// and a "Copy prompt" button (clipboard, works everywhere).
class HealthDetailModal extends Modal {
  private tile: HealthTile;
  private settings: AiosDashboardSettings;

  constructor(app: App, tile: HealthTile, settings: AiosDashboardSettings) {
    super(app);
    this.tile = tile;
    this.settings = settings;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("aios-modal");
    contentEl.createEl("h3", { text: this.tile.label });

    // Actions sit ABOVE the list so they never scroll out of reach on long tiles.
    const actions = contentEl.createDiv({ cls: "aios-modal-footer aios-modal-actions" });
    if (this.settings.actionsEnabled && Platform.isDesktop) {
      const fixBtn = actions.createEl("button", {
        cls: "aios-btn aios-btn-cta",
        text: "Fix with Dispatch",
      });
      fixBtn.addEventListener("click", () => {
        const base = getVaultBasePath(this.app);
        if (!base) return;
        launchDispatch(this.settings, base, this.tile.prompt);
        this.close();
      });
    }
    const copyBtn = actions.createEl("button", { cls: "aios-btn", text: "Copy prompt" });
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.tile.prompt);
        new Notice("AIOS: prompt copied.");
      } catch (e) {
        new Notice("AIOS: could not copy prompt. " + (e?.message || e));
      }
    });

    const list = contentEl.createDiv({ cls: "aios-health-modal-list" });
    for (const item of this.tile.items) {
      const row = list.createDiv({ cls: "aios-health-modal-row" });
      const link = row.createEl("a", { cls: "aios-health-modal-link", text: item.label });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.app.workspace.openLinkText(item.path, "", false);
        this.close();
      });
      row.createSpan({ cls: "aios-health-modal-detail", text: item.detail });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// One row of small pills at the top of the dashboard. Tiles with a zero count
// are omitted by computeHealth already, so an all-healthy vault renders no
// strip at all. Click a tile to see the offending files.
function renderHealthStrip(
  app: App,
  root: HTMLElement,
  tiles: HealthTile[],
  settings: AiosDashboardSettings
) {
  if (tiles.length === 0) return;
  const strip = root.createDiv({ cls: "aios-health-strip" });
  for (const tile of tiles) {
    const pill = strip.createEl("button", {
      cls: "aios-health-tile" + (tile.warn ? " aios-health-tile-warn" : ""),
    });
    pill.createSpan({ cls: "aios-health-tile-label", text: tile.label });
    pill.createSpan({ cls: "aios-health-tile-count", text: tile.summary });
    pill.addEventListener("click", () => new HealthDetailModal(app, tile, settings).open());
  }
}

// ---------------------------------------------------------------------------
// Usage tab: gather (impure, async) + render.
// ---------------------------------------------------------------------------

// Reads and defensively parses usage-stats.json off the vault adapter. Returns
// null on any failure (missing file, malformed JSON, unexpected shape) so the
// caller can fall back to the "no usage data yet" hint instead of throwing.
async function loadUsageStats(app: App, statsPath: string): Promise<UsageStats | null> {
  try {
    const exists = await app.vault.adapter.exists(statsPath);
    if (!exists) return null;
    const raw = await app.vault.adapter.read(statsPath);
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.days) || !Array.isArray(parsed.projects)) return null;
    return parsed as UsageStats;
  } catch {
    return null;
  }
}

function renderUsageTiles(container: HTMLElement, view: UsageView) {
  const row = container.createDiv({ cls: "aios-usage-tiles" });
  const mk = (label: string, value: string) => {
    const tile = row.createDiv({ cls: "aios-health-tile aios-usage-tile" });
    tile.createSpan({ cls: "aios-health-tile-label", text: label });
    tile.createSpan({ cls: "aios-health-tile-count", text: value });
  };
  mk("Today", formatUsd(view.tiles.todayCostUsd));
  mk("Last 7 days", formatUsd(view.tiles.last7DaysCostUsd));
  mk("Last 30 days", formatUsd(view.tiles.last30DaysCostUsd));
  mk("Output tokens (30d)", view.tiles.last30DaysOutputTokensCompact);
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// "YYYY-MM-DD: $X.XX (fable $a, opus $b, ...)" tooltip text for a chart bar.
function usageDayTooltip(day: UsageChartDay): string {
  const parts = day.segments.map((s) => `${s.family} $${s.costUsd.toFixed(2)}`).join(", ");
  return `${day.date}: ${formatUsd(day.totalCostUsd)}` + (parts ? ` (${parts})` : "");
}

// Inline SVG stacked bar chart: one bar per day (always 30, see computeUsageView),
// segments stacked by model family. Built with DOM APIs, width 100% via viewBox.
function renderUsageChart(container: HTMLElement, chart: UsageChart) {
  const wrap = container.createDiv({ cls: "aios-usage-chart-wrap" });
  const width = 600;
  const height = 160;
  const marginLeft = 44;
  const marginBottom = 16;
  const plotWidth = width - marginLeft - 4;
  const plotHeight = height - marginBottom - 6;
  const baselineY = height - marginBottom;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "160" });
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "Daily API-equivalent cost over the last 30 days, stacked by model family"
  );
  svg.classList.add("aios-usage-svg");

  // Y gridlines + $ labels.
  for (const g of chart.gridlines) {
    const y = baselineY - g.fraction * plotHeight;
    const line = svgEl("line", {
      x1: String(marginLeft),
      x2: String(width - 4),
      y1: String(y),
      y2: String(y),
      class: "aios-usage-gridline",
    });
    svg.appendChild(line);
    const label = svgEl("text", {
      x: String(marginLeft - 6),
      y: String(y + 3),
      class: "aios-usage-axis-label",
      "text-anchor": "end",
    });
    label.textContent = g.label;
    svg.appendChild(label);
  }

  // Stacked bars.
  const n = chart.days.length || 1;
  const slot = plotWidth / n;
  const barWidth = Math.max(1, slot * 0.7);
  chart.days.forEach((day, i) => {
    const x = marginLeft + i * slot + (slot - barWidth) / 2;
    const g = svgEl("g", { class: "aios-usage-bar-group" });
    const title = svgEl("title", {});
    title.textContent = usageDayTooltip(day);
    g.appendChild(title);

    let yCursor = baselineY;
    for (const seg of day.segments) {
      const segHeight = Math.max(0, seg.heightFraction * plotHeight);
      const y = yCursor - segHeight;
      const rect = svgEl("rect", {
        x: String(x),
        y: String(y),
        width: String(barWidth),
        height: String(segHeight),
        class: "aios-usage-bar aios-usage-bar-" + seg.family,
      });
      g.appendChild(rect);
      yCursor = y;
    }
    if (day.segments.length === 0) {
      // Invisible full-height hit target so empty days still show a tooltip on hover.
      const hit = svgEl("rect", {
        x: String(x),
        y: String(baselineY - 2),
        width: String(barWidth),
        height: "2",
        class: "aios-usage-bar-empty",
      });
      g.appendChild(hit);
    }
    svg.appendChild(g);
  });

  // Sparse X date labels (every 7th day).
  for (const idx of chart.xLabelIndices) {
    const day = chart.days[idx];
    if (!day) continue;
    const x = marginLeft + idx * slot + slot / 2;
    const label = svgEl("text", {
      x: String(x),
      y: String(height - 2),
      class: "aios-usage-axis-label",
      "text-anchor": "middle",
    });
    label.textContent = day.date.slice(5); // MM-DD
    svg.appendChild(label);
  }

  wrap.appendChild(svg);
}

function renderUsageLegend(container: HTMLElement, legend: UsageLegendItem[]) {
  const row = container.createDiv({ cls: "aios-usage-legend" });
  for (const item of legend) {
    const pill = row.createDiv({ cls: "aios-usage-legend-item" });
    pill.createSpan({ cls: "aios-usage-dot aios-usage-dot-" + item.family });
    pill.createSpan({ cls: "aios-usage-legend-label", text: item.label });
    pill.createSpan({ cls: "aios-usage-legend-cost", text: formatUsd(item.costUsd) });
  }
}

function renderUsageTable(container: HTMLElement, table: UsageTableRow[]) {
  if (table.length === 0) {
    container.createDiv({ cls: "aios-empty", text: "No model usage in the last 30 days." });
    return;
  }
  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", { cls: "aios-usage-table" });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of ["Model", "Messages", "Input", "Output", "Cache read", "Est. cost"]) {
    headRow.createEl("th", { text: h });
  }
  const tbody = el.createEl("tbody");
  for (const row of table) {
    const tr = tbody.createEl("tr");
    const nameCell = tr.createEl("td", { cls: "aios-usage-table-name" });
    nameCell.createSpan({ cls: "aios-usage-dot aios-usage-dot-" + row.family });
    nameCell.createSpan({ text: " " + row.label });
    tr.createEl("td", { text: String(row.messages) });
    tr.createEl("td", { text: formatCompactNumber(row.inputTokens) });
    tr.createEl("td", { text: formatCompactNumber(row.outputTokens) });
    tr.createEl("td", { text: formatCompactNumber(row.cacheReadTokens) });
    tr.createEl("td", { text: formatUsd(row.costUsd) });
  }
}

function renderUsageProjectsTable(container: HTMLElement, projects: UsageProjectRow[]) {
  if (projects.length === 0) return;
  container.createDiv({ cls: "aios-usage-subhead", text: "Top projects" });
  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", { cls: "aios-usage-table" });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of ["Project", "Cost", "Output tokens"]) headRow.createEl("th", { text: h });
  const tbody = el.createEl("tbody");
  for (const p of projects) {
    const tr = tbody.createEl("tr");
    tr.createEl("td", { text: p.name });
    tr.createEl("td", { text: formatUsd(p.costUsd) });
    tr.createEl("td", { text: formatCompactNumber(p.outputTokens) });
  }
}

// Workflow share bar: single horizontal 100%-stacked bar, one segment per
// workflow by costUsd share, plus a small legend (label + $) below it.
function renderUsageWorkflowShareBar(container: HTMLElement, shareBar: UsageWorkflowShareRow[]) {
  const bar = container.createDiv({ cls: "aios-usage-workflow-bar" });
  for (const seg of shareBar) {
    if (seg.sharePercent <= 0) continue;
    const segEl = bar.createDiv({
      cls: "aios-usage-workflow-segment aios-workflow-color-" + seg.colorIndex,
    });
    segEl.style.width = seg.sharePercent + "%";
    segEl.setAttribute("title", `${seg.label}: ${formatUsd(seg.costUsd)}`);
  }

  const legend = container.createDiv({ cls: "aios-usage-legend aios-usage-workflow-legend" });
  for (const seg of shareBar) {
    const pill = legend.createDiv({ cls: "aios-usage-legend-item" });
    pill.createSpan({ cls: "aios-usage-dot aios-workflow-color-" + seg.colorIndex });
    pill.createSpan({ cls: "aios-usage-legend-label", text: seg.label });
    pill.createSpan({ cls: "aios-usage-legend-cost", text: formatUsd(seg.costUsd) });
  }
}

function renderUsageWorkflowTable(container: HTMLElement, table: UsageWorkflowTableRow[]) {
  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", { cls: "aios-usage-table" });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of ["Workflow", "Cost", "Output tokens", "Msgs", "Sessions"]) {
    headRow.createEl("th", { text: h });
  }
  const tbody = el.createEl("tbody");
  for (const row of table) {
    const tr = tbody.createEl("tr");
    const nameCell = tr.createEl("td", { cls: "aios-usage-table-name" });
    nameCell.createSpan({ cls: "aios-usage-dot aios-workflow-color-" + row.colorIndex });
    nameCell.createSpan({ text: " " + row.label });
    tr.createEl("td", { text: formatUsd(row.costUsd) });
    tr.createEl("td", { text: formatCompactNumber(row.outputTokens) });
    tr.createEl("td", { text: String(row.messages) });
    tr.createEl("td", { text: String(row.sessions) });
  }
}

// Missing `workflows` field (old JSON) or an empty window renders nothing at
// all -- no section header, no error.
function renderUsageWorkflowsSection(container: HTMLElement, view: UsageWorkflowsView) {
  if (!view.hasData) return;
  container.createDiv({ cls: "aios-usage-subhead", text: "Workflows (30d)" });
  renderUsageWorkflowShareBar(container, view.shareBar);
  renderUsageWorkflowTable(container, view.table);
}

function renderUsageView(container: HTMLElement, view: UsageView, workflowsView: UsageWorkflowsView) {
  renderUsageTiles(container, view);
  renderUsageChart(container, view.chart);
  renderUsageLegend(container, view.legend);
  container.createDiv({ cls: "aios-usage-subhead", text: "Model breakdown (30d)" });
  renderUsageTable(container, view.table);
  renderUsageWorkflowsSection(container, workflowsView);
  renderUsageProjectsTable(container, view.projects);
  container.createDiv({
    cls: "aios-foot",
    text: "API-equivalent value at standard rates; subscription billing differs.",
  });
}

// Usage tab: async load + render. Renders a hint when the exporter has not
// run yet (no usage-stats.json at settings.usageStatsPath).
function renderUsageTab(app: App, container: HTMLElement, settings: AiosDashboardSettings) {
  const wrap = container.createDiv({ cls: "aios-usage-tab" });
  wrap.createDiv({ cls: "aios-empty", text: "Loading usage data..." });
  loadUsageStats(app, settings.usageStatsPath).then((stats) => {
    wrap.empty();
    if (!stats) {
      wrap.createDiv({
        cls: "aios-empty",
        text:
          "No usage data yet. The exporter runs at session start, or run: node Operations/scripts/export-usage-stats.mjs",
      });
      return;
    }
    const view = computeUsageView(stats, new Date());
    const workflowsView = computeWorkflowsView(stats);
    renderUsageView(wrap, view, workflowsView);
  });
}

function renderDashboard(
  app: App,
  root: HTMLElement,
  refresh: () => void,
  viewState: ViewState,
  settings: AiosDashboardSettings,
  sourcePath?: string
) {
  root.empty();
  root.addClass("aios-dashboard-root");

  // Resolve config from the host note's frontmatter (config-driven per fork). No sourcePath
  // (standalone view or refresh re-render) falls back to the configured dashboard note.
  const hostFile = app.vault.getAbstractFileByPath(sourcePath ?? settings.dashboardNote);
  const hostFm =
    hostFile instanceof TFile
      ? (app.metadataCache.getFileCache(hostFile)?.frontmatter as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const buckets = resolveBuckets(hostFm);

  const tasks = readTasks(app, settings.tasksRoot);
  const projects = readProjects(app, settings.projectsRoot);
  const openTasks = tasks.filter((t) => OPEN_STATUSES.includes(t.status));

  // ----- Header -----
  const header = root.createDiv({ cls: "aios-header" });
  header.createEl("h1", { text: settings.headerTitle });
  const stat = header.createDiv({ cls: "aios-stat" });
  const activeCount = projects.filter((p) => p.status === "active").length;
  stat.setText(`${openTasks.length} open · ${activeCount} active`);
  const refreshBtn = header.createEl("button", { cls: "aios-refresh", text: "Refresh" });
  refreshBtn.addEventListener("click", () => refresh());

  if (settings.actionsEnabled && Platform.isDesktop) {
    const askBtn = header.createEl("button", {
      cls: "aios-refresh aios-ask-dispatch",
      text: "Ask Dispatch",
    });
    askBtn.addEventListener("click", () => {
      const base = getVaultBasePath(app);
      if (!base) return;
      launchDispatch(settings, base, null);
    });
  }

  // ----- Health strip -----
  if (settings.showHealthStrip) {
    const healthInput = gatherHealthInput(app, settings, tasks, projects);
    const tiles = computeHealth(healthInput);
    renderHealthStrip(app, root, tiles, settings);
  }

  // ----- Tab bar -----
  const tabs = root.createDiv({ cls: "aios-tabs" });
  const mkTab = (id: "projects" | "tasks" | "usage", label: string) => {
    const t = tabs.createEl("button", {
      cls: "aios-tab" + (viewState.activeTab === id ? " aios-tab-active" : ""),
      text: label,
    });
    t.addEventListener("click", () => {
      viewState.activeTab = id;
      refresh();
    });
  };
  mkTab("projects", "Projects");
  mkTab("tasks", "Tasks");
  mkTab("usage", "Usage");

  // ----- Tab body -----
  const body = root.createDiv({ cls: "aios-tab-body" });
  if (viewState.activeTab === "tasks") {
    renderTasksTab(app, settings.tasksRoot, body, tasks, buckets, viewState, refresh);
  } else if (viewState.activeTab === "usage") {
    renderUsageTab(app, body, settings);
  } else {
    renderProjectsTab(app, settings.tasksRoot, body, projects, tasks, viewState, refresh, hostFm);
  }

  root.createDiv({ cls: "aios-foot" }).setText(
    "Live view, computed from Operations/tasks and Projects. Progress bars are calculated from task completion - nothing is hand-entered."
  );
}

// ---------------------------------------------------------------------------
// The dashboard view
// ---------------------------------------------------------------------------

class DashboardView extends ItemView {
  private viewState: ViewState = makeViewState();
  private plugin: AiosDashboardPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: AiosDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AIOS Dashboard";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen() {
    this.render();
  }

  render() {
    const container = this.containerEl.children[1] as HTMLElement;
    renderDashboard(this.app, container, () => this.render(), this.viewState, this.plugin.settings);
  }

  async onClose() {
    /* nothing to clean up */
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class AiosDashboardSettingTab extends PluginSettingTab {
  plugin: AiosDashboardPlugin;

  constructor(app: App, plugin: AiosDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AIOS Dashboard" });

    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshNow();
    };

    new Setting(containerEl)
      .setName("Tasks root")
      .setDesc("Folder that holds tsk-*.md task files (relative to the vault root).")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.tasksRoot)
          .setValue(this.plugin.settings.tasksRoot)
          .onChange(async (v) => {
            this.plugin.settings.tasksRoot = v.trim() || DEFAULT_SETTINGS.tasksRoot;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Projects root")
      .setDesc("Folder that holds project hubs at <root>/<slug>/<slug>.md.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.projectsRoot)
          .setValue(this.plugin.settings.projectsRoot)
          .onChange(async (v) => {
            this.plugin.settings.projectsRoot = v.trim() || DEFAULT_SETTINGS.projectsRoot;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Dashboard note")
      .setDesc("Note whose frontmatter supplies dashboard_buckets / dashboard_project_statuses when no host note is given.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.dashboardNote)
          .setValue(this.plugin.settings.dashboardNote)
          .onChange(async (v) => {
            this.plugin.settings.dashboardNote = v.trim() || DEFAULT_SETTINGS.dashboardNote;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Header title")
      .setDesc("Text shown in the dashboard header.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.headerTitle)
          .setValue(this.plugin.settings.headerTitle)
          .onChange(async (v) => {
            this.plugin.settings.headerTitle = v.trim() || DEFAULT_SETTINGS.headerTitle;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Intake folder")
      .setDesc("Folder scanned for the intake-backlog health tile.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.intakeFolder)
          .setValue(this.plugin.settings.intakeFolder)
          .onChange(async (v) => {
            this.plugin.settings.intakeFolder = v.trim() || DEFAULT_SETTINGS.intakeFolder;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Journal folder")
      .setDesc("Folder scanned for the un-mined journal health tile (frontmatter ingested: false).")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.journalFolder)
          .setValue(this.plugin.settings.journalFolder)
          .onChange(async (v) => {
            this.plugin.settings.journalFolder = v.trim() || DEFAULT_SETTINGS.journalFolder;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Show health strip")
      .setDesc("Show the health tiles at the top of the dashboard. Off by user choice hides it entirely.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.showHealthStrip).onChange(async (v) => {
          this.plugin.settings.showHealthStrip = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Intake warn days")
      .setDesc("Warn styling when the oldest intake file is older than this many days.")
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.intakeWarnDays))
          .setValue(String(this.plugin.settings.intakeWarnDays))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.intakeWarnDays = isNaN(n) ? DEFAULT_SETTINGS.intakeWarnDays : n;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("In-progress stale days")
      .setDesc("A task counts as stale in-progress once it has not been updated for this many days.")
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.inProgressStaleDays))
          .setValue(String(this.plugin.settings.inProgressStaleDays))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.inProgressStaleDays = isNaN(n)
              ? DEFAULT_SETTINGS.inProgressStaleDays
              : n;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Open stale days")
      .setDesc("A task counts as stale open once it has not been updated for this many days.")
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.openStaleDays))
          .setValue(String(this.plugin.settings.openStaleDays))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.openStaleDays = isNaN(n) ? DEFAULT_SETTINGS.openStaleDays : n;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Broken-link check excludes")
      .setDesc("Comma-separated path prefixes to exclude from the broken-links health tile.")
      .addTextArea((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.linkCheckExcludes)
          .setValue(this.plugin.settings.linkCheckExcludes)
          .onChange(async (v) => {
            this.plugin.settings.linkCheckExcludes = v;
            await save();
          })
      );

    containerEl.createEl("h2", { text: "Usage" });

    new Setting(containerEl)
      .setName("Usage stats path")
      .setDesc(
        "Vault-relative path to the exporter's usage-stats.json (see node Operations/scripts/export-usage-stats.mjs)."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.usageStatsPath)
          .setValue(this.plugin.settings.usageStatsPath)
          .onChange(async (v) => {
            this.plugin.settings.usageStatsPath = v.trim() || DEFAULT_SETTINGS.usageStatsPath;
            await save();
          })
      );

    containerEl.createEl("h2", { text: "Actions" });

    if (!Platform.isDesktop) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "Dispatch launch actions are desktop-only and are hidden on this device.",
      });
      return;
    }

    new Setting(containerEl)
      .setName("Enable Dispatch actions")
      .setDesc(
        "Show the \"Ask Dispatch\" header button and the \"Fix with Dispatch\" button in health tile details. Desktop only."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.actionsEnabled).onChange(async (v) => {
          this.plugin.settings.actionsEnabled = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Launch mode")
      .setDesc("How Dispatch actions open Claude Code.")
      .addDropdown((d) =>
        d
          .addOption("terminal", "Terminal.app")
          .addOption("iterm", "iTerm2")
          .addOption("app", "IDE app (Antigravity, VS Code...)")
          .addOption("custom", "Custom command")
          .setValue(this.plugin.settings.launchMode)
          .onChange(async (v) => {
            this.plugin.settings.launchMode = v as "terminal" | "iterm" | "app" | "custom";
            await save();
          })
      );

    new Setting(containerEl)
      .setName("IDE app name")
      .setDesc(
        "macOS application opened by the IDE launch mode (open -a). The vault opens as the folder; the prompt is copied to the clipboard to paste into Claude inside the IDE."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.ideAppName)
          .setValue(this.plugin.settings.ideAppName)
          .onChange(async (v) => {
            this.plugin.settings.ideAppName = v.trim() || DEFAULT_SETTINGS.ideAppName;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("IDE: open vault folder")
      .setDesc(
        "Off (default): just bring the IDE's current window forward, where your Claude session already is. On: pass the vault path, which may open a new workspace window."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.ideOpenVaultFolder).onChange(async (v) => {
          this.plugin.settings.ideOpenVaultFolder = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("IDE: auto-start Claude session")
      .setDesc(
        "Opens a new integrated terminal in the IDE and runs the claude command with the prompt automatically. Requires macOS Accessibility permission for Obsidian (it types keystrokes). Uses the IDE's new-terminal shortcut Ctrl+Shift+`."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.ideAutoSession).onChange(async (v) => {
          this.plugin.settings.ideAutoSession = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("IDE: session target")
      .setDesc(
        "Where the auto-started session runs: a new integrated terminal running the claude CLI, or a new session in the Claude Code extension panel (driven via the command palette)."
      )
      .addDropdown((d) =>
        d
          .addOption("terminal", "Integrated terminal (claude CLI)")
          .addOption("extension", "Claude Code extension panel")
          .setValue(this.plugin.settings.ideSessionTarget)
          .onChange(async (v) => {
            this.plugin.settings.ideSessionTarget = v as "terminal" | "extension";
            await save();
          })
      );

    new Setting(containerEl)
      .setName("IDE: new-session palette command")
      .setDesc(
        "Exact command-palette entry used to open a fresh extension session. Check your IDE's palette (Cmd+Shift+P, type Claude) and copy the wording if it differs."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.ideNewSessionCommand)
          .setValue(this.plugin.settings.ideNewSessionCommand)
          .onChange(async (v) => {
            this.plugin.settings.ideNewSessionCommand = v.trim() || DEFAULT_SETTINGS.ideNewSessionCommand;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Custom command")
      .setDesc(
        "Shell command template used when launch mode is Custom. Use {vault} and {prompt} as placeholders, e.g. code {vault}"
      )
      .addText((t) =>
        t
          .setPlaceholder("code {vault}")
          .setValue(this.plugin.settings.customCommand)
          .onChange(async (v) => {
            this.plugin.settings.customCommand = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Claude binary")
      .setDesc("Binary name or absolute path used by the Terminal and iTerm2 launch modes.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.claudeBinary)
          .setValue(this.plugin.settings.claudeBinary)
          .onChange(async (v) => {
            this.plugin.settings.claudeBinary = v.trim() || DEFAULT_SETTINGS.claudeBinary;
            await save();
          })
      );
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class AiosDashboardPlugin extends Plugin {
  settings: AiosDashboardSettings = DEFAULT_SETTINGS;
  private inlineHosts: Set<HTMLElement> = new Set();
  private inlineState: WeakMap<HTMLElement, ViewState> = new WeakMap();
  private refreshTimer: number | null = null;

  private stateFor(host: HTMLElement): ViewState {
    let s = this.inlineState.get(host);
    if (!s) {
      s = makeViewState();
      this.inlineState.set(host, s);
    }
    return s;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Public hook for the settings tab: force an immediate re-render (no debounce)
  // so field changes are visible right away.
  refreshNow() {
    this.refreshAll();
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AiosDashboardSettingTab(this.app, this));

    this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "Open AIOS Dashboard", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-aios-dashboard",
      name: "Open AIOS Dashboard",
      callback: () => this.activateView(),
    });

    // Inline rendering inside Projects/Dashboard.md
    this.registerMarkdownCodeBlockProcessor("aios-dashboard", (_src, el, ctx) => {
      const host = el.createDiv();
      this.inlineHosts.add(host);
      renderDashboard(
        this.app,
        host,
        () => this.scheduleRefresh(),
        this.stateFor(host),
        this.settings,
        ctx.sourcePath
      );
      this.register(() => this.inlineHosts.delete(host));
    });

    // Live refresh: re-render when the vault or metadata changes.
    const onChange = () => this.scheduleRefresh();
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.metadataCache.on("changed", onChange));
    this.registerEvent(this.app.metadataCache.on("resolved", onChange));
  }

  onunload() {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.inlineHosts.clear();
  }

  private scheduleRefresh() {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refreshAll(), 200);
  }

  private refreshAll() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof DashboardView) view.render();
    }
    for (const host of Array.from(this.inlineHosts)) {
      if (!host.isConnected) {
        this.inlineHosts.delete(host);
        continue;
      }
      renderDashboard(this.app, host, () => this.scheduleRefresh(), this.stateFor(host), this.settings);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
