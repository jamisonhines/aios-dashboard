import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Scope,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import {
  resolveBuckets,
  resolveStatusSections,
  groupProjectsByStatus,
  compareProjectsByName,
  orderProjects,
  statusChipsFromGroups,
  splitProjectTasks,
  categoryChipsFromTasks,
  tagForTask,
  filterStandaloneByCategory,
  sortTasks,
  visiblePhaseTasks,
  computeHealth,
  computeIncidents,
  formatCompactNumber,
  computeUsageView,
  computeOpsMapLayout,
  OPS_MAP_DEFAULTS,
  buildLaunchCommand,
  computeAutomationView,
  topTasks,
  intakeBacklogCount,
  automationSummaryText,
  quickCaptureFileStem,
  resolveCaptureFileName,
  buildQuickCaptureContent,
  budgetGuardrail,
  computeUsageWindow,
  usageChartFromWindow,
  usageDayFamilyBars,
  computeWorkflowSpikes,
  computeSpendSparkline,
  usageFamilyBreakdown,
  computeUsageRangeTiles,
  computeWorkflowsViewForRange,
  computeSkillsViewForRange,
  usageScopedRangeLabel,
  computeSystemSkillsView,
  systemSkillsGroupIsOpen,
  computeSystemAgentsView,
  computeAvailableHiresView,
  computeSystemWorkflowsSopsView,
  pushUndoEntry,
  popUndoEntry,
  undoEntryStillSafe,
  mutationNoticeText,
  undoNoticeText,
  undoConflictNoticeText,
  undoEmptyNoticeText,
  undoCollisionNoticeText,
  isEditableEventTarget,
  taskStatusActionLabel,
  computeCoordinationView,
  isCoordinationQuestionAnswered,
  filterCoordinationQuestions,
  coordinationQuestionFilterCounts,
  spliceAnswer,
} from "./model.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIEW_TYPE = "aios-dashboard";

// Project hub status sections. Rendered top-to-bottom in THIS fixed order; each
// section is collapsible and empty sections are not rendered at all. `open` is the
// default expand state (active work expanded, the done/archived graveyard collapsed).
// A module default that resolveStatusSections() (model.mjs) can override from
// frontmatter, so a fork tunes labels/order/defaults as data, not code
// (fork-playbook: variation is data).
interface StatusSection {
  slug: string;
  label: string;
  open: boolean;
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
  incidentsFolder: string; // vault-relative folder of Operations/incidents/INC-*.md notes
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
  opsMapPath: string; // vault-relative path to the exporter's ops-map.json
  automationHealthPath: string; // vault-relative path to the exporter's automation-health.json
  dailyBudgetUsd: number; // spend guardrail; 0 = off
  // Manual project drag order (owner feedback 2026-08-30: "I would like to
  // be able to drag projects up and down"). One global array of slugs,
  // most-recently-dropped-into-place first per the drag gesture; applies
  // wherever a slug's status group renders (model.mjs's orderProjects). In
  // settings, not viewState: must survive Obsidian restarts, unlike every
  // other per-view UI-only state in ViewState.
  projectOrder: string[];
}

const DEFAULT_SETTINGS: AiosDashboardSettings = {
  tasksRoot: "Operations/tasks",
  projectsRoot: "Projects",
  dashboardNote: "Projects/Dashboard.md",
  headerTitle: "AIOS",
  intakeFolder: "Intake",
  journalFolder: "Wiki/Journal",
  incidentsFolder: "Operations/incidents",
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
  opsMapPath: "Operations/ops-map.json",
  automationHealthPath: "Operations/usage/automation-health.json",
  dailyBudgetUsd: 0,
  projectOrder: [],
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
  created: string | null;
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
  activeTab: "today" | "projects" | "tasks" | "usage" | "opsmap" | "system";
  activeStatus: string | null; // null = first non-empty status group
  activeCategory: string; // "all" | bucket slug | "inbox"
  expanded: Set<string>; // keys of expanded project cards and phase cards
  openOff: Set<string>; // project slugs whose Open toggle is OFF (default: Open ON)
  completeOn: Set<string>; // project slugs whose Complete toggle is ON (default: Complete OFF)
  usageRange: "1d" | "7d" | "30d" | "all"; // Usage chart window length (build 2.8; "all" added Phase 1 System-browser)
  usageOffset: number; // windows back from the one ending today (0 = current)
  systemsOpen: boolean; // right-side systems drawer visibility (build 2.8)
  // System tab: Skills section (build 2026-08-04). Filter text and which
  // generic-suite groups are expanded persist across re-renders, same
  // pattern as `expanded` above for project/phase cards.
  systemSkillsFilter: string;
  systemSkillsExpandedGroups: Set<string>;
  // System tab sub-tabs (2026-08): which second-level section is showing.
  // Persists across re-renders like activeTab does for the primary nav.
  systemActiveSubTab: "agents" | "skills" | "workflows";
  // Coordination panel (GL-011, Projects tab -- moved off Today 2026-08-29):
  // half-typed answer drafts, keyed "<projectSlug>::<questionId>",
  // surviving the 200ms debounced live re-render (see
  // renderCoordinationQuestion/captureCoordinationFocus).
  // Cleared per-key on a successful save.
  coordinationDrafts: Map<string, string>;
  // OPEN QUESTIONS filter chip (owner feedback 2026-08-30), keyed per
  // project slug so two participating projects can hold different filters
  // at once. Absent key defaults to "unanswered" (see
  // renderCoordinationBody) -- "the things I need" is the default view,
  // not a blank/unset state that has to be distinguished from it.
  coordinationQuestionFilter: Map<string, CoordinationQuestionFilter>;
  // Scroll position (owner feedback 2026-08-30: "when i click on a tab it
  // changes the scroll position, so i want it to stay where i am currently
  // scrolled"), keyed by main tab. Written continuously by a passive scroll
  // listener on .aios-scroll (renderDashboard) as the user scrolls, so the
  // map always holds the last-known position for the CURRENTLY active tab
  // independent of what triggers the next re-render (tab click, a filter/
  // status chip, a toggle, or the 200ms live-vault-change refresh). Read
  // once at the end of renderDashboard's synchronous render to restore the
  // newly active tab's saved position (0 when absent).
  scrollTops: Map<string, number>;
}

// Today is the default tab on every fresh render (new ViewState instance).
// Once the user switches tabs this session, activeTab holds their choice and
// stays that way across live re-renders (same ViewState instance persists).
function makeViewState(): ViewState {
  return {
    activeTab: "today",
    activeStatus: null,
    activeCategory: "all",
    expanded: new Set(),
    openOff: new Set(),
    completeOn: new Set(),
    usageRange: "7d",
    usageOffset: 0,
    systemsOpen: false,
    systemSkillsFilter: "",
    systemSkillsExpandedGroups: new Set(),
    systemActiveSubTab: "agents",
    coordinationDrafts: new Map(),
    coordinationQuestionFilter: new Map(),
    scrollTops: new Map(),
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
      created: isNull(fm.created) ? null : "" + fm.created,
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

// ---------------------------------------------------------------------------
// Coordination panel (GL-011): a project is "participating" when
// <projectsRoot>/<slug>/work-ledger.md exists. This is a synchronous
// vault-index check (no file content read), so the caller can decide
// "render nothing at all" before any I/O -- no empty-section flash while
// content loads. Sorted alphabetically for a stable card order independent
// of directory-listing order.
// ---------------------------------------------------------------------------
function participatingProjectSlugs(app: App, projectsRoot: string): string[] {
  const root = app.vault.getAbstractFileByPath(normalizePath(projectsRoot));
  if (!(root instanceof TFolder)) return [];
  const slugs: string[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const ledgerPath = normalizePath(`${projectsRoot}/${child.name}/work-ledger.md`);
    if (app.vault.getAbstractFileByPath(ledgerPath) instanceof TFile) slugs.push(child.name);
  }
  return slugs.sort((a, b) => a.localeCompare(b));
}

// The impure gather half (mirrors loadOpsMap's gather-then-render split):
// vault.cachedRead of each participating project's work-ledger.md and
// questions.md, handed as plain strings to computeCoordinationView (pure,
// model.mjs). questions.md missing or unreadable degrades to null content
// (the model turns that into zero questions), never an error -- same
// optional-data pattern as automation-health.json/usage-stats.json.
async function gatherCoordinationInputs(
  app: App,
  projectsRoot: string,
  slugs: string[]
): Promise<{ slug: string; ledgerContent: string; questionsContent: string | null }[]> {
  const out: { slug: string; ledgerContent: string; questionsContent: string | null }[] = [];
  for (const slug of slugs) {
    const ledgerFile = app.vault.getAbstractFileByPath(
      normalizePath(`${projectsRoot}/${slug}/work-ledger.md`)
    );
    let ledgerContent = "";
    if (ledgerFile instanceof TFile) {
      try {
        ledgerContent = await app.vault.cachedRead(ledgerFile);
      } catch {
        ledgerContent = "";
      }
    }
    const questionsFile = app.vault.getAbstractFileByPath(
      normalizePath(`${projectsRoot}/${slug}/questions.md`)
    );
    let questionsContent: string | null = null;
    if (questionsFile instanceof TFile) {
      try {
        questionsContent = await app.vault.cachedRead(questionsFile);
      } catch {
        questionsContent = null;
      }
    }
    out.push({ slug, ledgerContent, questionsContent });
  }
  return out;
}

// Write-back for one question's answer: read-mutate-write, exactly the
// setTaskStatus pattern (read contentBefore, compute new content with a pure
// function, write, return the before/after pair so the caller can record an
// undo entry). Returns null -- and fires a Notice, never a write -- when
// questions.md cannot be found or spliceAnswer cannot locate the question or
// its Answer line (a stale card: the question was filed/removed since this
// render loaded).
async function saveCoordinationAnswer(
  app: App,
  projectsRoot: string,
  slug: string,
  qid: string,
  text: string
): Promise<{ path: string; contentBefore: string; contentAfter: string } | null> {
  const path = `${projectsRoot}/${slug}/questions.md`;
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) {
    new Notice("AIOS: could not find " + path);
    return null;
  }
  const contentBefore = await app.vault.read(file);
  const contentAfter = spliceAnswer(contentBefore, qid, text, isoDate());
  if (contentAfter == null) {
    new Notice(`AIOS: could not locate ${qid}'s Answer line in ${path}`);
    return null;
  }
  await app.vault.modify(file, contentAfter);
  return { path: file.path, contentBefore, contentAfter };
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

// ---------------------------------------------------------------------------
// View-model helpers (pure: no Obsidian deps; unit-tested in viewModel.test.mjs.
// groupProjectsByStatus, statusChipsFromGroups, splitProjectTasks,
// categoryChipsFromTasks, tagForTask, filterStandaloneByCategory now live in
// model.mjs, imported above.)
// ---------------------------------------------------------------------------

interface Chip {
  slug: string;
  label: string;
  count: number;
}

interface SplitTasks {
  doing: TaskItem[];
  open: TaskItem[];
  done: TaskItem[];
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

// Canned Dispatch prompt per health-tile key (HEALTH_TILE_PROMPTS) now lives in
// model.mjs, keyed by HealthTile.key (the internal computeHealth id, not the
// UI label). stale-in-progress and stale-open share the same reconcile prompt;
// orphan-tasks and status-mismatch share the same consistency-fix prompt.

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

// healthInferStatusFromPath, excludedBySource, and computeHealth now live in
// model.mjs, imported above (kept as a standalone pure unit, matching the
// pattern of the other MIRRORED functions in the test suite).

// ---------------------------------------------------------------------------
// Usage model (pure: no Obsidian deps; unit-tested in usageModel.test.mjs).
// renderUsageTab (below, in the Renderers section) is the impure half that
// reads usage-stats.json off disk and turns it into this plain-data shape.
// computeUsageView, computeWorkflowsView, formatCompactNumber, and their
// supporting constants/helpers now live in model.mjs, imported above.
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

interface UsageWorkflowDayStat {
  costUsd: number;
  outputTokens: number;
  messages: number;
  // Optional: absent in JSON written before Phase 1 (2026-08-04). Powers the
  // range-scoped "Runs" column (computeWorkflowsViewForRange).
  sessions?: number;
}

interface UsageWorkflowStat {
  key: string;
  label: string;
  costUsd: number;
  outputTokens: number;
  messages: number;
  sessions: number;
  // Optional: absent in JSON written before build 2.9 slice 2. Powers the
  // spike-alert computation (computeWorkflowSpikes); the workflows table
  // itself doesn't need it.
  byDay?: Record<string, UsageWorkflowDayStat>;
}

interface WorkflowSpikeAlert {
  key: string;
  label: string;
  // model.mjs (plain JS) returns "new" | "spike" in practice; typed as
  // string here (not a literal union) because TS infers the return type of
  // computeWorkflowSpikes from an untyped array literal, which widens to
  // string -- see the `a.kind === "new"` check below for the actual switch.
  kind: string;
  recentCostUsd: number;
  recentSharePercent: number;
  baselineSharePercent: number;
}

interface UsageSkillDayStat {
  costUsd: number;
  outputTokens: number;
  messages: number;
  runs: number;
}

// Per-invocation skill spend: one entry per slash-command/skill, aggregated
// over its runs (a run = marker -> next human message, subagents included).
interface UsageSkillStat {
  key: string;
  label: string;
  costUsd: number;
  outputTokens: number;
  messages: number;
  runs: number;
  avgCostUsd: number;
  // Optional: absent in JSON written before Phase 1 (2026-08-04). When
  // present on EVERY skill, powers range-scoped recompute
  // (computeSkillsViewForRange); when any skill lacks it the whole section
  // falls back to all-time totals rather than mixing scoped and unscoped
  // rows in one table.
  byDay?: Record<string, UsageSkillDayStat>;
}

interface UsageStats {
  generatedAt: string;
  windowDays: number;
  days: UsageDay[];
  projects: UsageProjectStat[];
  // Optional: absent in JSON written before build 2.5. The Usage tab hides
  // the workflows section entirely when this is missing.
  workflows?: UsageWorkflowStat[];
  // Optional: absent in JSON written before build 2.9. Same hide-when-missing
  // rule as workflows.
  skills?: UsageSkillStat[];
  // Optional: absent in JSON written before Phase 3 (System-browser Agents
  // section, 2026-08-05). Keyed by the host-level subagent type (e.g.
  // "coder", "general-purpose") -- NOT yet mapped onto the AIOS roster; the
  // System tab's Agents section does that join by matching this `key`
  // against ops-map.json's agent node ids. Same byDay shape as skills, for
  // the same future range-toggle reason.
  agents?: UsageSkillStat[];
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
  sharePercent: number;
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

// computeUsageView, computeWorkflowsView, formatCompactNumber, the family
// order/labels, and the workflow color mapping now live in model.mjs,
// imported above.

function formatUsd(n: number): string {
  return "$" + n.toFixed(2);
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
  // true when this workflow had no per-day breakdown to scope by range, so
  // the row shows its all-time total regardless of the selected range
  // (computeWorkflowsViewForRange). Absent on the fixed all-time
  // computeWorkflowsView output.
  partial?: boolean;
  // true when cost/tokens/messages ARE range-scoped but the Runs (sessions)
  // column specifically fell back to the all-time total, because this
  // workflow's byDay has no per-day session counts (Reviewer M3, 2026-08-04
  // -- exactly the shape of JSON written before this same Phase 1 slice).
  sessionsPartial?: boolean;
}

interface UsageSkillsView {
  hasData: boolean;
  rows: UsageSkillStat[];
  hiddenCount: number;
  expanded: boolean;
  totalCount: number;
  // true when every skill in the exported set had `byDay` data, so the rows
  // are genuinely scoped to the selected range. false means the section
  // fell back to all-time totals (computeSkillsViewForRange only).
  rangeSupported?: boolean;
}

interface UsageWorkflowsView {
  hasData: boolean;
  shareBar: UsageWorkflowShareRow[];
  table: UsageWorkflowTableRow[];
}

// Range-scoped spend/tokens tiles (Phase 1 System-browser range toggle,
// 2026-08-04): replaces the old fixed Today/7d/30d tile set.
interface UsageRangeTiles {
  rangeLabel: string;
  costUsd: number;
  outputTokens: number;
  outputTokensCompact: string;
}

// ---------------------------------------------------------------------------
// Ops map model (pure: no Obsidian deps; unit-tested in opsMapModel.test.mjs).
// Reads Operations/ops-map.json (written by export-ops-map.mjs) and lays out
// a deterministic 5-column graph: Agents, Workflows, SOPs, Guidelines, Skills.
// ---------------------------------------------------------------------------

type OpsMapNodeType = "agent" | "workflow" | "sop" | "guideline" | "skill";

interface OpsMapNode {
  id: string;
  type: OpsMapNodeType;
  label: string;
  description?: string;
  path: string;
  external?: boolean;
  registered?: boolean; // skill listed in Operations/skill-registry.md
  // Skill-only fields (System tab Skills section, build 2026-08-04):
  hasDescription?: boolean; // false when the SKILL.md had no frontmatter description (rendered description is then the "(no description)" fallback)
  disableModelInvocation?: boolean; // SKILL.md frontmatter `disable-model-invocation: true`
  usedBy?: string[]; // node ids with an edge -> this skill (denormalized by export-ops-map.mjs)
  origin?: "skills-dir" | "plugin" | "command"; // where the skill was discovered (Reviewer M3, 2026-08-04)
  // Agent-only field (System-browser Agents section, Phase 3, 2026-08-05):
  // the shim's `model:` frontmatter line. Absent (not empty string) for a
  // shim written before that convention existed.
  model?: string;
}

interface OpsMapEdge {
  from: string;
  to: string;
  viaType: string;
}

// "Available hires" (System-browser Agents section, Phase 3, 2026-08-05):
// parsed from SOP-001's "Reference pattern" section when present. See
// parseAvailableHires' own comment (export-ops-map.mjs) for why found:false
// is the honest, current-file-accurate outcome, not a bug.
interface OpsMapAvailableHireItem {
  label: string;
  description: string;
}

interface OpsMapAvailableHires {
  found: boolean;
  items: OpsMapAvailableHireItem[];
  sopId: string;
  sopPath: string;
}

interface OpsMapManifest {
  generatedAt?: string;
  nodes: OpsMapNode[];
  edges: OpsMapEdge[];
  availableHires?: OpsMapAvailableHires;
}

interface OpsMapLayoutOpts {
  columnWidth?: number;
  rowHeight?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  paddingX?: number;
  paddingY?: number;
}

interface OpsMapPositionedNode {
  id: string;
  type: OpsMapNodeType | "skill-summary";
  label: string;
  description?: string;
  path?: string;
  external?: boolean;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  // Only set on the collapsed "+N unreferenced skills" summary node.
  collapsedNames?: string[];
}

interface OpsMapColumnHeader {
  type: OpsMapNodeType;
  label: string;
  count: number;
  x: number;
}

interface OpsMapResolvedEdge {
  from: string;
  to: string;
  viaType: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface OpsMapLayout {
  columns: OpsMapColumnHeader[];
  nodes: OpsMapPositionedNode[];
  edges: OpsMapResolvedEdge[];
  width: number;
  height: number;
}

// computeOpsMapLayout and its constants (OPS_MAP_COLUMNS, OPS_MAP_DEFAULTS,
// OPS_MAP_SKILL_SUMMARY_ID) now live in model.mjs, imported above.
// Deterministic: no randomness, no wall-clock.

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

// ---------------------------------------------------------------------------
// Dashboard undo: in-memory history of the PLUGIN'S OWN vault mutations
// (task status writes + moves, quick-add task creation, quick capture).
// Stack push/pop/cap/safety logic is pure (model.mjs, undoModel.test.mjs);
// everything below is the impure wiring: how a mutation gets recorded, and
// how it gets reversed.
//
// The stack lives on the PLUGIN instance (`plugin.undoStack`), not a
// per-view WeakMap: one history, vault-wide, valid across every open
// dashboard surface (the ItemView leaf AND any inline `aios-dashboard`
// code-block embeds in notes -- Reviewer flagged that a per-root stack left
// the embed's mutation toast promising an undo it could never deliver,
// since embeds have no Scope/keymap of their own). It's still purely
// in-memory: nothing is persisted, and it resets on plugin reload/unload
// (`onunload` also clears it explicitly, see below) -- undo is a
// same-session convenience, not a durable log.
//
// Cmd+Z is wired ONLY through DashboardView.scope, so it only ever fires
// while the dashboard leaf is focused. Every mutation toast additionally
// gets a clickable "Undo" link (Notice supports a DocumentFragment body)
// that calls the exact same undoLastMutation path -- that link works from
// every surface, including embeds, with no keymap involved. The toast TEXT
// only claims "Cmd+Z to undo" when the mutation happened inside the leaf
// view; embeds get the link only, never a promise they can't keep.
// ---------------------------------------------------------------------------

type UndoEntry = {
  id: string;
  label: string;
  kind: "edit-move" | "create";
  pathAfter: string;
  contentAfter: string;
  pathBefore?: string;
  contentBefore?: string;
};

// Threaded through the render tree (alongside app/settings/refresh) to every
// function that can trigger a plugin mutation, so recordMutation always
// knows which plugin-wide stack to push onto and whether this particular
// render is the Cmd+Z-capable leaf view or a keymap-less inline embed.
type UndoCtx = {
  plugin: AiosDashboardPlugin;
  isLeafView: boolean;
};

function undoEntryId(): string {
  return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Record a mutation the plugin just performed: push it onto the plugin's
// shared stack and toast it with a clickable Undo action. `isLeafView`
// controls only whether the toast TEXT mentions the Cmd+Z shortcut (true
// for the ItemView leaf, false for inline embeds) -- the Undo link itself
// always works regardless.
function recordMutation(plugin: AiosDashboardPlugin, isLeafView: boolean, entry: UndoEntry): void {
  plugin.undoStack = pushUndoEntry(plugin.undoStack, entry);
  const frag = document.createDocumentFragment();
  frag.createSpan({ text: mutationNoticeText(entry, isLeafView) + " " });
  const undoLink = frag.createEl("a", { cls: "aios-undo-link", text: "Undo", attr: { href: "#" } });
  undoLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    void undoLastMutation(plugin);
  });
  new Notice(frag, 8000);
}

// Undo the most recent mutation on the plugin's shared stack. Always
// refreshes every open dashboard surface (Min1: refresh on every path,
// including refusals) so the UI reflects reality regardless of outcome.
//
// - Tamper refusal (file changed on disk since the mutation): the entry is
//   dropped, per spec -- retrying would still clobber the concurrent edit.
// - A thrown failure or a detected path collision on the move-back is
//   treated as a transient obstruction, not tamper: the entry goes BACK on
//   the stack so the same Undo click/Cmd+Z can retry once it clears.
async function undoLastMutation(plugin: AiosDashboardPlugin): Promise<void> {
  const app = plugin.app;
  const { entry, stack: rest } = popUndoEntry(plugin.undoStack);
  plugin.undoStack = rest;

  if (!entry) {
    new Notice(undoEmptyNoticeText());
    plugin.refreshNow();
    return;
  }

  const file = app.vault.getAbstractFileByPath(entry.pathAfter);
  if (!(file instanceof TFile)) {
    new Notice(undoConflictNoticeText());
    plugin.refreshNow();
    return;
  }

  const current = await app.vault.read(file);
  if (!undoEntryStillSafe(entry, current)) {
    new Notice(undoConflictNoticeText());
    plugin.refreshNow();
    return;
  }

  try {
    if (entry.kind === "create") {
      // Respect the user's trash setting (system trash / .trash / permanent)
      // instead of a hard delete.
      await app.fileManager.trashFile(file);
    } else {
      const pathBefore = entry.pathBefore;
      const movingBack = !!pathBefore && pathBefore !== entry.pathAfter;
      if (movingBack && app.vault.getAbstractFileByPath(pathBefore!)) {
        new Notice(undoCollisionNoticeText(pathBefore!));
        plugin.undoStack = pushUndoEntry(plugin.undoStack, entry); // retryable once it clears
        plugin.refreshNow();
        return;
      }
      // Restore content FIRST, then move back. If the rename then fails,
      // roll the content restore back too, so a partial failure can never
      // leave e.g. a done-status file's content sitting under open/ (path
      // and content always change together, or not at all).
      await app.vault.modify(file, entry.contentBefore ?? current);
      if (movingBack) {
        try {
          await app.fileManager.renameFile(file, pathBefore!);
        } catch (renameErr) {
          try {
            await app.vault.modify(file, entry.contentAfter);
          } catch {
            /* best-effort rollback; the outer catch still reports the original failure */
          }
          throw renameErr;
        }
      }
    }
    new Notice(undoNoticeText(entry));
  } catch (e) {
    new Notice("AIOS: could not undo. " + (e?.message || e));
    plugin.undoStack = pushUndoEntry(plugin.undoStack, entry); // retryable
  }
  plugin.refreshNow();
}

// Set a task's status, stamp `updated`, and move the file to the folder that
// mirrors the new status (per the AIOS task lifecycle, SOP-close-task).
// Returns the before/after path + content pair so the caller can record an
// undo entry, or null when the file could not be found (nothing happened).
async function setTaskStatus(
  app: App,
  tasksRoot: string,
  path: string,
  newStatus: string
): Promise<{ pathBefore: string; pathAfter: string; contentBefore: string; contentAfter: string } | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice("AIOS: task file not found: " + path);
    return null;
  }
  const pathBefore = file.path;
  const contentBefore = await app.vault.read(file);
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
  const contentAfter = await app.vault.read(file);
  return { pathBefore, pathAfter: file.path, contentBefore, contentAfter };
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

// Returns the created file's path + exact content on success (so the caller
// can record an undo entry), or null when there was nothing to create or
// the write failed.
async function createQuickTask(
  app: App,
  tasksRoot: string,
  opts: { title: string; project: string | null; phase: string | null; keyElement: string | null }
): Promise<{ path: string; content: string } | null> {
  const title = opts.title.trim();
  if (!title) return null;
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
    return { path, content };
  } catch (e) {
    new Notice("AIOS: could not create task. " + (e?.message || e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Launch Dispatch: build a launch command (pure, unit-tested in
// launchModel.test.mjs; buildLaunchCommand and its quoting helpers now live
// in model.mjs, imported above) and run it (impure, desktop-only).
// ---------------------------------------------------------------------------

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

// sortTasks and visiblePhaseTasks now live in model.mjs, imported above
// (unit-tested in viewModel.test.mjs).

// setIcon with a fallback lucide name for icons that may not exist in older
// Obsidian bundles (e.g. chart-column / waypoints). Falls back silently if
// the primary icon renders no SVG.
function setIconWithFallback(el: HTMLElement, primary: string, fallback?: string) {
  setIcon(el, primary);
  if (fallback && !el.querySelector("svg")) setIcon(el, fallback);
}

// A chevron indicator for collapsible card heads: rotates 90deg via CSS when
// the parent card carries .aios-expanded (see styles.css).
function renderChevron(container: HTMLElement): HTMLElement {
  const el = container.createSpan({ cls: "aios-chevron" });
  setIcon(el, "chevron-right");
  return el;
}

// Centered empty-state: a faint icon + one line of copy (spec build 2.7).
function renderEmptyState(container: HTMLElement, text: string): HTMLElement {
  const wrap = container.createDiv({ cls: "aios-empty" });
  const icon = wrap.createDiv({ cls: "aios-empty-icon" });
  setIcon(icon, "inbox");
  wrap.createDiv({ cls: "aios-empty-text", text });
  return wrap;
}

// A progress bar: the signature gradient revealed up to pct, done color at 100%,
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
// Replaces the v1 checkbox + Start button. Every transition calls setTaskStatus, records
// a dashboard undo entry, and shows a toast ("... Cmd+Z to undo"). Deliberate menu
// selection means no single mis-tap can complete or lose a task, and the generic
// Cmd+Z/undo-stack (see recordMutation/undoLastMutation) covers every transition
// uniformly instead of a per-notice "back to prior status" link.
function renderStatusDropdown(
  app: App,
  tasksRoot: string,
  row: HTMLElement,
  task: TaskItem,
  refresh: () => void,
  undoCtx: UndoCtx
) {
  const meta = statusCtlMeta(task.status);
  const btn = row.createEl("button", { cls: "aios-status-ctl " + meta.cls });
  btn.createSpan({ cls: "aios-ctl-dot" });
  btn.createSpan({ cls: "aios-ctl-label", text: meta.label });
  btn.createSpan({ cls: "aios-ctl-caret", text: "▾" });
  btn.setAttr("aria-label", "Change task status");

  const apply = async (newStatus: string, verb: string) => {
    const result = await setTaskStatus(app, tasksRoot, task.path, newStatus);
    if (result) {
      recordMutation(undoCtx.plugin, undoCtx.isLeafView, {
        id: undoEntryId(),
        label: taskStatusActionLabel(verb, task.title),
        kind: "edit-move",
        pathBefore: result.pathBefore,
        pathAfter: result.pathAfter,
        contentBefore: result.contentBefore,
        contentAfter: result.contentAfter,
      });
    }
    refresh();
  };

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const menu = new Menu();
    if (task.status === "open") {
      menu.addItem((i) =>
        i.setTitle("Start (in progress)").setIcon("play").onClick(() => apply("in-progress", "Started"))
      );
      menu.addItem((i) => i.setTitle("Done").setIcon("check").onClick(() => apply("done", "Completed")));
      menu.addItem((i) =>
        i.setTitle("Cancel task").setIcon("x").onClick(() => apply("cancelled", "Cancelled"))
      );
    } else if (task.status === "in-progress") {
      menu.addItem((i) => i.setTitle("Done").setIcon("check").onClick(() => apply("done", "Completed")));
      menu.addItem((i) =>
        i.setTitle("Back to open").setIcon("rotate-ccw").onClick(() => apply("open", "Reopened"))
      );
      menu.addItem((i) =>
        i.setTitle("Cancel task").setIcon("x").onClick(() => apply("cancelled", "Cancelled"))
      );
    } else {
      // done or any other terminal state: allow reopening.
      menu.addItem((i) =>
        i.setTitle("Reopen").setIcon("rotate-ccw").onClick(() => apply("open", "Reopened"))
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
  undoCtx: UndoCtx,
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

  renderStatusDropdown(app, tasksRoot, row, task, refresh, undoCtx);
}

// Doing-now strip: in-progress tasks pinned in an accented block, sorted by
// the shared sortTasks order. Shared by the per-project card (build 2.5) and
// the Today tab (build 2.6 m3), which passes the full in-progress list
// across every project instead of one project's split.doing.
function renderDoingNowStrip(
  app: App,
  tasksRoot: string,
  container: HTMLElement,
  doingTasks: TaskItem[],
  refresh: () => void,
  undoCtx: UndoCtx
) {
  if (doingTasks.length === 0) return;
  const strip = container.createDiv({ cls: "aios-doing" });
  strip.createDiv({ cls: "aios-doing-label", text: "DOING NOW" });
  const list = strip.createDiv({ cls: "aios-list" });
  for (const t of doingTasks.slice().sort(sortTasks)) renderTaskRow(app, tasksRoot, list, t, refresh, undoCtx);
}

function addButton(
  container: HTMLElement,
  app: App,
  tasksRoot: string,
  contextLabel: string,
  project: string | null,
  phase: string | null,
  keyElement: string | null,
  refresh: () => void,
  undoCtx: UndoCtx
) {
  const btn = container.createEl("button", { cls: "aios-add", text: "+ Add task" });
  btn.addEventListener("click", () => {
    // Project/phase adds do not offer a category picker (buckets = []).
    new AddTaskModal(app, contextLabel, [], async (title, _category) => {
      const created = await createQuickTask(app, tasksRoot, { title, project, phase, keyElement });
      if (created) {
        recordMutation(undoCtx.plugin, undoCtx.isLeafView, {
          id: undoEntryId(),
          label: `Added task "${title}"`,
          kind: "create",
          pathAfter: created.path,
          contentAfter: created.content,
        });
      }
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

// Drag-to-reorder (owner feedback 2026-08-30). Bundles the drag session's
// transient state (which slug is currently being dragged) and the drop
// callback into one object so renderProjectCard doesn't need three more
// positional params. Lives entirely in renderProjectsTab's closure for one
// render pass -- never in viewState, because a drag gesture cannot span a
// re-render (native HTML5 drag-and-drop holds the browser's own event
// sequence; nothing calls renderDashboard again mid-drag), so there is
// nothing here that needs to survive one.
interface ProjectDragCtx {
  getDraggingSlug: () => string | null;
  setDraggingSlug: (slug: string | null) => void;
  onDrop: (draggedSlug: string, targetSlug: string, position: "before" | "after") => void;
}

function renderProjectCard(
  app: App,
  tasksRoot: string,
  section: HTMLElement,
  proj: ProjectItem,
  allTasks: TaskItem[],
  viewState: ViewState,
  refresh: () => void,
  undoCtx: UndoCtx,
  isCoordParticipant: boolean,
  dragCtx: ProjectDragCtx | null
): CoordinationCardHosts | null {
  // All non-cancelled tasks for this project (drives progress + display).
  const projTasks = allTasks.filter(
    (t) => t.project === proj.slug && t.status !== "cancelled"
  );

  const card = section.createDiv({ cls: "aios-card aios-proj-card" });
  const expandKey = "proj:" + proj.slug;
  if (viewState.expanded.has(expandKey)) card.addClass("aios-expanded");

  // Collapsed head: [drag handle] chevron + name (+ open-note) on the left,
  // overall bar on the right.
  const head = card.createDiv({ cls: "aios-card-head aios-proj-head" });
  const left = head.createDiv({ cls: "aios-head-left" });

  // Drag-to-reorder handle (owner feedback 2026-08-30: "I would like to be
  // able to drag projects up and down"). Dedicated grip icon, not the whole
  // head, so dragging can never fight the head's own click-to-expand
  // listener below -- same stopPropagation discipline as the open-note
  // icon and the Open/Complete toggles. draggable=true is scoped to JUST
  // this element (never an ancestor), which is what makes the rest of the
  // card -- including head's click-to-expand -- completely unaffected by
  // it: native HTML5 drag only initiates from an element that is itself
  // draggable=true or has a draggable=true ANCESTOR, and this has no
  // draggable ancestor. Absent entirely when dragCtx is null (mobile:
  // native HTML5 drag-and-drop does not work reliably with touch, so the
  // whole feature is Platform.isDesktop-gated in renderProjectsTab rather
  // than shipping a grip icon that silently does nothing on tap).
  if (dragCtx) {
    const grip = left.createDiv({ cls: "aios-proj-drag-handle" });
    setIcon(grip, "grip-vertical");
    grip.setAttr("aria-label", "Drag to reorder");
    grip.setAttr("draggable", "true");
    grip.addEventListener("click", (ev) => ev.stopPropagation());
    grip.addEventListener("dragstart", (ev) => {
      dragCtx.setDraggingSlug(proj.slug);
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", proj.slug);
        // Drag image is the WHOLE card, not just the small grip icon --
        // setDragImage needs an offset; roughly centering it under the
        // cursor's likely grab point (the handle) is close enough, this is
        // a visual nicety, not something users will pixel-measure.
        ev.dataTransfer.setDragImage(card, 20, 20);
      }
      card.addClass("aios-proj-card-dragging");
    });
    grip.addEventListener("dragend", () => {
      dragCtx.setDraggingSlug(null);
      card.removeClass("aios-proj-card-dragging");
      card.removeClass("aios-proj-card-drop-before");
      card.removeClass("aios-proj-card-drop-after");
    });

    // Drop target handling lives on the CARD (not the handle): while
    // dragging, the mouse can be anywhere over another card, not just its
    // handle. clientY vs. the card's own vertical midpoint decides
    // before/after, redrawn on every dragover so the insertion line tracks
    // the cursor.
    card.addEventListener("dragover", (ev) => {
      const draggingSlug = dragCtx.getDraggingSlug();
      if (!draggingSlug || draggingSlug === proj.slug) return;
      ev.preventDefault(); // required for a "drop" event to fire at all
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      card.toggleClass("aios-proj-card-drop-before", before);
      card.toggleClass("aios-proj-card-drop-after", !before);
    });
    card.addEventListener("dragleave", () => {
      card.removeClass("aios-proj-card-drop-before");
      card.removeClass("aios-proj-card-drop-after");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const draggedSlug = ev.dataTransfer?.getData("text/plain") || dragCtx.getDraggingSlug();
      card.removeClass("aios-proj-card-drop-before");
      card.removeClass("aios-proj-card-drop-after");
      if (!draggedSlug || draggedSlug === proj.slug) return;
      const rect = card.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      dragCtx.onDrop(draggedSlug, proj.slug, before ? "before" : "after");
    });
  }

  renderChevron(left);
  const nameBlock = left.createDiv({ cls: "aios-name-block" });
  const nameRow = nameBlock.createDiv({ cls: "aios-name-row" });
  nameRow.createSpan({ cls: "aios-card-title", text: proj.name });
  const open = nameRow.createSpan({ cls: "aios-open-note" });
  setIcon(open, "arrow-up-right");
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
  // Coordination at-a-glance pills (GL-011), only for a participating
  // project: N active / M unlanded / Q questions + a stale-claim warning
  // pill when applicable. Placeholder created empty; filled in once the
  // async gather in renderProjectsTab resolves.
  let pillsHost: HTMLElement | null = null;
  if (isCoordParticipant) {
    pillsHost = right.createDiv({ cls: "aios-coord-pills" });
  }
  renderProjectToggles(right, proj, viewState, refresh);

  head.addEventListener("click", () => {
    const nowExpanded = card.classList.toggle("aios-expanded");
    if (nowExpanded) viewState.expanded.add(expandKey);
    else viewState.expanded.delete(expandKey);
    // Any coordination answer textarea that was sized while this card's
    // body was still display:none measured scrollHeight 0 (the CSS
    // min-height floor is what kept it from rendering as a sliver). Now
    // that the card is actually visible, re-measure so a long prefilled
    // answer grows to its real height instead of sitting at the floor.
    // No-op for a non-participating card (querySelectorAll finds nothing)
    // and safe to re-run even if the async coordination fill already sized
    // these correctly (autoGrowCoordinationTextarea is a pure
    // measure-and-set off the textarea's own current value).
    if (nowExpanded && isCoordParticipant) {
      card.querySelectorAll<HTMLTextAreaElement>(".aios-coord-answer-input").forEach((el) => {
        autoGrowCoordinationTextarea(el);
      });
    }
  });

  // Collapsible body.
  const body = card.createDiv({ cls: "aios-card-body" });

  // Coordination content (GL-011), relocated here from its own Today-tab
  // section (owner feedback 2026-08-29: "this should live in the project
  // not the today tab"). Sits at the TOP of the body, above even the
  // doing-now strip. Placeholder created empty; filled in by
  // renderProjectsTab once the async ledger/questions gather resolves.
  let bodyHost: HTMLElement | null = null;
  if (isCoordParticipant) {
    bodyHost = body.createDiv({ cls: "aios-coord-inline" });
  }

  const split = splitProjectTasks(projTasks);

  // Doing now strip: in-progress tasks pinned at the top with an accent.
  renderDoingNowStrip(app, tasksRoot, body, split.doing, refresh, undoCtx);

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
    renderChevron(pleft);
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
      renderEmptyState(list, "No tasks match the current view.");
    } else {
      for (const t of visible) renderTaskRow(app, tasksRoot, list, t, refresh, undoCtx);
    }
    addButton(pbody, app, tasksRoot, addCtxLabel, proj.slug, phaseName, null, refresh, undoCtx);
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

  return pillsHost && bodyHost ? { pillsHost, bodyHost } : null;
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
  hostFm: Record<string, unknown> | undefined,
  undoCtx: UndoCtx,
  settings: AiosDashboardSettings,
  coordFocus: CoordinationFocusCapture | null
) {
  const statusSections = resolveStatusSections(hostFm);
  const groups = groupProjectsByStatus(projects, statusSections);

  if (groups.length === 0) {
    renderEmptyState(container, "No projects yet.");
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

  // Manual drag order (owner feedback 2026-08-30: "I would like to be able
  // to drag projects up and down... OPS app is towards the bottome now but
  // its the main project i am working on"). group.projects arrives
  // alphabetical (groupProjectsByStatus's own default); orderProjects
  // layers settings.projectOrder on top -- listed slugs first in their
  // saved sequence, everything else falling back to that same alphabetical
  // order it already had. Dispatch ruling: manual order only, no
  // activity-based auto-ordering.
  const orderedGroupProjects = orderProjects(group.projects, settings.projectOrder) as ProjectItem[];

  // Drag-to-reorder wiring, Platform.isDesktop-gated (native HTML5
  // drag-and-drop does not behave reliably with touch input, so mobile
  // gets no grip icon at all rather than one that silently does nothing).
  // draggingSlug is this render pass's own transient closure state -- see
  // ProjectDragCtx's comment for why it never needs to be viewState.
  let draggingSlug: string | null = null;
  const dragCtx: ProjectDragCtx | null = Platform.isDesktop
    ? {
        getDraggingSlug: () => draggingSlug,
        setDraggingSlug: (slug) => {
          draggingSlug = slug;
        },
        onDrop: (draggedSlug, targetSlug, position) => {
          if (draggedSlug === targetSlug) return;
          // Baseline order: EVERY current project (not just this group),
          // sorted the exact same way groupProjectsByStatus would with no
          // custom order at all (compareProjectsByName), then
          // settings.projectOrder layered on top. Building the splice
          // target from this alphabetical baseline -- not projects' own
          // raw read-from-disk order -- means the very first drag ever
          // made only moves the two projects actually involved; every
          // other project's relative position stays exactly what was
          // already on screen, rather than silently freezing the whole
          // list into filesystem order as a side effect of one drag.
          const baseline = projects.slice().sort(compareProjectsByName);
          const currentOrder = orderProjects(baseline, settings.projectOrder).map((p) => p.slug);
          const from = currentOrder.indexOf(draggedSlug);
          if (from === -1) return;
          currentOrder.splice(from, 1);
          let to = currentOrder.indexOf(targetSlug);
          if (to === -1) return;
          if (position === "after") to += 1;
          currentOrder.splice(to, 0, draggedSlug);
          settings.projectOrder = currentOrder;
          // Persisted via the plugin's own settings machinery (saveData),
          // same as every other setting -- survives Obsidian restarts,
          // unlike viewState. refresh() after the write so the new order
          // renders; Change 1's scroll-position fix means this drop does
          // not also jump the list back to the top.
          void undoCtx.plugin.saveSettings().then(() => refresh());
        },
      }
    : null;

  // Coordination panel (GL-011), relocated from the Today tab (owner
  // feedback 2026-08-29: "this should live in the project not the today
  // tab"). A participating project (Projects/<slug>/work-ledger.md exists)
  // gets a pills host in its card head plus a body host at the top of its
  // card body; both start empty. One batched gather covers every
  // participating card in the currently-visible status group, mirroring the
  // old Today-tab section's gather-then-render split (just fanned out to N
  // card hosts instead of one section body).
  const participatingSlugs = participatingProjectSlugs(app, settings.projectsRoot);
  const coordHosts = new Map<string, CoordinationCardHosts>();
  for (const proj of orderedGroupProjects) {
    const hosts = renderProjectCard(
      app,
      tasksRoot,
      container,
      proj,
      tasks,
      viewState,
      refresh,
      undoCtx,
      participatingSlugs.includes(proj.slug),
      dragCtx
    );
    if (hosts) coordHosts.set(proj.slug, hosts);
  }

  if (coordHosts.size > 0) {
    const slugs = Array.from(coordHosts.keys());
    gatherCoordinationInputs(app, settings.projectsRoot, slugs).then((inputs) => {
      const views: CoordinationProjectView[] = computeCoordinationView(inputs, new Date());
      for (const v of views) {
        const hosts = coordHosts.get(v.slug);
        if (!hosts) continue;
        renderCoordinationPills(hosts.pillsHost, v);
        renderCoordinationBody(app, settings, hosts.bodyHost, v, viewState, refresh, undoCtx);
      }
      restoreCoordinationFocus(container, coordFocus);
    });
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
  refresh: () => void,
  undoCtx: UndoCtx
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
      const created = await createQuickTask(app, tasksRoot, {
        title,
        project: null,
        phase: null,
        keyElement: categorySlug,
      });
      if (created) {
        recordMutation(undoCtx.plugin, undoCtx.isLeafView, {
          id: undoEntryId(),
          label: `Added task "${title}"`,
          kind: "create",
          pathAfter: created.path,
          contentAfter: created.content,
        });
      }
      refresh();
    }).open();
  });

  // Flat tagged list.
  const filtered = filterStandaloneByCategory(standaloneOpen, active, buckets).slice().sort(sortTasks);
  const list = container.createDiv({ cls: "aios-list aios-tasks-list" });
  if (filtered.length === 0) {
    renderEmptyState(list, "Nothing here.");
  } else {
    for (const t of filtered) renderTaskRow(app, tasksRoot, list, t, refresh, undoCtx, tagForTask(t, buckets));
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
    for (const t of done) renderTaskRow(app, tasksRoot, dlist, t, refresh, undoCtx, tagForTask(t, buckets));
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
  const section = root.createDiv({ cls: "aios-health-section" });
  section.createDiv({ cls: "aios-section-eyebrow", text: "Systems" });
  const strip = section.createDiv({ cls: "aios-health-strip" });
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
// Incidents strip: unattended overnight rollbacks, written to
// Operations/incidents/INC-*.md by Dispatch's incident-response mode. Pure
// view model (computeIncidents) lives in model.mjs, keyed only on
// `status: open`; this is the impure gather + render half. Renders nothing
// when there are zero open incidents (absence is the normal case), and sits
// ABOVE the rest of the dashboard, unlike the health strip which lives
// inside the Systems drawer -- an open incident is the single highest-
// priority thing on the page, not one more thing to click into.
// ---------------------------------------------------------------------------

interface IncidentRow {
  path: string;
  item: string;
  summary: string;
  property: string;
  ageDays: number;
  prompt: string;
}

// Reads direct-child .md files of the incidents folder and hands their raw
// (possibly malformed, possibly hand-edited) frontmatter to computeIncidents,
// which is defensive about every field. A missing incidents folder degrades
// to "no notes" (directChildFiles already returns [] for that), same pattern
// as intake/journal.
function gatherIncidents(app: App, settings: AiosDashboardSettings): IncidentRow[] {
  const files = directChildFiles(app, settings.incidentsFolder).filter(
    (f) => f.extension === "md"
  );
  const notes = files.map((f) => ({
    path: f.path,
    frontmatter: app.metadataCache.getFileCache(f)?.frontmatter,
  }));
  return computeIncidents({ notes, now: new Date() });
}

// Top-of-dashboard strip. Renders NOTHING (no wrapper element at all) when
// there are zero open incidents, so a healthy vault shows no trace of this
// feature. Each row: item / summary / property / age, plus "Work on this
// with Dispatch" (desktop + actionsEnabled only, same gate as every other
// launch button) and "Open note" (works everywhere).
function renderIncidentsStrip(
  app: App,
  root: HTMLElement,
  incidents: IncidentRow[],
  settings: AiosDashboardSettings
) {
  if (incidents.length === 0) return;
  const section = root.createDiv({ cls: "aios-incidents-section" });
  section.createDiv({ cls: "aios-incidents-eyebrow", text: "Urgent" });
  for (const inc of incidents) {
    const row = section.createDiv({ cls: "aios-incidents-row" });
    const main = row.createDiv({ cls: "aios-incidents-main" });
    const head = main.createDiv({ cls: "aios-incidents-head" });
    head.createSpan({ cls: "aios-incidents-item", text: inc.item });
    if (inc.property) head.createSpan({ cls: "aios-incidents-property", text: inc.property });
    head.createSpan({ cls: "aios-incidents-age", text: `${inc.ageDays}d ago` });
    if (inc.summary) main.createDiv({ cls: "aios-incidents-summary", text: inc.summary });

    const rowActions = row.createDiv({ cls: "aios-incidents-actions" });
    if (settings.actionsEnabled && Platform.isDesktop) {
      const fixBtn = rowActions.createEl("button", {
        cls: "aios-btn aios-btn-cta",
        text: "Work on this with Dispatch",
      });
      fixBtn.addEventListener("click", () => {
        const base = getVaultBasePath(app);
        if (!base) return;
        launchDispatch(settings, base, inc.prompt);
      });
    }
    const openBtn = rowActions.createEl("button", { cls: "aios-btn", text: "Open note" });
    openBtn.addEventListener("click", () => {
      app.workspace.openLinkText(inc.path, "", false);
    });
  }
}

// ---------------------------------------------------------------------------
// Automations strip: launchd job health, from automation-health.json (written
// by vault-scripts/export-automation-health.mjs at session start). Pure view
// model (computeAutomationView) lives in model.mjs; this is the impure half.
// ---------------------------------------------------------------------------

interface AutomationJob {
  label: string;
  schedule: string;
  lastActivity: string | null;
  lastExitStatus: number | null;
  pid: number | null;
  nextExpected: string | null;
  state: string;
  logPath: string | null;
}

interface AutomationHealth {
  generatedAt: string;
  jobs: AutomationJob[];
}

interface AutomationTile {
  label: string;
  shortLabel: string;
  state: string;
  stateLabel: string;
  relativeLastActivity: string;
  schedule: string;
  lastExitStatus: number | null;
  pid: number | null;
  nextExpected: string | null;
  nextExpectedRelative: string | null;
  logPath: string | null;
  prompt: string;
}

interface AutomationView {
  tiles: AutomationTile[];
  counts: Record<string, number>;
}

// Reads and defensively parses automation-health.json off the vault adapter.
// Returns null on any failure (missing file, malformed JSON, unexpected
// shape) so the caller hides the section entirely, matching the other
// optional data files.
async function loadAutomationHealth(
  app: App,
  healthPath: string
): Promise<AutomationHealth | null> {
  try {
    const exists = await app.vault.adapter.exists(healthPath);
    if (!exists) return null;
    const raw = await app.vault.adapter.read(healthPath);
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.jobs)) return null;
    return parsed as AutomationHealth;
  } catch {
    return null;
  }
}

// One expandable detail row shared by all tiles of the strip: clicking a tile
// populates and shows it (clicking the same tile again collapses it).
function renderAutomationDetail(
  app: App,
  detail: HTMLElement,
  tile: AutomationTile,
  settings: AiosDashboardSettings
) {
  detail.empty();
  const grid = detail.createDiv({ cls: "aios-auto-detail-grid" });
  const mkField = (label: string, value: string) => {
    const field = grid.createDiv({ cls: "aios-auto-detail-field" });
    field.createSpan({ cls: "aios-auto-detail-label", text: label });
    field.createSpan({ cls: "aios-auto-detail-value", text: value });
  };
  mkField("Job", tile.label);
  mkField("Schedule", tile.schedule);
  mkField("State", tile.stateLabel);
  mkField("Last exit", tile.lastExitStatus != null ? String(tile.lastExitStatus) : "unknown");
  mkField(
    "Next expected",
    tile.nextExpected
      ? `${tile.nextExpected.slice(0, 16).replace("T", " ")}${tile.nextExpectedRelative ? " (" + tile.nextExpectedRelative + ")" : ""}`
      : "n/a"
  );
  mkField("Log", tile.logPath || "none");

  const actions = detail.createDiv({ cls: "aios-modal-footer aios-modal-actions" });
  if (settings.actionsEnabled && Platform.isDesktop) {
    const fixBtn = actions.createEl("button", {
      cls: "aios-btn aios-btn-cta",
      text: "Fix with Dispatch",
    });
    fixBtn.addEventListener("click", () => {
      const base = getVaultBasePath(app);
      if (!base) return;
      launchDispatch(settings, base, tile.prompt);
    });
  }
  const copyBtn = actions.createEl("button", { cls: "aios-btn", text: "Copy prompt" });
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(tile.prompt);
      new Notice("AIOS: prompt copied.");
    } catch (e) {
      new Notice("AIOS: could not copy prompt. " + (e?.message || e));
    }
  });
}

// Automations section: async load + render. Hidden entirely (no elements)
// when automation-health.json is missing, same pattern as the other optional
// data files.
function renderAutomationSection(app: App, root: HTMLElement, settings: AiosDashboardSettings) {
  const section = root.createDiv({ cls: "aios-auto-section" });
  loadAutomationHealth(app, settings.automationHealthPath).then((health) => {
    if (!health) {
      section.remove();
      return;
    }
    const view: AutomationView = computeAutomationView(health, new Date());
    if (view.tiles.length === 0) {
      section.remove();
      return;
    }
    section.createDiv({ cls: "aios-auto-head", text: "Automations" });
    const strip = section.createDiv({ cls: "aios-health-strip aios-auto-strip" });
    const detail = section.createDiv({ cls: "aios-auto-detail" });
    detail.hide();
    let expandedLabel: string | null = null;
    for (const tile of view.tiles) {
      const pill = strip.createEl("button", {
        cls: "aios-health-tile aios-auto-tile aios-auto-tile-" + tile.state,
      });
      pill.createSpan({ cls: "aios-auto-tile-dot" });
      pill.createSpan({ cls: "aios-health-tile-label", text: tile.shortLabel });
      pill.createSpan({ cls: "aios-health-tile-count", text: tile.stateLabel });
      pill.createSpan({ cls: "aios-auto-tile-activity", text: tile.relativeLastActivity });
      pill.addEventListener("click", () => {
        if (expandedLabel === tile.label) {
          expandedLabel = null;
          detail.hide();
          return;
        }
        expandedLabel = tile.label;
        renderAutomationDetail(app, detail, tile, settings);
        detail.show();
      });
    }
  });
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

// Two tiles, both scoped to the selected range (Phase 1 System-browser range
// toggle, 2026-08-04): replaces the old fixed Today/7d/30d/Output-tokens-30d
// set. Every number on this pane now follows the same toggle, so the tiles
// never disagree with the chart/tables below them.
function renderUsageTiles(container: HTMLElement, tiles: UsageRangeTiles) {
  const row = container.createDiv({ cls: "aios-usage-tiles" });
  const mk = (label: string, value: string) => {
    const tile = row.createDiv({ cls: "aios-health-tile aios-usage-tile" });
    tile.createSpan({ cls: "aios-health-tile-label", text: label });
    tile.createSpan({ cls: "aios-health-tile-count", text: value });
  };
  mk("Spend (" + tiles.rangeLabel + ")", formatUsd(tiles.costUsd));
  mk("Output tokens (" + tiles.rangeLabel + ")", tiles.outputTokensCompact);
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

// Inline SVG stacked bar chart over an arbitrary day window, segments stacked
// by model family. The viewBox width comes from the measured container so the
// chart genuinely fills the pane (a fixed viewBox letterboxes at 600px).
function renderUsageChart(
  container: HTMLElement,
  chart: UsageChart,
  pixelWidth: number,
  ariaLabel: string
) {
  const wrap = container.createDiv({ cls: "aios-usage-chart-wrap" });
  const width = Math.max(320, pixelWidth);
  const height = 180;
  const marginLeft = 44;
  const marginBottom = 16;
  const plotWidth = width - marginLeft - 4;
  const plotHeight = height - marginBottom - 6;
  const baselineY = height - marginBottom;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "180" });
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", ariaLabel);
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

// Single-day view: one vertical bar per model family (wider bars, family
// names on the x axis). Data from usageDayFamilyBars (model.mjs, pure).
function renderUsageDayChart(
  container: HTMLElement,
  dayBars: {
    date: string;
    bars: { family: string; label: string; costUsd: number; fraction: number }[];
    gridlines: { fraction: number; label: string }[];
  },
  pixelWidth: number
) {
  const wrap = container.createDiv({ cls: "aios-usage-chart-wrap" });
  const width = Math.max(320, pixelWidth);
  const height = 180;
  const marginLeft = 44;
  const marginBottom = 16;
  const plotWidth = width - marginLeft - 4;
  const plotHeight = height - marginBottom - 6;
  const baselineY = height - marginBottom;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: "180" });
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `API-equivalent cost by model family on ${dayBars.date}`);
  svg.classList.add("aios-usage-svg");

  for (const g of dayBars.gridlines) {
    const y = baselineY - g.fraction * plotHeight;
    svg.appendChild(
      svgEl("line", {
        x1: String(marginLeft),
        x2: String(width - 4),
        y1: String(y),
        y2: String(y),
        class: "aios-usage-gridline",
      })
    );
    const label = svgEl("text", {
      x: String(marginLeft - 6),
      y: String(y + 3),
      class: "aios-usage-axis-label",
      "text-anchor": "end",
    });
    label.textContent = g.label;
    svg.appendChild(label);
  }

  const n = dayBars.bars.length || 1;
  const slot = plotWidth / n;
  const barWidth = Math.min(90, Math.max(24, slot * 0.5));
  dayBars.bars.forEach((bar, i) => {
    const x = marginLeft + i * slot + (slot - barWidth) / 2;
    const g = svgEl("g", { class: "aios-usage-bar-group" });
    const title = svgEl("title", {});
    title.textContent = `${bar.label}: ${formatUsd(bar.costUsd)}`;
    g.appendChild(title);
    const barHeight = Math.max(1, bar.fraction * plotHeight);
    g.appendChild(
      svgEl("rect", {
        x: String(x),
        y: String(baselineY - barHeight),
        width: String(barWidth),
        height: String(barHeight),
        class: "aios-usage-bar aios-usage-bar-" + bar.family,
      })
    );
    const label = svgEl("text", {
      x: String(x + barWidth / 2),
      y: String(height - 2),
      class: "aios-usage-axis-label",
      "text-anchor": "middle",
    });
    label.textContent = bar.label;
    g.appendChild(label);
    svg.appendChild(g);
  });
  if (dayBars.bars.length === 0) {
    const label = svgEl("text", {
      x: String(marginLeft + plotWidth / 2),
      y: String(baselineY - 8),
      class: "aios-usage-axis-label",
      "text-anchor": "middle",
    });
    label.textContent = "No usage recorded this day";
    svg.appendChild(label);
  }

  wrap.appendChild(svg);
}

// Range buttons (Phase 1 System-browser range toggle, 2026-08-04): 1D/7D/30D
// plus ALL, everything the exporter scanned. Order matches USAGE_RANGE_DAYS.
const USAGE_RANGE_OPTIONS = ["1d", "7d", "30d", "all"] as const;

// Period bar: range toggle + prev/next paging + the human period label
// ("Last 7 days") + the concrete date-range label ("Jul 8 - Jul 14"). Lives
// in .aios-chrome (header/tabs restructure, 2026-08) as a normal, non-
// scrolling flex child -- no CSS positioning trick needed, it stays visible
// for the same structural reason the tab bar above it does. `container` is
// the .aios-usage-periodbar element itself, a direct child of the chrome's
// usage-periodbar host (see renderUsageTab).
function renderUsagePeriodBar(
  container: HTMLElement,
  win: ReturnType<typeof computeUsageWindow>,
  viewState: ViewState,
  redraw: () => void
) {
  const head = container.createDiv({ cls: "aios-usage-periodbar-head" });
  // M4 (Reviewer, 2026-08-04): at offset 0 the human label ("Last 7 days")
  // is accurate; paged back, it isn't -- usageScopedRangeLabel falls back to
  // the concrete date range instead of claiming to be "Last 7 days" while
  // showing a week from three windows ago. When it does, the redundant
  // second date-range span below is skipped so the header doesn't repeat
  // the same text twice.
  const label = usageScopedRangeLabel(win);
  head.createSpan({ cls: "aios-usage-period-label", text: label });
  if (win.offset === 0) {
    const dateLabel = head.createSpan({ cls: "aios-usage-window-label", text: win.label });
    dateLabel.setAttr("aria-live", "polite");
  }

  const controls = container.createDiv({ cls: "aios-usage-controls" });
  const spacer = controls.createDiv({ cls: "aios-usage-controls-spacer" });
  void spacer;

  const seg = controls.createDiv({ cls: "aios-usage-range" });
  for (const r of USAGE_RANGE_OPTIONS) {
    const b = seg.createEl("button", {
      cls: "aios-usage-range-btn" + (viewState.usageRange === r ? " aios-usage-range-on" : ""),
      text: r.toUpperCase(),
    });
    // Reviewer n11 (2026-08-04): "All" isn't literally unbounded history --
    // it's everything the exporter's fixed scan window covers (currently
    // ~35 days; see export-usage-stats.mjs's WINDOW_DAYS comment for why
    // that's a fixed constant, not a wider live scan).
    if (r === "all") {
      b.setAttr("title", "Every day in the exporter's export window (currently ~35 days), not unbounded history");
    }
    b.addEventListener("click", () => {
      if (viewState.usageRange === r) return;
      viewState.usageRange = r;
      viewState.usageOffset = 0;
      redraw();
    });
  }

  const nav = controls.createDiv({ cls: "aios-usage-nav" });
  const prev = nav.createEl("button", { cls: "aios-icon-btn aios-usage-nav-btn" });
  prev.setAttr("aria-label", "Previous window");
  setIcon(prev, "chevron-left");
  prev.disabled = !win.canPrev;
  prev.addEventListener("click", () => {
    if (!win.canPrev) return;
    viewState.usageOffset += 1;
    redraw();
  });
  const next = nav.createEl("button", { cls: "aios-icon-btn aios-usage-nav-btn" });
  next.setAttr("aria-label", "Next window");
  setIcon(next, "chevron-right");
  next.disabled = !win.canNext;
  next.addEventListener("click", () => {
    if (!win.canNext) return;
    viewState.usageOffset -= 1;
    redraw();
  });
}

// The chart alone (no controls -- those live in the sticky header now).
// Re-measures its own width so the SVG genuinely fills the pane; called from
// the parent draw() both on range/paging changes and on pane resize.
function renderUsageChartHost(
  container: HTMLElement,
  win: ReturnType<typeof computeUsageWindow>,
  viewState: ViewState
) {
  const chartHost = container.createDiv({ cls: "aios-usage-chart-host" });
  const width = Math.floor(chartHost.getBoundingClientRect().width) || container.clientWidth || 600;
  if (viewState.usageRange === "1d") {
    renderUsageDayChart(chartHost, usageDayFamilyBars(win.days[0]), width);
  } else {
    renderUsageChart(
      chartHost,
      usageChartFromWindow(win.days),
      width,
      `Daily API-equivalent cost, ${win.label}, stacked by model family`
    );
  }
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

// Models breakdown table (header/tabs restructure, 2026-08, replaces the
// old bespoke Model breakdown table): shares the same breakdown-table
// helper/column-alignment as Workflows and Skills below it -- family, cost,
// share of this window's spend, output tokens, messages -- so all three
// tables' Cost/Output-tokens/Msgs columns line up at the same pixel
// position (USAGE_BREAKDOWN_TOTAL_COLUMNS padding, see that const's
// comment). Follows the selected range like every other section on this
// tab: `table` is already range-scoped by the caller (usageFamilyBreakdown
// over the selected window's days).
function renderUsageModelsTable(container: HTMLElement, table: UsageTableRow[]) {
  if (table.length === 0) {
    renderEmptyState(container, "No model usage in this period.");
    return;
  }
  renderUsageBreakdownTable(
    container,
    ["Model", "Cost", "Share", "Output tokens", "Msgs"],
    table.map((row) => ({
      nameText: " " + row.label,
      nameDotClass: "aios-usage-dot-" + row.family,
      cells: [
        formatUsd(row.costUsd),
        Math.round(row.sharePercent) + "%",
        formatCompactNumber(row.outputTokens),
        String(row.messages),
      ],
    }))
  );
}

function renderUsageProjectsTable(container: HTMLElement, projects: UsageProjectRow[]) {
  if (projects.length === 0) return;
  container.createDiv({ cls: "aios-usage-subhead", text: "Top projects (all-time)" });
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

// Shared breakdown-table renderer (Phase 1 System-browser range toggle,
// 2026-08-04; alignment fix Reviewer M2, 2026-08-04). `nameDotClass` is
// optional (workflows show a colored dot next to the name; skills don't).
// `nameSuffix`, when present, renders a small muted note after the name
// (used for the "all-time" honesty flag on partial/unscoped rows).
//
// M2 background: giving each table its OWN name-column width (so its own
// columns summed to 100%, avoiding table-layout:fixed's redistribution) was
// tried and MEASURED to still misalign -- a table-layout:fixed column's
// pixel position depends on every column BEFORE it, so two tables with
// different name-column widths (40% vs 32%, needed so each summed to 100%
// with a different total column count) put "Cost" at a different left edge
// in each table even though "Cost" itself was the same 15% wide in both
// (measured 69-103px apart at 900-1200px width). There is no percentage
// split that satisfies both "every table's own columns sum to 100%" and
// "the name column is identical width in every table" when the tables have
// different column counts -- the two constraints are mutually exclusive.
//
// The actual fix: every breakdown table renders the SAME NUMBER of columns
// (headers.length is padded up to `totalColumns` with blank trailing
// columns), so every table's per-position CSS width in styles.css is
// literally the same declaration applying to the same column count, and
// they can never diverge. `totalColumns` is currently 6 (the skills table's
// column count, the largest breakdown table today); a workflow row with
// only 5 real columns gets one blank trailing cell.
const USAGE_BREAKDOWN_TOTAL_COLUMNS = 6;

function renderUsageBreakdownTable(
  container: HTMLElement,
  headers: string[],
  rows: { nameText: string; nameDotClass?: string; nameSuffix?: string; cells: string[] }[]
) {
  const paddedHeaders = headers.slice();
  while (paddedHeaders.length < USAGE_BREAKDOWN_TOTAL_COLUMNS) paddedHeaders.push("");

  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", { cls: "aios-usage-table aios-usage-breakdown-table" });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of paddedHeaders) headRow.createEl("th", { text: h });
  const tbody = el.createEl("tbody");
  for (const row of rows) {
    const tr = tbody.createEl("tr");
    const nameCell = tr.createEl("td", { cls: "aios-usage-table-name" });
    if (row.nameDotClass) nameCell.createSpan({ cls: "aios-usage-dot " + row.nameDotClass });
    nameCell.createSpan({
      cls: "aios-usage-table-name-text",
      text: row.nameText,
      attr: { title: row.nameText.trim() },
    });
    if (row.nameSuffix) {
      nameCell.createSpan({ cls: "aios-usage-table-name-suffix", text: row.nameSuffix });
    }
    const paddedCells = row.cells.slice();
    while (paddedCells.length < USAGE_BREAKDOWN_TOTAL_COLUMNS - 1) paddedCells.push("");
    for (const c of paddedCells) tr.createEl("td", { text: c });
  }
}

// Honest per-row suffix (Reviewer M3, 2026-08-04): a fully partial row (no
// byDay at all) shows "(all-time)" since EVERY column is unscoped; a row
// whose cost/tokens/messages genuinely scoped but whose Runs column fell
// back (byDay present, but its day buckets carry no `sessions` count) shows
// the narrower "(runs: all-time)" so the honesty flag doesn't overstate how
// much of the row is actually unscoped.
function workflowRowSuffix(row: UsageWorkflowTableRow): string | undefined {
  if (row.partial) return "(all-time)";
  if (row.sessionsPartial) return "(runs: all-time)";
  return undefined;
}

// Common columns across workflows/skills: Cost, Runs, Output tokens, Msgs --
// same order, same index, in both tables, so those columns align vertically
// even though each table also carries a section-specific extra column.
function renderUsageWorkflowTable(container: HTMLElement, table: UsageWorkflowTableRow[]) {
  renderUsageBreakdownTable(
    container,
    ["Workflow", "Cost", "Runs", "Output tokens", "Msgs"],
    table.map((row) => ({
      nameText: " " + row.label,
      nameDotClass: "aios-workflow-color-" + row.colorIndex,
      nameSuffix: workflowRowSuffix(row),
      cells: [
        formatUsd(row.costUsd),
        String(row.sessions),
        formatCompactNumber(row.outputTokens),
        String(row.messages),
      ],
    }))
  );
}

// Spike alerts (build 2.9 slice 3): quiet by design. Renders nothing when
// there are no alerts -- no permanently-visible empty state, per spec. Each
// alert is a single line: dot + label + kind-specific text, purple accent
// used only on the dot/kind text since a spike is the one thing in this
// section meant to draw the eye.
function renderWorkflowSpikeAlerts(container: HTMLElement, alerts: WorkflowSpikeAlert[]) {
  if (alerts.length === 0) return;
  const wrap = container.createDiv({ cls: "aios-usage-spike-alerts" });
  for (const a of alerts) {
    const row = wrap.createDiv({ cls: "aios-usage-spike-row" });
    row.createSpan({ cls: "aios-usage-spike-dot" });
    row.createSpan({ cls: "aios-usage-spike-label", text: a.label });
    const detail =
      a.kind === "new"
        ? `new -- ${formatUsd(a.recentCostUsd)} this week`
        : `${Math.round(a.baselineSharePercent)}% -> ${Math.round(a.recentSharePercent)}% of spend`;
    row.createSpan({ cls: "aios-usage-spike-detail", text: detail });
  }
}

// Missing `workflows` field (old JSON) or an empty window renders nothing at
// all -- no section header, no error. `rangeLabel` names the active period
// in the subhead ("Workflows (Last 7 days)") so this section is never
// ambiguous even scrolled away from the sticky header.
function renderUsageWorkflowsSection(
  container: HTMLElement,
  view: UsageWorkflowsView,
  spikeAlerts: WorkflowSpikeAlert[],
  rangeLabel: string
) {
  if (!view.hasData) return;
  const anyPartial = view.table.some((r) => r.partial);
  const anySessionsPartial = view.table.some((r) => r.sessionsPartial && !r.partial);
  const honestySuffix = anyPartial
    ? ", some all-time"
    : anySessionsPartial
      ? ", some runs all-time"
      : "";
  container.createDiv({
    cls: "aios-usage-subhead",
    text: "Workflows (" + rangeLabel + honestySuffix + ")",
  });
  renderWorkflowSpikeAlerts(container, spikeAlerts);
  renderUsageWorkflowShareBar(container, view.shareBar);
  renderUsageWorkflowTable(container, view.table);
}

// Skills table shares the same column order/positions as the workflow table
// (Cost, Runs, Output tokens, Msgs) plus one trailing skill-only column
// (Avg/run), so the shared columns line up vertically between the two
// sections (Phase 1 System-browser range toggle, 2026-08-04, item 3).
function renderUsageSkillsTable(container: HTMLElement, rows: UsageSkillStat[]) {
  renderUsageBreakdownTable(
    container,
    ["Skill", "Cost", "Runs", "Output tokens", "Msgs", "Avg/run"],
    rows.map((row) => ({
      nameText: "/" + row.label,
      cells: [
        formatUsd(row.costUsd),
        String(row.runs),
        formatCompactNumber(row.outputTokens),
        String(row.messages),
        formatUsd(row.avgCostUsd),
      ],
    }))
  );
}

// Skills section: per-invocation spend, top 5 collapsed with a show-more
// toggle. Unlike the workflows section this owns its own container and
// redraws itself in place on toggle, so expanding does not re-render (and
// re-request) the whole Usage tab. Expand state lives in the shared
// viewState.expanded set, so it survives live re-renders like everything else.
const USAGE_SKILLS_EXPAND_KEY = "usage-skills";

function renderUsageSkillsSection(
  container: HTMLElement,
  stats: UsageStats,
  win: ReturnType<typeof computeUsageWindow>,
  viewState: ViewState
) {
  const section = container.createDiv({ cls: "aios-usage-skills" });

  const draw = () => {
    section.empty();
    const view: UsageSkillsView = computeSkillsViewForRange(
      stats,
      win.days,
      viewState.usageRange,
      viewState.expanded.has(USAGE_SKILLS_EXPAND_KEY)
    );
    if (!view.hasData) return;

    // Honest label (Phase 1 System-browser range toggle, 2026-08-04): only
    // claim the numbers follow the selected range when they genuinely do.
    // A pre-Phase-1 export (any skill missing byDay) falls back to all-time
    // totals -- the subhead says so instead of silently mislabeling a 30d
    // number as if it were scoped to the active toggle.
    const label = view.rangeSupported ? usageScopedRangeLabel(win) : "All available data";
    section.createDiv({ cls: "aios-usage-subhead", text: "Skills (" + label + ", per invocation)" });
    renderUsageSkillsTable(section, view.rows);

    if (view.hiddenCount === 0 && !view.expanded) return;
    const btn = section.createEl("button", {
      cls: "aios-usage-showmore",
      text: view.expanded ? "Show less" : `Show more (${view.hiddenCount})`,
    });
    btn.addEventListener("click", () => {
      if (viewState.expanded.has(USAGE_SKILLS_EXPAND_KEY)) {
        viewState.expanded.delete(USAGE_SKILLS_EXPAND_KEY);
      } else {
        viewState.expanded.add(USAGE_SKILLS_EXPAND_KEY);
      }
      draw();
    });
  };

  draw();
}

// Spend-guardrail warning tile, shared by the Today tab and the Usage tab so
// the two never disagree (both call budgetGuardrail with the same inputs).
// Renders nothing when the guardrail is off or not triggered.
function renderBudgetWarning(
  container: HTMLElement,
  guardrail: { todayCostUsd: number; dailyBudgetUsd: number; message: string } | null
) {
  if (!guardrail) return;
  container.createDiv({ cls: "aios-budget-warn" }).setText(guardrail.message);
}

// Usage tab: async load + render. Renders a hint when the exporter has not
// run yet (no usage-stats.json at settings.usageStatsPath).
//
// Phase 1 System-browser range toggle (2026-08-04): the whole tab body below
// the sticky header now lives in one redraw() closure keyed off
// viewState.usageRange/usageOffset, so every number on the page -- tiles,
// chart, model breakdown, workflows, skills -- recomputes from the same
// selected window instead of the old split where only the chart reacted to
// the range toggle and everything else stayed pinned to a fixed 30 days.

// Finds the scroll container that owns `el`'s scroll position: `.aios-scroll`,
// the internal div this plugin creates and controls (header/tabs
// restructure, 2026-08). Deterministic -- no more walking up through
// computed styles guessing which ancestor is Obsidian's real scrolling
// pane, because that ancestor is now always this plugin's own element,
// found the same way every time. Falls back to the old walk-up-and-measure
// search for a host that hasn't been re-rendered under the chrome/scroll
// split yet (e.g. a stale DOM reference), and finally to the document's own
// scrolling element.
function findScrollAncestor(el: HTMLElement): HTMLElement {
  const owned = el.closest(".aios-scroll") as HTMLElement | null;
  if (owned) return owned;
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const overflowsY = style.overflowY === "auto" || style.overflowY === "scroll";
    if (overflowsY && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement) || document.documentElement;
}

// `periodbarHost` is the Usage tab's slot in the fixed chrome (see
// renderDashboard) -- a normal-flow, non-scrolling flex child that sits
// below the tab bar. The period bar renders there; everything else (tiles,
// chart, breakdown tables) renders into `container`, which lives inside
// .aios-scroll and is the only thing that scrolls.
function renderUsageTab(
  app: App,
  container: HTMLElement,
  periodbarHost: HTMLElement,
  settings: AiosDashboardSettings,
  viewState: ViewState
) {
  const wrap = container.createDiv({ cls: "aios-usage-tab" });
  wrap.createDiv({ cls: "aios-empty", text: "Loading usage data..." });
  loadUsageStats(app, settings.usageStatsPath).then((stats) => {
    wrap.empty();
    periodbarHost.empty();
    if (!stats) {
      renderEmptyState(
        wrap,
        "No usage data yet. The exporter runs at session start, or run: node Operations/scripts/export-usage-stats.mjs"
      );
      return;
    }

    // Static across range changes: today's own cost (for the budget
    // guardrail, which is a real daily-budget alert independent of whatever
    // range the user is browsing) and the all-time project table (projects
    // have no per-day breakdown to scope by range -- see computeUsageView's
    // note).
    const todayWin = computeUsageWindow(stats.days || [], "1d", 0, new Date());
    const todayCostUsd = todayWin.days[0]?.totalCostUsd || 0;
    const projects = computeUsageView(stats, new Date()).projects;
    const spikeAlerts = computeWorkflowSpikes(stats, new Date());

    const periodbar = periodbarHost.createDiv({ cls: "aios-usage-periodbar" });
    const body = wrap.createDiv({ cls: "aios-usage-body" });

    const draw = () => {
      // Scroll-position fix (defect 3, 2026-08, still applies under the new
      // chrome/scroll split): periodbar.empty()/body.empty() below
      // synchronously drops this tab's content to near-zero height before
      // the rebuild re-adds it. If the scroll container's scrollTop was
      // deeper than that momentary (near-zero) scrollHeight, the browser
      // clamps scrollTop down immediately -- and does NOT restore it once
      // the rebuilt content re-grows the scrollHeight back. So every
      // range/paging toggle would silently snap the user back to the top.
      // Fix: capture scrollTop on .aios-scroll (found deterministically now,
      // see findScrollAncestor) before emptying, then restore it (clamped to
      // the new scrollHeight) after the rebuild. Re-queried fresh on every
      // call so rapid repeated clicks each capture/restore from wherever the
      // user currently is.
      const scrollEl = findScrollAncestor(wrap);
      const prevScrollTop = scrollEl ? scrollEl.scrollTop : 0;

      periodbar.empty();
      body.empty();

      const win = computeUsageWindow(stats.days || [], viewState.usageRange, viewState.usageOffset, new Date());
      renderUsagePeriodBar(periodbar, win, viewState, draw);
      // M4 (Reviewer, 2026-08-04): every subhead/tile below uses the SAME
      // offset-aware label the period bar just showed, so a paged-back
      // window never claims to be "Last 7 days" while the numbers are from
      // three windows ago.
      const scopedLabel = usageScopedRangeLabel(win);

      renderBudgetWarning(body, budgetGuardrail(todayCostUsd, settings.dailyBudgetUsd));
      renderUsageTiles(body, computeUsageRangeTiles(win.days, scopedLabel));
      renderUsageChartHost(body, win, viewState);

      const breakdown = usageFamilyBreakdown(win.days);
      renderUsageLegend(body, breakdown.legend);
      body.createDiv({ cls: "aios-usage-subhead", text: "Models (" + scopedLabel + ")" });
      renderUsageModelsTable(body, breakdown.table);

      const workflowsView = computeWorkflowsViewForRange(stats, win.days, viewState.usageRange);
      renderUsageWorkflowsSection(body, workflowsView, spikeAlerts, scopedLabel);

      renderUsageSkillsSection(body, stats, win, viewState);

      renderUsageProjectsTable(body, projects);
      body.createDiv({
        cls: "aios-foot",
        text: "API-equivalent value at standard rates; subscription billing differs.",
      });

      if (scrollEl) {
        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        scrollEl.scrollTop = Math.min(prevScrollTop, maxScrollTop);
      }
    };

    draw();

    let lastWidth = wrap.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (Math.abs(w - lastWidth) > 20) {
          lastWidth = w;
          draw();
        }
      }
    });
    ro.observe(wrap);
  });
}

// ---------------------------------------------------------------------------
// Today tab: DOING NOW (global) + top 3 tasks + quick capture + a compact
// stat row (spend, intake backlog, automation summary) + the spend-guardrail
// warning tile. Build 2.6 m3.
// ---------------------------------------------------------------------------

// Quick-capture write: collision-safe filename via resolveCaptureFileName
// (model.mjs, pure), existing names gathered synchronously from the
// already-loaded vault index (no extra I/O). Notice on failure only; success
// is reported by the caller via recordMutation (undoable, "Cmd+Z" hint).
// Returns the created file's path + content on success so the caller can
// record an undo entry, or null (input empty or write failed).
async function submitQuickCapture(
  app: App,
  settings: AiosDashboardSettings,
  rawText: string
): Promise<{ path: string; content: string } | null> {
  const text = rawText.trim();
  if (!text) return null;
  try {
    await ensureFolder(app, settings.intakeFolder);
    const folderPath = normalizePath(settings.intakeFolder);
    const existingStems = app.vault
      .getFiles()
      .filter((f) => f.parent?.path === folderPath)
      .map((f) => f.basename);
    const stem = resolveCaptureFileName(quickCaptureFileStem(new Date()), existingStems);
    const path = `${settings.intakeFolder}/${stem}.md`;
    const content = buildQuickCaptureContent(text, nowIso());
    await app.vault.create(path, content);
    return { path, content };
  } catch (e) {
    new Notice("AIOS: could not capture. " + (e?.message || e));
    return null;
  }
}

function renderQuickCapture(
  app: App,
  settings: AiosDashboardSettings,
  container: HTMLElement,
  undoCtx: UndoCtx
) {
  const section = container.createDiv({ cls: "aios-today-section aios-quick-capture" });
  section.createDiv({ cls: "aios-today-section-label", text: "QUICK CAPTURE" });
  const row = section.createDiv({ cls: "aios-quick-capture-row" });
  const inputWrap = row.createDiv({ cls: "aios-quick-capture-input-wrap" });
  const input = inputWrap.createEl("input", {
    cls: "aios-quick-capture-input",
    attr: { type: "text", placeholder: "Capture a thought..." },
  }) as HTMLInputElement;
  const btn = inputWrap.createEl("button", { cls: "aios-quick-capture-btn" });
  btn.setAttr("aria-label", "Capture");
  setIcon(btn, "arrow-up");

  const submit = async () => {
    const value = input.value;
    if (!value.trim()) return;
    const created = await submitQuickCapture(app, settings, value);
    if (created) {
      recordMutation(undoCtx.plugin, undoCtx.isLeafView, {
        id: undoEntryId(),
        label: "Captured to Intake",
        kind: "create",
        pathAfter: created.path,
        contentAfter: created.content,
      });
      input.value = "";
    }
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void submit();
    }
  });
}

function renderTopTasksSection(
  app: App,
  tasksRoot: string,
  container: HTMLElement,
  tasks: TaskItem[],
  refresh: () => void,
  undoCtx: UndoCtx
) {
  const section = container.createDiv({ cls: "aios-today-section" });
  section.createDiv({ cls: "aios-today-section-label", text: "TOP TASKS" });
  const top = topTasks(tasks, 3);
  if (top.length === 0) {
    renderEmptyState(section, "No open tasks.");
    return;
  }
  const list = section.createDiv({ cls: "aios-list" });
  for (const t of top) renderTaskRow(app, tasksRoot, list, t, refresh, undoCtx);
}

// Sparkline SVG (build 2.9 slice 4): inline, no library. `points` are 0..1
// normalized (see computeSpendSparkline). Deliberately tiny and quiet -- it
// sits under a headline number and must not compete with it, so it's a
// single thin grey line with no fill, no axis, no labels.
function renderSparklineSvg(container: HTMLElement, points: number[]) {
  if (points.length < 2) return;
  const width = 64;
  const height = 18;
  const stepX = width / (points.length - 1);
  const coords = points
    .map((p, i) => `${(i * stepX).toFixed(1)},${(height - p * height).toFixed(1)}`)
    .join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "aios-sparkline-svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("class", "aios-sparkline-line");
  line.setAttribute("points", coords);
  svg.appendChild(line);
  container.appendChild(svg);
}

// Compact stat row: today's spend + automation summary load async (usage-stats.json,
// automation-health.json); intake backlog is synchronous (reuses the already-computed
// health tiles, same source the health strip renders from). Missing data files render
// "n/a" / hide the automations stat, same optional-data pattern as their own tabs.
//
// Only the spend tile gets a trend sparkline: it's the only stat row entry
// backed by a daily time series (usage-stats.json days[]). Intake backlog and
// the automations summary have no per-day history in the current data model,
// so they stay plain numbers rather than growing a fake or misleading trend.
function renderTodayStatRow(
  app: App,
  settings: AiosDashboardSettings,
  container: HTMLElement,
  healthTiles: HealthTile[]
) {
  const row = container.createDiv({ cls: "aios-today-stats aios-usage-tiles" });
  const guardrailSlot = container.createDiv({ cls: "aios-today-guardrail" });

  const mkTile = (label: string) => {
    const tile = row.createDiv({ cls: "aios-health-tile aios-usage-tile" });
    tile.createSpan({ cls: "aios-health-tile-label", text: label });
    const val = tile.createSpan({ cls: "aios-health-tile-count", text: "..." });
    return { tile, val };
  };

  const spend = mkTile("Today's spend");
  const sparkSlot = spend.tile.createDiv({ cls: "aios-sparkline-slot" });
  const intake = mkTile("Intake backlog");
  intake.val.setText(String(intakeBacklogCount(healthTiles)));

  const auto = mkTile("Automations");
  auto.tile.addClass("aios-today-auto-tile");
  auto.tile.addEventListener("click", () => {
    const autoSection = container.closest(".aios-dashboard-root")?.querySelector(".aios-auto-section");
    if (autoSection) autoSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  loadUsageStats(app, settings.usageStatsPath).then((stats) => {
    if (!stats) {
      spend.val.setText("n/a");
      return;
    }
    const view = computeUsageView(stats, new Date());
    spend.val.setText(formatUsd(view.tiles.todayCostUsd));
    renderBudgetWarning(guardrailSlot, budgetGuardrail(view.tiles.todayCostUsd, settings.dailyBudgetUsd));
    const sparkline = computeSpendSparkline(stats, new Date());
    if (sparkline.hasData) renderSparklineSvg(sparkSlot, sparkline.points);
  });

  loadAutomationHealth(app, settings.automationHealthPath).then((health) => {
    if (!health) {
      auto.tile.remove();
      return;
    }
    const view = computeAutomationView(health, new Date());
    const summary = automationSummaryText(view.counts);
    auto.val.setText(summary.text);
    if (summary.hasFailing) auto.tile.addClass("aios-health-tile-warn");
  });
}

// ---------------------------------------------------------------------------
// Coordination panel (GL-011, Today tab): one card per participating project
// (settings.projectsRoot/<slug>/work-ledger.md exists -- see
// participatingProjectSlugs above). Renders nothing at all -- no section, no
// label -- when no project participates. computeCoordinationView (model.mjs)
// is the pure half; everything here is the impure gather-then-render half,
// mirroring the ops-map tab's loadOpsMap split.
// ---------------------------------------------------------------------------

interface CoordinationActiveSession {
  session: string;
  branch: string;
  lastUpdate: string;
  stale: boolean;
}

interface CoordinationQuestion {
  id: string;
  date: string;
  title: string;
  context: string;
  answer: string;
}

// OPEN QUESTIONS filter chip (owner feedback 2026-08-30). Mirrors model.mjs's
// CoordinationQuestionFilter JSDoc typedef; declared independently here,
// same convention as CoordinationQuestion/CoordinationProjectView above.
type CoordinationQuestionFilter = "unanswered" | "answered" | "all";

interface CoordinationProjectView {
  slug: string;
  activeSessions: CoordinationActiveSession[];
  unlanded: number;
  questions: CoordinationQuestion[];
}

// What (if anything) was focused inside the coordination section right
// before this render wiped the DOM (captured in renderDashboard, before
// root.empty()). Threaded down through renderTodayTab so the async
// card-population pass below can restore focus + cursor to the matching
// recreated input once it exists -- never to anything else (same
// never-steal-focus principle as the Systems drawer's own focus guard).
interface CoordinationFocusCapture {
  key: string; // data-key on the answer input: "<projectSlug>::<questionId>"
  selectionStart: number | null;
}

function captureCoordinationFocus(root: HTMLElement): CoordinationFocusCapture | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement)) return null;
  if (!active.classList.contains("aios-coord-answer-input")) return null;
  if (!root.contains(active)) return null;
  const key = active.getAttribute("data-key");
  if (!key) return null;
  return { key, selectionStart: active.selectionStart };
}

// Scans whatever container the caller passes -- the whole Projects-tab body
// now that answer boxes live inside per-project cards rather than one
// Today-tab section, so the matching textarea could be under any card.
function restoreCoordinationFocus(container: HTMLElement, capture: CoordinationFocusCapture | null) {
  if (!capture) return;
  let target: HTMLTextAreaElement | null = null;
  container.querySelectorAll<HTMLTextAreaElement>(".aios-coord-answer-input").forEach((el) => {
    if (el.getAttribute("data-key") === capture.key) target = el;
  });
  if (!target) return;
  // preventScroll (owner feedback 2026-08-30, scroll position survives
  // everything): this fires ASYNCHRONOUSLY, after renderDashboard's own
  // synchronous scroll restore already ran (the async coordination gather
  // resolves well after this function returns). Without preventScroll, a
  // browser's default focus() behavior can scroll the focused element into
  // view on its own, which would fight the position renderDashboard just
  // restored. In the ordinary case the textarea is already in view (it's
  // wherever the user was typing when their scroll position was last
  // saved), so this is a no-behavior-change safety net, not a fix for an
  // observed jump.
  target.focus({ preventScroll: true });
  const pos = capture.selectionStart ?? target.value.length;
  try {
    target.setSelectionRange(pos, pos);
  } catch {
    /* some input states don't support selection ranges; harmless to skip */
  }
}

// Shared auto-grow sizer for a coordination answer textarea: reset to
// "auto" so scrollHeight reflects the CURRENT content (not a stale taller
// value from before a shrink), then set height to that measured content
// height. Must be re-run whenever the element's content OR its visibility
// changes -- scrollHeight reads 0 for anything inside a display:none
// subtree (a collapsed project card's .aios-card-body), which is exactly
// why this needs a second call site: once here per-keystroke/at-creation,
// and again from renderProjectCard's expand handler for whichever
// textareas were sized at 0 while their card was still collapsed. Pure
// measure-and-set off the textarea's own live value, so re-running it from
// either call site is idempotent -- the two paths cannot fight.
function autoGrowCoordinationTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// One question, collapsed by default to a compact row (title + answered
// pill + faint id/date), clicking the head expands it to reveal, top to
// bottom: the title (unchanged, already visible in the collapsed row), a
// CONTEXT block, then the YOUR ANSWER block. Collapsed, the head IS
// effectively the whole visible row (the body is display:none), so the hit
// target does not shrink; it only stops covering the body once expanded.
// Owner feedback 2026-08-30:
// "clicking on a question should open the main question, context should be
// below it and the answer field below that." Per-question expand state is
// keyed "<slug>::<id>" in viewState.expanded, the exact same shape as the
// draft key (a different Map, so no collision) -- both survive the
// live-refresh re-render the same way.
function renderCoordinationQuestion(
  app: App,
  settings: AiosDashboardSettings,
  container: HTMLElement,
  slug: string,
  q: CoordinationQuestion,
  viewState: ViewState,
  refresh: () => void,
  undoCtx: UndoCtx
) {
  const draftKey = slug + "::" + q.id;
  const qExpandKey = draftKey;

  // The question itself: a muted surface box with a faint left accent so it
  // reads as "incoming" (an agent asked this).
  const row = container.createDiv({ cls: "aios-coord-question" });
  if (viewState.expanded.has(qExpandKey)) row.addClass("aios-expanded");

  // Head: the compact collapsed row, and still the always-visible top of
  // the expanded layout. The HEAD (not the whole row) carries the toggle
  // click listener: the body (CONTEXT text, the answer textarea, the
  // answer block's padding) is a SIBLING of head, not a descendant, so a
  // click anywhere in the body never bubbles into this listener at all --
  // no stopPropagation needed there. Reviewer finding 2026-08-30: with the
  // listener on the whole row, clicking (or finishing a text selection)
  // anywhere in CONTEXT or in the answer block's padding collapsed the
  // question out from under Jaymo, e.g. the moment he tried to copy a
  // wiki-link name out of a context line. metaEl's own stopPropagation
  // below still matters: it IS a head descendant, so without it, clicking
  // the Q-id/date link would also toggle collapse instead of opening the
  // file.
  const head = row.createDiv({ cls: "aios-coord-question-head" });
  head.createSpan({ cls: "aios-coord-question-title", text: q.title });
  // The Q-id + date is now the open-the-file affordance (title itself no
  // longer opens questions.md -- clicking the head toggles expansion
  // instead, so the click target had to move).
  const metaEl = head.createSpan({
    cls: "aios-coord-question-meta",
    text: `${q.id.replace(/^Q-/, "")} · asked ${q.date}`,
  });
  metaEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    app.workspace.openLinkText(`${settings.projectsRoot}/${slug}/questions.md`, "", false);
  });
  // Shared predicate (model.mjs) so the pill and the OPEN QUESTIONS filter
  // chips (renderCoordinationBody) can never disagree about "answered".
  if (isCoordinationQuestionAnswered(q)) {
    head.createSpan({ cls: "aios-pill aios-coord-answered-pill", text: "answered" });
  }
  head.addEventListener("click", () => {
    const nowOpen = row.classList.toggle("aios-expanded");
    if (nowOpen) viewState.expanded.add(qExpandKey);
    else viewState.expanded.delete(qExpandKey);
    // Re-measure this question's own answer textarea now that its body is
    // actually visible (see the zero-height comment above autoGrow()).
    // Queried from row, not head: the textarea lives in body, a sibling of
    // head, so head itself has nothing to find.
    if (nowOpen) {
      row.querySelectorAll<HTMLTextAreaElement>(".aios-coord-answer-input").forEach((el) => {
        autoGrowCoordinationTextarea(el);
      });
    }
  });

  // Body: CONTEXT (when present) then YOUR ANSWER, hidden until the head
  // toggles this question open.
  const body = row.createDiv({ cls: "aios-coord-question-body" });

  // Context: background info, not a second question -- small, muted type,
  // still visually part of the "incoming" question box (no accent border
  // of its own). Omitted entirely when "".
  if (q.context) {
    body.createDiv({ cls: "aios-coord-question-context", text: q.context });
  }

  // The answer: a visually distinct sub-block offset under the question,
  // tinted a different hue (green/positive, not the red used for stale) so
  // "what Jaymo wrote" reads as unmistakably his at a glance -- owner
  // feedback 2026-08-29 was that question and answer used to look the same.
  const answerBlock = body.createDiv({ cls: "aios-coord-answer-block" });
  answerBlock.createDiv({ cls: "aios-coord-answer-label", text: "YOUR ANSWER" });

  const answerRow = answerBlock.createDiv({ cls: "aios-coord-answer-row" });
  const input = answerRow.createEl("textarea", {
    cls: "aios-coord-answer-input",
    attr: { rows: 1, placeholder: "Type an answer... (Shift+Enter for a new line)" },
  });
  input.setAttr("data-key", draftKey);
  // A half-typed draft (kept in viewState across the live-refresh re-render)
  // wins over the file's own parsed answer; cleared only on a successful save.
  input.value = viewState.coordinationDrafts.has(draftKey)
    ? (viewState.coordinationDrafts.get(draftKey) as string)
    : q.answer;

  // Auto-grow: starts at ~1-2 rows, grows with content up to the CSS
  // max-height (styles.css), then scrolls. 13 of 18 real answers in the
  // vagabond-ops-app questions.md are long prose, so a fixed single-line
  // input truncated most of what Jaymo actually writes.
  input.addEventListener("input", () => {
    viewState.coordinationDrafts.set(draftKey, input.value);
    autoGrowCoordinationTextarea(input);
  });
  // Size once up front too, since the starting value (a real answer or a
  // restored draft) may already be multiple lines long. This textarea now
  // sits inside TWO layers that can each be display:none at creation time
  // (this question's own body, and its parent OPEN QUESTIONS group's body)
  // -- scrollHeight reads 0 whenever either is collapsed. The CSS
  // min-height floor covers that until the group-expand or question-expand
  // handler below re-runs this same sizer once the textarea is actually
  // visible.
  autoGrowCoordinationTextarea(input);

  const saveBtn = answerRow.createEl("button", { cls: "aios-coord-answer-save", text: "Save" });

  const save = async () => {
    const text = input.value;
    const result = await saveCoordinationAnswer(app, settings.projectsRoot, slug, q.id, text);
    if (result) {
      recordMutation(undoCtx.plugin, undoCtx.isLeafView, {
        id: undoEntryId(),
        label: `Answered ${q.id}`,
        kind: "edit-move",
        pathBefore: result.path,
        pathAfter: result.path,
        contentBefore: result.contentBefore,
        contentAfter: result.contentAfter,
      });
      viewState.coordinationDrafts.delete(draftKey);
    }
    refresh();
  };

  saveBtn.addEventListener("click", () => void save());
  input.addEventListener("keydown", (ev) => {
    // Enter saves; Shift+Enter inserts a newline. Newlines are collapsed to
    // a single line on write by spliceAnswer (model.mjs), unchanged.
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void save();
    }
  });
}

// Hosts for one participating project's coordination content, created
// synchronously (empty) inside renderProjectCard and filled in once the
// async gather below resolves: pillsHost sits in the card's always-visible
// head row, bodyHost sits at the top of the collapsible body.
interface CoordinationCardHosts {
  pillsHost: HTMLElement;
  bodyHost: HTMLElement;
}

function renderCoordinationPills(container: HTMLElement, view: CoordinationProjectView) {
  container.empty();
  container.createSpan({ cls: "aios-pill", text: `${view.activeSessions.length} active` });
  container.createSpan({ cls: "aios-pill", text: `${view.unlanded} unlanded` });
  container.createSpan({ cls: "aios-pill", text: `${view.questions.length} questions` });
  if (view.activeSessions.some((s) => s.stale)) {
    container.createSpan({ cls: "aios-pill aios-coord-stale-pill", text: "stale claim" });
  }
}

// Coordination content for one participating project, rendered directly as
// groups (no separate collapsible card/chevron of its own -- the project
// card's own expand state governs visibility). Each group is omitted, not
// empty-stated, when it has nothing to show.
function renderCoordinationBody(
  app: App,
  settings: AiosDashboardSettings,
  container: HTMLElement,
  view: CoordinationProjectView,
  viewState: ViewState,
  refresh: () => void,
  undoCtx: UndoCtx
) {
  container.empty();

  if (view.activeSessions.length > 0) {
    const group = container.createDiv({ cls: "aios-coord-group" });
    group.createDiv({ cls: "aios-coord-group-label", text: "ACTIVE SESSIONS" });
    for (const s of view.activeSessions) {
      const row = group.createDiv({
        cls: "aios-coord-session-row" + (s.stale ? " aios-coord-session-stale" : ""),
      });
      row.createSpan({ cls: "aios-coord-session-name", text: s.session });
      row.createSpan({ cls: "aios-coord-session-branch", text: s.branch });
      row.createSpan({ cls: "aios-coord-session-updated", text: "updated " + s.lastUpdate });
      if (s.stale) row.createSpan({ cls: "aios-pill aios-coord-stale-pill", text: "stale" });
    }
  }

  // OPEN QUESTIONS: collapsible, collapsed by default (owner feedback
  // 2026-08-30: "questions section should be collapsable so it's not
  // showing all by default"). Standard chevron treatment, same rotate-on-
  // expand mechanism as a project/phase card head. Expand state persists in
  // viewState.expanded under "coordq:<slug>" -- ACTIVE SESSIONS above is
  // unchanged, not collapsible.
  if (view.questions.length > 0) {
    const group = container.createDiv({ cls: "aios-coord-group aios-coord-group-questions" });
    const qGroupKey = "coordq:" + view.slug;
    if (viewState.expanded.has(qGroupKey)) group.addClass("aios-expanded");

    const groupHead = group.createDiv({ cls: "aios-coord-group-head" });
    renderChevron(groupHead);
    groupHead.createSpan({
      cls: "aios-coord-group-label",
      text: `OPEN QUESTIONS (${view.questions.length})`,
    });
    groupHead.addEventListener("click", () => {
      const nowOpen = group.classList.toggle("aios-expanded");
      if (nowOpen) viewState.expanded.add(qGroupKey);
      else viewState.expanded.delete(qGroupKey);
      // A question that was already expanded (persisted in viewState from
      // an earlier interaction) has its own body visible now that this
      // group is too, but its textarea was measured at scrollHeight 0 while
      // the group hid it -- re-measure every answer textarea in the group,
      // not just this group's own newly-revealed content. Idempotent: a
      // textarea whose question is still collapsed just gets re-measured
      // at 0 again, harmless since it stays hidden.
      if (nowOpen) {
        group.querySelectorAll<HTMLTextAreaElement>(".aios-coord-answer-input").forEach((el) => {
          autoGrowCoordinationTextarea(el);
        });
      }
    });

    const groupBody = group.createDiv({ cls: "aios-coord-group-body" });

    // Filter bar (owner feedback 2026-08-30: "lets put a filtered tab
    // (answered, unanswered, all) next to Open Questions? So i can see
    // only the things i want/need"). Lives in groupBody, NOT groupHead --
    // a sibling of the head, so a chip click can never fight the group's
    // own expand/collapse toggle. Same chip engine as the Projects tab's
    // status filter and the Tasks tab's category filter (renderChips),
    // placed above the list the same way those tabs do. Default
    // "unanswered": that IS "the things I need" Jaymo asked for, not an
    // unset state. Persists per project slug so two participating projects
    // can hold different filters; unaffected by the group's own expand
    // state, so it survives a collapse/re-expand of the group itself.
    const filterMode: CoordinationQuestionFilter =
      viewState.coordinationQuestionFilter.get(view.slug) ?? "unanswered";
    const counts = coordinationQuestionFilterCounts(view.questions);
    const filterChips: Chip[] = [
      { slug: "unanswered", label: "Unanswered", count: counts.unanswered },
      { slug: "answered", label: "Answered", count: counts.answered },
      { slug: "all", label: "All", count: counts.all },
    ];
    renderChips(groupBody, filterChips, filterMode, (pickedSlug) => {
      viewState.coordinationQuestionFilter.set(view.slug, pickedSlug as CoordinationQuestionFilter);
      refresh();
    });

    // The group header keeps the TOTAL count (OPEN QUESTIONS (N), above),
    // unaffected by which filter is active -- only the list below is
    // filtered.
    const filtered = filterCoordinationQuestions(view.questions, filterMode);
    if (filtered.length === 0) {
      renderEmptyState(groupBody, "No questions match this filter.");
    } else {
      // Per-question expand state and drafts are keyed by qid (slug::id),
      // not by filter or list position, so a question expanded under "All"
      // stays expanded when the filter switches back to "Unanswered" and
      // it reappears -- no extra bookkeeping needed here, the key survives
      // filter switches by construction.
      for (const q of filtered) {
        renderCoordinationQuestion(app, settings, groupBody, view.slug, q, viewState, refresh, undoCtx);
      }
    }

    // Switching the filter rebuilds this whole list from scratch (every
    // renderCoordinationQuestion call above is a brand-new DOM node), so a
    // question that reappears already expanded (persisted in viewState from
    // before it was filtered out) needs its textarea re-measured here too --
    // same zero-height discipline as the group-expand and question-expand
    // handlers above. Idempotent and harmless for a still-collapsed one.
    groupBody.querySelectorAll<HTMLTextAreaElement>(".aios-coord-answer-input").forEach((el) => {
      autoGrowCoordinationTextarea(el);
    });
  }
}

function renderTodayTab(
  app: App,
  container: HTMLElement,
  settings: AiosDashboardSettings,
  tasksRoot: string,
  tasks: TaskItem[],
  healthTiles: HealthTile[],
  refresh: () => void,
  undoCtx: UndoCtx
) {
  const wrap = container.createDiv({ cls: "aios-today-tab" });

  const doing = tasks.filter((t) => t.status === "in-progress");
  renderDoingNowStrip(app, tasksRoot, wrap, doing, refresh, undoCtx);

  renderTopTasksSection(app, tasksRoot, wrap, tasks, refresh, undoCtx);
  renderQuickCapture(app, settings, wrap, undoCtx);
  renderTodayStatRow(app, settings, wrap, healthTiles);
}

// ---------------------------------------------------------------------------
// Ops map tab: gather (impure, async) + render.
// ---------------------------------------------------------------------------

// Reads and defensively parses ops-map.json off the vault adapter. Returns
// null on any failure (missing file, malformed JSON, unexpected shape) so the
// caller can fall back to the "no ops map yet" hint instead of throwing.
async function loadOpsMap(app: App, mapPath: string): Promise<OpsMapManifest | null> {
  try {
    const exists = await app.vault.adapter.exists(mapPath);
    if (!exists) return null;
    const raw = await app.vault.adapter.read(mapPath);
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed as OpsMapManifest;
  } catch {
    return null;
  }
}

const OPS_MAP_TYPE_LABEL: Record<string, string> = {
  agent: "Agent",
  workflow: "Workflow",
  sop: "SOP",
  guideline: "Guideline",
  skill: "Skill",
  "skill-summary": "Skills",
};

function opsMapNodeSvgClass(type: string): string {
  return "aios-opsmap-node aios-opsmap-node-" + type;
}

// Renders the deterministic layered SVG graph. Hovering a node highlights its
// edges + connected nodes and dims the rest (class toggles, no re-layout).
function renderOpsMapGraph(
  app: App,
  container: HTMLElement,
  layout: OpsMapLayout,
  onOpenVaultNode: (path: string) => void
) {
  const wrap = container.createDiv({ cls: "aios-opsmap-wrap" });

  // Column headers.
  const headerRow = wrap.createDiv({ cls: "aios-opsmap-headers" });
  headerRow.style.width = layout.width + "px";
  for (const col of layout.columns) {
    const h = headerRow.createDiv({ cls: "aios-opsmap-header" });
    h.style.left = col.x + "px";
    h.style.width = OPS_MAP_DEFAULTS.nodeWidth + "px";
    h.createSpan({ cls: "aios-opsmap-header-label", text: col.label });
    h.createSpan({ cls: "aios-opsmap-header-count", text: String(col.count) });
  }

  const svgWrap = wrap.createDiv({ cls: "aios-opsmap-svg-wrap" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "aios-opsmap-svg");
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svgWrap.appendChild(svg);

  const edgesByNode = new Map<string, OpsMapResolvedEdge[]>();
  for (const e of layout.edges) {
    if (!edgesByNode.has(e.from)) edgesByNode.set(e.from, []);
    if (!edgesByNode.has(e.to)) edgesByNode.set(e.to, []);
    edgesByNode.get(e.from)!.push(e);
    edgesByNode.get(e.to)!.push(e);
  }

  // Edges (cubic bezier, low opacity by default).
  const edgeEls: { el: SVGPathElement; edge: OpsMapResolvedEdge }[] = [];
  for (const e of layout.edges) {
    const midX = (e.x1 + e.x2) / 2;
    const d = `M ${e.x1} ${e.y1} C ${midX} ${e.y1}, ${midX} ${e.y2}, ${e.x2} ${e.y2}`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "aios-opsmap-edge aios-opsmap-edge-" + e.viaType);
    path.setAttribute("fill", "none");
    svg.appendChild(path);
    edgeEls.push({ el: path, edge: e });
  }

  // Nodes: rounded rects + label text, foreignObject-free (plain SVG text,
  // truncated by width via CSS on the wrapping rect's title).
  const nodeEls: { el: SVGGElement; node: OpsMapPositionedNode }[] = [];
  for (const n of layout.nodes) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", opsMapNodeSvgClass(n.type));
    g.setAttribute("transform", `translate(${n.x}, ${n.y})`);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "aios-opsmap-node-rect");
    rect.setAttribute("width", String(n.width));
    rect.setAttribute("height", String(n.height));
    rect.setAttribute("rx", "6");
    g.appendChild(rect);

    const accent = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    accent.setAttribute("class", "aios-opsmap-node-accent");
    accent.setAttribute("width", "4");
    accent.setAttribute("height", String(n.height));
    accent.setAttribute("rx", "2");
    g.appendChild(accent);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "aios-opsmap-node-label");
    text.setAttribute("x", "12");
    text.setAttribute("y", String(n.height / 2 + 4));
    text.textContent = n.label.length > 24 ? n.label.slice(0, 23) + "…" : n.label;
    g.appendChild(text);

    const titleParts = [OPS_MAP_TYPE_LABEL[n.type] || n.type, n.label];
    if (n.type === "skill-summary" && n.collapsedNames) titleParts.push(n.collapsedNames.join(", "));
    else if (n.description) titleParts.push(n.description);
    else if (n.path) titleParts.push(n.path);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = titleParts.join(": ");
    g.appendChild(title);

    g.addEventListener("mouseenter", () => {
      svg.classList.add("aios-opsmap-hovering");
      g.classList.add("aios-opsmap-node-active");
      for (const { el, edge } of edgeEls) {
        if (edge.from === n.id || edge.to === n.id) el.classList.add("aios-opsmap-edge-active");
      }
      for (const { el, node } of nodeEls) {
        if (node.id === n.id) continue;
        const touching = (edgesByNode.get(n.id) || []).some((e) => e.from === node.id || e.to === node.id);
        if (touching) el.classList.add("aios-opsmap-node-active");
      }
    });
    g.addEventListener("mouseleave", () => {
      svg.classList.remove("aios-opsmap-hovering");
      for (const { el } of nodeEls) el.classList.remove("aios-opsmap-node-active");
      for (const { el } of edgeEls) el.classList.remove("aios-opsmap-edge-active");
    });

    if (n.type !== "skill-summary") {
      g.addEventListener("click", () => {
        if (n.external) {
          new Notice("AIOS: " + (n.path || n.id));
        } else if (n.path) {
          onOpenVaultNode(n.path);
        }
      });
    }

    svg.appendChild(g);
    nodeEls.push({ el: g, node: n });
  }
}

// Ops map tab: async load + layout + render. Renders a hint when the
// exporter has not run yet (no ops-map.json at settings.opsMapPath).
function renderOpsMapTab(app: App, container: HTMLElement, settings: AiosDashboardSettings) {
  const wrap = container.createDiv({ cls: "aios-opsmap-tab" });
  wrap.createDiv({ cls: "aios-empty", text: "Loading ops map..." });
  loadOpsMap(app, settings.opsMapPath).then((manifest) => {
    wrap.empty();
    if (!manifest) {
      renderEmptyState(
        wrap,
        "No ops map yet. The exporter runs at session start, or run: node Operations/scripts/export-ops-map.mjs"
      );
      return;
    }
    const layout = computeOpsMapLayout(manifest);
    renderOpsMapGraph(app, wrap, layout, (path) => {
      app.workspace.openLinkText(path, "", false);
    });
  });
}

// ---------------------------------------------------------------------------
// System tab (build 2026-08-04): a generated, human-readable view of what is
// installed -- Skills first (this phase), Agents and Workflows/SOPs land as
// sibling sections in later phases (see the task spec's build order). Reads
// the SAME ops-map.json + usage-stats.json the Ops-map and Usage tabs already
// load (loadOpsMap/loadUsageStats, unmodified) -- no new exporter wiring
// needed in the plugin layer, only a new view over existing data.
//
// This whole region is intentionally new/separate code: a sibling branch is
// concurrently touching the Usage tab's own render functions above
// (renderUsageTab and everything under its "Usage tab" banner comment), so
// nothing here calls into or edits that region except via the already-stable
// renderUsageBreakdownTable/USAGE_BREAKDOWN_TOTAL_COLUMNS/formatUsd/
// formatCompactNumber helpers, which this code only reads from, never edits.
// ---------------------------------------------------------------------------

interface SystemSkillUsedByRow {
  id: string;
  label: string;
  path?: string;
}

interface SystemSkillRow {
  id: string;
  description: string;
  disableModelInvocation: boolean;
  path?: string;
  external: boolean;
  origin: "skills-dir" | "plugin" | "command";
  usedBy: SystemSkillUsedByRow[];
  costUsd: number | null;
  runs: number | null;
  avgCostUsd: number | null;
}

interface SystemSkillGroup {
  suite: string;
  rows: SystemSkillRow[];
  count: number;
  // Cheap nit (Reviewer, 2026-08-05): ":" for a colon-namespaced plugin
  // suite (superpowers:*), "-" for a generic hyphen-prefixed suite (gsd-*).
  separator: string;
}

interface SystemSkillsView {
  totalCount: number;
  filteredCount: number;
  filterActive: boolean;
  standalone: SystemSkillRow[];
  groups: SystemSkillGroup[];
}

// Origin badge text (Reviewer M3, 2026-08-04): short enough to sit inline
// next to a skill name without dominating the row.
const SYSTEM_SKILL_ORIGIN_LABELS: Record<SystemSkillRow["origin"], string> = {
  "skills-dir": "skill",
  plugin: "plugin",
  command: "command",
};

// Cap the "Used by" list per row (Reviewer minor, 2026-08-04, measured): a
// handful of heavily-referenced skills had 20+ used-by entries, producing
// 525px-tall rows. Shows the first N inline; the rest sit behind a
// same-row "+N more" toggle that expands in place (no redraw, no viewState
// -- purely local DOM state) so the row grows once, deliberately, on click.
const SYSTEM_SKILLS_USED_BY_VISIBLE = 6;

// Renders the "Used by" cell's content: the first
// SYSTEM_SKILLS_USED_BY_VISIBLE entries inline, then (Reviewer minor,
// 2026-08-04) a "+N more" toggle that reveals the rest in place -- pure
// local DOM state, no redraw, so a 20+-reference row only grows once, on
// deliberate click, instead of always rendering at full height.
function renderSystemSkillUsedByCell(app: App, cell: HTMLElement, usedBy: SystemSkillUsedByRow[]) {
  if (usedBy.length === 0) {
    cell.createSpan({ cls: "aios-usage-table-name-suffix", text: "–" });
    return;
  }

  const renderEntry = (host: HTMLElement, u: SystemSkillUsedByRow) => {
    if (u.path) {
      const link = host.createEl("a", { text: u.label, cls: "aios-system-skill-usedby-link", href: "#" });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        app.workspace.openLinkText(u.path as string, "", false);
      });
    } else {
      host.createSpan({ text: u.label });
    }
  };

  const visible = usedBy.slice(0, SYSTEM_SKILLS_USED_BY_VISIBLE);
  const rest = usedBy.slice(SYSTEM_SKILLS_USED_BY_VISIBLE);

  visible.forEach((u, i) => {
    if (i > 0) cell.createSpan({ text: ", " });
    renderEntry(cell, u);
  });

  if (rest.length === 0) return;

  cell.createSpan({ text: ", " });
  const restHost = cell.createSpan({ cls: "aios-system-skill-usedby-rest" });
  restHost.hide();
  rest.forEach((u, i) => {
    if (i > 0) restHost.createSpan({ text: ", " });
    renderEntry(restHost, u);
  });

  const moreBtn = cell.createEl("button", {
    cls: "aios-system-skill-usedby-more",
    text: `+${rest.length} more`,
  });
  moreBtn.addEventListener("click", () => {
    if (restHost.isShown()) {
      restHost.hide();
      moreBtn.setText(`+${rest.length} more`);
    } else {
      restHost.show();
      moreBtn.setText("less");
    }
  });
}

// Renders one skills table (either the standalone rows or one expanded
// group's rows). Deliberately does NOT call the shared
// renderUsageBreakdownTable helper -- the "Used by" column needs real
// clickable elements per row (Obsidian openLinkText for internal nodes,
// plain text for external skill/skill refs), which that helper's
// text-only cells can't produce -- but it reuses the same table CSS classes
// so Cost/Runs still line up in the same column position as every other
// breakdown table on the page (Reviewer M4, 2026-08-04, measured: columns
// 1/2/3/6 carry no per-table override at all, so they are byte-identical to
// the shared rule and cannot drift; see styles.css's comment on this
// table's nth-child(4)/(5) overrides for the measured before/after). Six
// real headers (Skill/Cost/Runs/Description/Used by/Avg per run) fill
// USAGE_BREAKDOWN_TOTAL_COLUMNS exactly -- same shape as the Usage tab's own
// Skills sub-table (renderUsageSkillsTable), which is the closer sibling to
// compare against, not the 5-header Workflow table.
function renderSystemSkillsTable(app: App, container: HTMLElement, rows: SystemSkillRow[]) {
  const headers = ["Skill", "Cost", "Runs", "Description", "Used by", "Avg/run"];

  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", {
    cls: "aios-usage-table aios-usage-breakdown-table aios-system-skills-table",
  });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of headers) headRow.createEl("th", { text: h });

  const tbody = el.createEl("tbody");
  for (const row of rows) {
    const tr = tbody.createEl("tr");

    const nameCell = tr.createEl("td", { cls: "aios-usage-table-name" });
    nameCell.createSpan({ cls: "aios-usage-table-name-text", text: row.id, attr: { title: row.id } });
    nameCell.createSpan({
      cls: "aios-system-skill-origin-badge aios-system-skill-origin-" + row.origin,
      text: SYSTEM_SKILL_ORIGIN_LABELS[row.origin],
    });
    if (row.disableModelInvocation) {
      nameCell.createSpan({ cls: "aios-usage-table-name-suffix", text: "(slash-only)" });
    }

    tr.createEl("td", { text: row.costUsd == null ? "–" : formatUsd(row.costUsd) });
    tr.createEl("td", { text: row.runs == null ? "–" : formatCompactNumber(row.runs) });
    tr.createEl("td", { cls: "aios-system-skills-desc", text: row.description });

    const usedByCell = tr.createEl("td", { cls: "aios-system-skills-usedby" });
    renderSystemSkillUsedByCell(app, usedByCell, row.usedBy);

    tr.createEl("td", { text: row.avgCostUsd == null ? "–" : formatUsd(row.avgCostUsd) });
  }
}

// One generic-suite group (e.g. "gsd-*, 65 skills"): collapsed by default,
// expands in place on click. Expand state lives in
// viewState.systemSkillsExpandedGroups (the user's own manual choices) so
// it survives the filter-triggered redraws below, but the actual open/
// closed decision routes through the pure systemSkillsGroupIsOpen (Reviewer
// M6, 2026-08-04): while a filter is active every surviving group (it only
// survives if it contains a match) renders open regardless of the manual
// set, and the manual set itself is never written to by the filter -- only
// by an explicit click on this button -- so clearing the filter always
// falls straight back to whatever the user had manually expanded before.
function renderSystemSkillsGroup(
  app: App,
  container: HTMLElement,
  viewState: ViewState,
  group: SystemSkillGroup,
  filterActive: boolean,
  redraw: () => void
) {
  const wrap = container.createDiv({ cls: "aios-system-skills-group" });
  const isOpen = systemSkillsGroupIsOpen(group.suite, viewState.systemSkillsExpandedGroups, filterActive);

  const head = wrap.createEl("button", {
    cls: "aios-system-skills-group-head" + (isOpen ? " aios-system-skills-group-open" : ""),
  });
  head.createSpan({
    cls: "aios-system-skills-group-label",
    text: `${group.suite}${group.separator}* (${group.count} skill${group.count === 1 ? "" : "s"})`,
  });
  head.createSpan({ cls: "aios-system-skills-group-toggle", text: isOpen ? "Hide" : "Show" });
  head.addEventListener("click", () => {
    // Toggles the MANUAL set regardless of why the group is currently open
    // (own choice or filter-forced); systemSkillsGroupIsOpen recomputes the
    // actual render decision from this set plus the current filter state on
    // the next redraw.
    if (viewState.systemSkillsExpandedGroups.has(group.suite)) {
      viewState.systemSkillsExpandedGroups.delete(group.suite);
    } else {
      viewState.systemSkillsExpandedGroups.add(group.suite);
    }
    redraw();
  });

  if (isOpen) renderSystemSkillsTable(app, wrap, group.rows);
}

function renderSystemSkillsView(
  app: App,
  container: HTMLElement,
  viewState: ViewState,
  view: SystemSkillsView,
  redraw: () => void
) {
  if (view.totalCount === 0) {
    renderEmptyState(
      container,
      "No skills yet. The exporter runs at session start, or run: node Operations/scripts/export-ops-map.mjs"
    );
    return;
  }
  if (view.filteredCount === 0) {
    renderEmptyState(container, `No skills match "${viewState.systemSkillsFilter}".`);
    return;
  }

  container.createDiv({
    cls: "aios-system-skills-count",
    text: `${view.filteredCount} of ${view.totalCount} skill${view.totalCount === 1 ? "" : "s"}`,
  });

  if (view.standalone.length > 0) renderSystemSkillsTable(app, container, view.standalone);
  for (const group of view.groups) {
    renderSystemSkillsGroup(app, container, viewState, group, view.filterActive, redraw);
  }
}

// Skills section: owns its own container and redraws itself in place on
// filter input or group toggle (same self-contained-redraw pattern as
// renderUsageSkillsSection above, but for a different container/state).
function renderSystemSkillsSection(
  app: App,
  container: HTMLElement,
  viewState: ViewState,
  manifest: OpsMapManifest,
  stats: UsageStats | null
) {
  const section = container.createDiv({ cls: "aios-system-section" });
  const headRow = section.createDiv({ cls: "aios-system-section-head" });
  headRow.createDiv({ cls: "aios-section-eyebrow", text: "Skills" });
  // Reviewer M5 (2026-08-04): Cost/Runs were bare numbers under headers that
  // gave no indication of the window they cover, easy to mistake for the
  // Usage tab's own range-scoped numbers. usage-stats.json's own windowDays
  // is the honest caption -- these are NOT range-scoped like the Usage tab,
  // they are simply "everything the exporter's fixed window covers".
  if (stats && typeof stats.windowDays === "number") {
    headRow.createDiv({
      cls: "aios-system-skills-usage-caption",
      text: `usage: last ${stats.windowDays} day${stats.windowDays === 1 ? "" : "s"}`,
    });
  }

  const filterWrap = section.createDiv({ cls: "aios-system-skills-filter" });
  const input = filterWrap.createEl("input", {
    cls: "aios-system-skills-filter-input",
    attr: { type: "text", placeholder: "Filter by name, description, or used by…" },
  });
  input.value = viewState.systemSkillsFilter;

  const tableHost = section.createDiv({ cls: "aios-system-skills-body" });

  const redraw = () => {
    tableHost.empty();
    const view: SystemSkillsView = computeSystemSkillsView(manifest, stats, viewState.systemSkillsFilter);
    renderSystemSkillsView(app, tableHost, viewState, view, redraw);
  };

  input.addEventListener("input", () => {
    viewState.systemSkillsFilter = input.value;
    redraw();
  });

  redraw();
}

// ---------------------------------------------------------------------------
// System tab: Agents section (Phase 3, 2026-08-05). One row per roster
// agent (ops-map's type:"agent" nodes): name, model, one-line role,
// clickable contract link, what it's wired to (workflows/SOPs/skills its
// contract references, clickable where a vault path exists), and usage
// (cost/runs) joined from usage-stats.json's `agents` array where the
// roster name matches a transcript agent type -- dashes where unknown, same
// convention as the Skills section above. Followed by an "Available hires"
// subsection (SOP-001 reference patterns not currently hired).
// ---------------------------------------------------------------------------

interface SystemAgentWiredRow {
  id: string;
  label: string;
  path?: string;
}

interface SystemAgentWiredTo {
  workflows: SystemAgentWiredRow[];
  sops: SystemAgentWiredRow[];
  skills: SystemAgentWiredRow[];
}

interface SystemAgentRow {
  id: string;
  label: string;
  model: string | null;
  description: string;
  path?: string;
  wiredTo: SystemAgentWiredTo;
  costUsd: number | null;
  runs: number | null;
  avgCostUsd: number | null;
}

// Dispatch escalation (2026-08-05): a usage-stats.agents entry with no
// matching roster agent node -- general-purpose, Explore, workflow-subagent,
// Plan, seo-*, claude-code-guide, the exporter's UNKNOWN_AGENT_TYPE fallback,
// and any future non-roster subagent_type. Real spend, no contract behind it.
interface SystemGenericSubagentRow {
  id: string;
  label: string;
  costUsd: number;
  runs: number;
  avgCostUsd: number;
}

interface SystemAgentsView {
  totalCount: number;
  rows: SystemAgentRow[];
  genericSubagents: SystemGenericSubagentRow[];
  genericSubagentsCostUsd: number;
}

// Flattens the three wired-to buckets into one ordered list (workflows,
// then SOPs, then skills) for the shared used-by-style cell renderer.
// SystemAgentWiredRow and SystemSkillUsedByRow are structurally identical
// ({id, label, path?}), so renderSystemSkillUsedByCell renders these too --
// no duplicate cell-renderer needed for a second table.
function flattenAgentWiredTo(wiredTo: SystemAgentWiredTo): SystemSkillUsedByRow[] {
  return [...wiredTo.workflows, ...wiredTo.sops, ...wiredTo.skills];
}

function renderSystemAgentsTable(app: App, container: HTMLElement, rows: SystemAgentRow[]) {
  const headers = ["Agent", "Cost", "Runs", "Description", "Wired to", "Avg/run"];

  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", {
    cls: "aios-usage-table aios-usage-breakdown-table aios-system-skills-table aios-system-agents-table",
  });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of headers) headRow.createEl("th", { text: h });

  const tbody = el.createEl("tbody");
  for (const row of rows) {
    const tr = tbody.createEl("tr");

    const nameCell = tr.createEl("td", { cls: "aios-usage-table-name" });
    if (row.path) {
      const link = nameCell.createEl("a", {
        text: row.label,
        cls: "aios-system-skill-usedby-link aios-system-agent-name-link aios-usage-table-name-text",
        href: "#",
        attr: { title: row.label },
      });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        app.workspace.openLinkText(row.path as string, "", false);
      });
    } else {
      nameCell.createSpan({
        cls: "aios-system-agent-name aios-usage-table-name-text",
        text: row.label,
        attr: { title: row.label },
      });
    }
    nameCell.createSpan({
      cls: "aios-system-skill-origin-badge aios-system-agent-model-badge",
      text: row.model || "no model set",
    });

    tr.createEl("td", { text: row.costUsd == null ? "–" : formatUsd(row.costUsd) });
    tr.createEl("td", { text: row.runs == null ? "–" : formatCompactNumber(row.runs) });
    tr.createEl("td", { cls: "aios-system-skills-desc", text: row.description });

    const wiredCell = tr.createEl("td", { cls: "aios-system-skills-usedby" });
    renderSystemSkillUsedByCell(app, wiredCell, flattenAgentWiredTo(row.wiredTo));

    tr.createEl("td", { text: row.avgCostUsd == null ? "–" : formatUsd(row.avgCostUsd) });
  }
}

// "Generic subagents" (Dispatch escalation, 2026-08-05): visually distinct
// from the roster table -- no name links, no model badge, no wired-to
// column (there's no contract to link) -- so it reads as "real spend, not a
// specialist" rather than an incomplete roster row. Reuses the same
// breakdown-table column grid (Cost/Runs/Avg-per-run line up with every
// other table on the page) via the shared padded-columns helper.
function renderSystemGenericSubagentsTable(container: HTMLElement, rows: SystemGenericSubagentRow[]) {
  renderUsageBreakdownTable(
    container,
    ["Subagent type", "Cost", "Runs", "", "", "Avg/run"],
    rows.map((row) => ({
      nameText: row.label,
      cells: [formatUsd(row.costUsd), formatCompactNumber(row.runs), "", "", formatUsd(row.avgCostUsd)],
    }))
  );
}

// "Available hires": SOP-001 reference patterns not currently on the
// roster. Add/delete is a request, not a button (per the task spec's
// design direction) -- each row states the sentence to say, it never
// mutates anything itself.
function renderSystemAvailableHires(app: App, container: HTMLElement, manifest: OpsMapManifest) {
  const view = computeAvailableHiresView(manifest);
  const section = container.createDiv({ cls: "aios-system-section aios-system-available-hires" });
  section.createDiv({ cls: "aios-section-eyebrow", text: "Available hires" });

  const openSop = (ev: MouseEvent) => {
    ev.preventDefault();
    if (view.sopPath) app.workspace.openLinkText(view.sopPath, "", false);
  };

  if (!view.found || view.items.length === 0) {
    const fallback = section.createDiv({ cls: "aios-system-available-hires-fallback" });
    fallback.createSpan({ text: "No catalog of not-yet-hired roster patterns is parseable right now. See " });
    const link = fallback.createEl("a", { text: view.sopId, href: "#" });
    link.addEventListener("click", openSop);
    fallback.createSpan({ text: " and ask Dispatch to hire via Recruit." });
    return;
  }

  const list = section.createDiv({ cls: "aios-system-available-hires-list" });
  for (const item of view.items) {
    const row = list.createDiv({ cls: "aios-system-available-hires-item" });
    row.createSpan({ cls: "aios-system-available-hires-label", text: item.label });
    if (item.description) {
      row.createSpan({ cls: "aios-system-available-hires-desc", text: " " + item.description });
    }
    row.createSpan({ cls: "aios-system-available-hires-ask", text: " Not hired here; ask Dispatch to hire via Recruit." });
  }
}

function renderSystemAgentsSection(
  app: App,
  container: HTMLElement,
  manifest: OpsMapManifest,
  stats: UsageStats | null
) {
  const section = container.createDiv({ cls: "aios-system-section" });
  const headRow = section.createDiv({ cls: "aios-system-section-head" });
  headRow.createDiv({ cls: "aios-section-eyebrow", text: "Agents" });
  // Same honest-window caption convention as the Skills section: usage here
  // is NOT range-scoped, it is everything the exporter's fixed window covers.
  if (stats && typeof stats.windowDays === "number") {
    headRow.createDiv({
      cls: "aios-system-skills-usage-caption",
      text: `usage: last ${stats.windowDays} day${stats.windowDays === 1 ? "" : "s"}`,
    });
  }

  const view: SystemAgentsView = computeSystemAgentsView(manifest, stats);
  if (view.totalCount === 0) {
    renderEmptyState(
      section,
      "No agents yet. The exporter runs at session start, or run: node Operations/scripts/export-ops-map.mjs"
    );
  } else {
    section.createDiv({
      cls: "aios-system-skills-count",
      text: `${view.totalCount} hired agent${view.totalCount === 1 ? "" : "s"}`,
    });
    renderSystemAgentsTable(app, section, view.rows);
  }

  // "Generic subagents" (Dispatch escalation, 2026-08-05): non-roster
  // subagent spend (general-purpose, Explore, workflow-subagent, Plan,
  // seo-*, claude-code-guide, ...) is often the MAJORITY of delegated
  // dollars -- rendering it below the roster, visually distinct (no
  // contract link, no model badge), keeps the section's totals honest
  // instead of implying the 8 roster agents are the whole story.
  if (view.genericSubagents.length > 0) {
    const genericSection = container.createDiv({
      cls: "aios-system-section aios-system-generic-subagents",
    });
    const genericHead = genericSection.createDiv({ cls: "aios-system-section-head" });
    genericHead.createDiv({ cls: "aios-section-eyebrow", text: "Generic subagents" });
    genericHead.createDiv({
      cls: "aios-system-skills-usage-caption",
      text: `${formatUsd(view.genericSubagentsCostUsd)} total, no specialist contract behind these`,
    });
    genericSection.createDiv({
      cls: "aios-system-generic-subagents-note",
      text: "Not part of the hired roster -- real spend from generic Task-tool dispatches (subagent_type not matched to a specialist).",
    });
    renderSystemGenericSubagentsTable(genericSection, view.genericSubagents);
  }

  renderSystemAvailableHires(app, container, manifest);
}

// ---------------------------------------------------------------------------
// System tab: Workflows & SOPs sub-tab (header/tabs restructure, 2026-08).
// Two tables (Workflows, SOPs) built from ops-map's own workflow/sop nodes
// plus their incoming edges -- "what references them". Firing counts (how
// many sessions actually used each) are phase 4 and deliberately NOT
// rendered here; no column is faked in its place.
// ---------------------------------------------------------------------------

interface SystemWorkflowSopRow {
  id: string;
  label: string;
  path?: string;
  referencedBy: SystemSkillUsedByRow[];
}

interface SystemWorkflowsSopsView {
  workflows: SystemWorkflowSopRow[];
  sops: SystemWorkflowSopRow[];
}

function renderSystemWorkflowSopTable(
  app: App,
  container: HTMLElement,
  nameHeader: string,
  rows: SystemWorkflowSopRow[]
) {
  if (rows.length === 0) {
    renderEmptyState(container, "None found.");
    return;
  }
  const wrap = container.createDiv({ cls: "aios-usage-table-wrap" });
  const el = wrap.createEl("table", {
    cls: "aios-usage-table aios-usage-breakdown-table aios-system-skills-table",
  });
  const thead = el.createEl("thead");
  const headRow = thead.createEl("tr");
  for (const h of [nameHeader, "Referenced by"]) headRow.createEl("th", { text: h });

  const tbody = el.createEl("tbody");
  for (const row of rows) {
    const tr = tbody.createEl("tr");
    const nameCell = tr.createEl("td", { cls: "aios-usage-table-name" });
    if (row.path) {
      const link = nameCell.createEl("a", {
        text: row.label,
        cls: "aios-system-skill-usedby-link aios-usage-table-name-text",
        href: "#",
        attr: { title: row.label },
      });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        app.workspace.openLinkText(row.path as string, "", false);
      });
    } else {
      nameCell.createSpan({ cls: "aios-usage-table-name-text", text: row.label, attr: { title: row.label } });
    }
    const refCell = tr.createEl("td", { cls: "aios-system-skills-usedby" });
    renderSystemSkillUsedByCell(app, refCell, row.referencedBy);
  }
}

function renderSystemWorkflowsSopsSection(app: App, container: HTMLElement, manifest: OpsMapManifest) {
  const view: SystemWorkflowsSopsView = computeSystemWorkflowsSopsView(manifest);

  const wfSection = container.createDiv({ cls: "aios-system-section" });
  wfSection.createDiv({ cls: "aios-section-eyebrow", text: "Workflows" });
  renderSystemWorkflowSopTable(app, wfSection, "Workflow", view.workflows);

  const sopSection = container.createDiv({ cls: "aios-system-section" });
  sopSection.createDiv({ cls: "aios-section-eyebrow", text: "SOPs" });
  renderSystemWorkflowSopTable(app, sopSection, "SOP", view.sops);
}

// System tab sub-tabs (header/tabs restructure, 2026-08): a scrollable
// single-page list of Skills + Agents + Workflows & SOPs (150+ skills, a
// full roster table, and now two more tables) was too much to scroll
// through to reach any one section, so the tab now has its own
// second-level nav. Order matches the task spec: Agents, Skills,
// Workflows & SOPs.
const SYSTEM_SUBTABS: { id: ViewState["systemActiveSubTab"]; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "skills", label: "Skills" },
  { id: "workflows", label: "Workflows & SOPs" },
];

// System tab: async load (ops-map + usage-stats, both already-loaded shapes
// via the existing loaders) + render. Renders a hint when ops-map.json has
// not been generated yet, same convention as the Ops map tab.
function renderSystemTab(
  app: App,
  container: HTMLElement,
  settings: AiosDashboardSettings,
  viewState: ViewState
) {
  const wrap = container.createDiv({ cls: "aios-system-tab" });
  wrap.createDiv({ cls: "aios-empty", text: "Loading system map..." });
  Promise.all([loadOpsMap(app, settings.opsMapPath), loadUsageStats(app, settings.usageStatsPath)]).then(
    ([manifest, stats]) => {
      wrap.empty();
      if (!manifest) {
        renderEmptyState(
          wrap,
          "No system data yet. The exporter runs at session start, or run: node Operations/scripts/export-ops-map.mjs"
        );
        return;
      }

      const subtabs = wrap.createDiv({ cls: "aios-system-subtabs" });
      const subtabButtons: { id: ViewState["systemActiveSubTab"]; el: HTMLElement }[] = [];
      for (const t of SYSTEM_SUBTABS) {
        const btn = subtabs.createEl("button", { cls: "aios-system-subtab", text: t.label });
        subtabButtons.push({ id: t.id, el: btn });
        btn.addEventListener("click", () => {
          if (viewState.systemActiveSubTab === t.id) return;
          viewState.systemActiveSubTab = t.id;
          redraw();
        });
      }

      const sectionsHost = wrap.createDiv({ cls: "aios-system-tab-sections" });

      function redraw() {
        for (const b of subtabButtons) {
          b.el.toggleClass("aios-system-subtab-active", b.id === viewState.systemActiveSubTab);
        }
        sectionsHost.empty();
        if (viewState.systemActiveSubTab === "skills") {
          renderSystemSkillsSection(app, sectionsHost, viewState, manifest, stats);
        } else if (viewState.systemActiveSubTab === "workflows") {
          renderSystemWorkflowsSopsSection(app, sectionsHost, manifest);
        } else {
          // Agents section (Phase 3, 2026-08-05): roster cards + usage +
          // wired-to, plus the "Available hires" subsection.
          renderSystemAgentsSection(app, sectionsHost, manifest, stats);
        }
      }

      redraw();
    }
  );
}

function renderDashboard(
  app: App,
  root: HTMLElement,
  refresh: () => void,
  viewState: ViewState,
  settings: AiosDashboardSettings,
  plugin: AiosDashboardPlugin,
  isLeafView: boolean,
  sourcePath?: string
) {
  // Capture BEFORE the wipe: if a coordination answer textarea has focus,
  // its key + cursor position are restored once the async coordination
  // gather (renderProjectsTab, Projects tab) recreates it. Every re-render
  // destroys and recreates the whole DOM tree 200ms after any vault change,
  // including the save this input's own submit just made.
  const coordFocus = captureCoordinationFocus(root);
  root.empty();
  root.addClass("aios-dashboard-root");
  const undoCtx: UndoCtx = { plugin, isLeafView };

  // Incidents strip: the single highest-priority thing on the page when it
  // exists, so it renders first, above even the fixed chrome. Renders
  // nothing when there are zero open incidents.
  renderIncidentsStrip(app, root, gatherIncidents(app, settings), settings);

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

  // Health tiles are computed unconditionally (not gated on showHealthStrip)
  // so the Today tab's intake-backlog stat and the app-bar systems status
  // share the same source of truth.
  const healthInput = gatherHealthInput(app, settings, tasks, projects);
  const healthTiles = computeHealth(healthInput);

  // ----- Fixed chrome (header/tabs restructure, 2026-08): tab bar + (on the
  // Usage tab) the period bar, a normal-flow, non-scrolling flex column above
  // .aios-scroll. The app bar is built here for its wiring but is moved into
  // .aios-scroll below (owner call 2026-08-05: only tabs + period bar stay
  // pinned; the title row scrolls away, cutting fixed chrome by 61px). See
  // the .aios-dashboard-root CSS comment for why this replaces
  // position:sticky. -----
  const chrome = root.createDiv({ cls: "aios-chrome" });

  // ----- App bar (slim single row; build 2.8) -----
  const header = chrome.createDiv({ cls: "aios-header" });
  header.createDiv({ cls: "aios-app-mark" });
  const titleBlock = header.createDiv({ cls: "aios-title-block" });
  titleBlock.createEl("h1", { text: settings.headerTitle });
  titleBlock.createDiv({ cls: "aios-eyebrow", text: "OPERATIONS CONSOLE" });
  const stat = header.createDiv({ cls: "aios-stat" });
  const activeCount = projects.filter((p) => p.status === "active").length;
  stat.setText(`${openTasks.length} open · ${activeCount} active`);
  header.createDiv({ cls: "aios-header-spacer" });

  const actions = header.createDiv({ cls: "aios-header-actions" });

  // Systems status: one dot + summary text; opens the right-side drawer.
  // Health issues are known synchronously; automation errors arrive async
  // and update the same control in place. Respects showHealthStrip (a user
  // who hid health reporting is not nagged about it in the app bar either).
  const sysBtn = actions.createEl("button", { cls: "aios-sys-status" });
  sysBtn.setAttr("aria-label", "Systems status");
  sysBtn.createSpan({ cls: "aios-sys-dot" });
  const sysLabel = sysBtn.createSpan({ cls: "aios-sys-label", text: "systems ok" });
  const healthIssueCount = settings.showHealthStrip
    ? healthTiles.filter((t) => t.warn).length
    : 0;
  const applySysStatus = (autoIssues: number) => {
    const n = healthIssueCount + autoIssues;
    sysBtn.toggleClass("aios-sys-status-issues", n > 0);
    sysLabel.setText(n > 0 ? `${n} issue${n === 1 ? "" : "s"}` : "systems ok");
  };
  applySysStatus(0);
  loadAutomationHealth(app, settings.automationHealthPath).then((health) => {
    if (!health) return;
    const view: AutomationView = computeAutomationView(health, new Date());
    applySysStatus((view.counts.error || 0) + (view.counts.unknown || 0));
  });
  sysBtn.addEventListener("click", () => {
    viewState.systemsOpen = !viewState.systemsOpen;
    refresh();
  });

  const refreshBtn = actions.createEl("button", { cls: "aios-refresh aios-icon-btn" });
  refreshBtn.setAttr("aria-label", "Refresh");
  setIcon(refreshBtn, "rotate-cw");
  refreshBtn.addEventListener("click", () => refresh());

  if (settings.actionsEnabled && Platform.isDesktop) {
    const askBtn = actions.createEl("button", { cls: "aios-ask-dispatch" });
    const askIcon = askBtn.createSpan({ cls: "aios-ask-dispatch-icon" });
    setIcon(askIcon, "sparkles");
    askBtn.createSpan({ text: "Ask Dispatch" });
    askBtn.addEventListener("click", () => {
      const base = getVaultBasePath(app);
      if (!base) return;
      launchDispatch(settings, base, null);
    });
  }

  // ----- Systems drawer (replaces the always-on health + automations strips) -----
  if (viewState.systemsOpen) {
    const drawer = root.createDiv({ cls: "aios-drawer" });
    drawer.setAttr("tabindex", "-1");
    const dHead = drawer.createDiv({ cls: "aios-drawer-head" });
    dHead.createDiv({ cls: "aios-drawer-title", text: "Systems" });
    const closeBtn = dHead.createEl("button", { cls: "aios-icon-btn aios-drawer-close" });
    closeBtn.setAttr("aria-label", "Close systems panel");
    setIcon(closeBtn, "x");
    const closeDrawer = () => {
      viewState.systemsOpen = false;
      refresh();
    };
    closeBtn.addEventListener("click", closeDrawer);
    drawer.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeDrawer();
    });

    const dBody = drawer.createDiv({ cls: "aios-drawer-body" });
    if (settings.showHealthStrip) {
      if (healthTiles.length === 0) {
        const sec = dBody.createDiv({ cls: "aios-health-section" });
        sec.createDiv({ cls: "aios-section-eyebrow", text: "Systems" });
        renderEmptyState(sec, "All systems healthy.");
      } else {
        renderHealthStrip(app, dBody, healthTiles, settings);
      }
    }
    renderAutomationSection(app, dBody, settings);

    // Focus for Escape-to-close, but never steal focus from an input the
    // user is typing in when a live vault change re-renders the dashboard.
    // document.activeElement reads document.body here (root.empty() already
    // ran above), so the guard alone can't see a coordination answer input
    // that was focused a moment ago -- coordFocus (captured BEFORE the wipe,
    // same function scope) is the only thing that still knows. Without this,
    // every live re-render while the drawer is open would yank focus out of
    // a half-typed answer via this setTimeout, which fires after the async
    // coordination restore (Reviewer Major 1).
    const active = document.activeElement;
    if ((!active || active === document.body) && !coordFocus) {
      window.setTimeout(() => drawer.focus(), 0);
    }
  }

  // ----- Tab bar (segmented nav) -----
  const tabs = chrome.createDiv({ cls: "aios-tabs" });
  const TAB_ICONS: Record<string, { primary: string; fallback?: string }> = {
    today: { primary: "sun" },
    projects: { primary: "folder-kanban" },
    tasks: { primary: "list-checks" },
    usage: { primary: "chart-column", fallback: "bar-chart-3" },
    opsmap: { primary: "waypoints", fallback: "git-fork" },
    system: { primary: "layers", fallback: "layout-list" },
  };
  const mkTab = (id: "today" | "projects" | "tasks" | "usage" | "opsmap" | "system", label: string) => {
    const t = tabs.createEl("button", {
      cls: "aios-tab" + (viewState.activeTab === id ? " aios-tab-active" : ""),
    });
    const icon = TAB_ICONS[id];
    const iconEl = t.createSpan({ cls: "aios-tab-icon" });
    setIconWithFallback(iconEl, icon.primary, icon.fallback);
    t.createSpan({ cls: "aios-tab-label", text: label });
    t.addEventListener("click", () => {
      viewState.activeTab = id;
      refresh();
    });
  };
  mkTab("today", "Today");
  mkTab("projects", "Projects");
  mkTab("tasks", "Tasks");
  mkTab("usage", "Usage");
  mkTab("opsmap", "Ops map");
  mkTab("system", "System");

  // The Usage tab's period bar lives in the fixed chrome, below the tab bar
  // -- only created when Usage is the active tab, so no empty host lingers
  // in the chrome for every other tab.
  const usagePeriodbarHost =
    viewState.activeTab === "usage" ? chrome.createDiv({ cls: "aios-usage-periodbar-host" }) : undefined;

  // ----- Scroll region: the ONLY element with overflow-y:auto. Everything
  // that can grow past the pane's height (a tab's whole body, plus the
  // trailing foot note) lives in here. -----
  const scroll = root.createDiv({ cls: "aios-scroll" });

  // Scroll position survives everything (owner feedback 2026-08-30). Every
  // interaction on this dashboard -- a tab click, a filter/status chip, a
  // toggle, the 200ms live-vault-change refresh -- calls this function,
  // which root.empty()s and rebuilds .aios-scroll from scratch, so a brand
  // new element with scrollTop 0 replaces the old one every time. A passive
  // listener on THIS render's scroll element writes the live position into
  // viewState.scrollTops (keyed by tab) continuously as the user scrolls;
  // the restore at the end of this function reads it back for whichever
  // tab is active NOW. Attached fresh every render (the old element and its
  // listener are gone with it), so there is never more than one listener
  // alive, and it always reflects the CURRENT viewState.activeTab at the
  // moment it fires, not a value captured at attach time.
  scroll.addEventListener(
    "scroll",
    () => {
      viewState.scrollTops.set(viewState.activeTab, scroll.scrollTop);
    },
    { passive: true }
  );

  // App bar scrolls with content (see chrome comment above).
  scroll.appendChild(header);

  // ----- Tab body -----
  const body = scroll.createDiv({ cls: "aios-tab-body" });
  if (viewState.activeTab === "today") {
    renderTodayTab(app, body, settings, settings.tasksRoot, tasks, healthTiles, refresh, undoCtx);
  } else if (viewState.activeTab === "tasks") {
    renderTasksTab(app, settings.tasksRoot, body, tasks, buckets, viewState, refresh, undoCtx);
  } else if (viewState.activeTab === "usage") {
    renderUsageTab(app, body, usagePeriodbarHost as HTMLElement, settings, viewState);
  } else if (viewState.activeTab === "system") {
    renderSystemTab(app, body, settings, viewState);
  } else if (viewState.activeTab === "opsmap") {
    renderOpsMapTab(app, body, settings);
  } else {
    renderProjectsTab(app, settings.tasksRoot, body, projects, tasks, viewState, refresh, hostFm, undoCtx, settings, coordFocus);
  }

  scroll.createDiv({ cls: "aios-foot" }).setText(
    "Live view, computed from Operations/tasks and Projects. Progress bars are calculated from task completion - nothing is hand-entered."
  );

  // Restore scroll position: the end of the synchronous render, 0 when this
  // tab has no saved position yet (first render, or a tab never scrolled).
  // Deliberately independent of focus -- unlike coordFocus/drawer.focus()
  // above, this runs unconditionally on every render, whether or not
  // anything was focused, and does not read document.activeElement at all.
  // Deliberately NOT re-applied after the async coordination gather or
  // Usage-tab load grows content later: the brief is explicit that the
  // held pixel offset at restore time is the correct behavior, not a
  // second restore chasing content that arrives after the fact.
  scroll.scrollTop = viewState.scrollTops.get(viewState.activeTab) ?? 0;
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
    // Cmd+Z (Ctrl+Z on Windows/Linux, "Mod" is Obsidian's cross-platform
    // modifier) undoes the dashboard's last mutation, but ONLY while this
    // view is the active leaf -- View.scope is pushed as the active keymap
    // scope by the workspace automatically on focus and popped on blur, so
    // this never steals Cmd+Z from an editor or another pane. It also bails
    // out (returns true / does not preventDefault) when the keypress landed
    // on the dashboard's own text inputs or a contenteditable region (quick
    // capture, the System > Skills filter, ...): those have native undo of
    // their own, and swallowing it there both breaks typing AND can revert
    // an unrelated vault mutation (Reviewer M1).
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (isEditableEventTarget(target?.tagName ?? null, !!target?.isContentEditable)) {
        return true;
      }
      evt.preventDefault();
      void this.handleUndo();
      return false;
    });
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
    renderDashboard(this.app, container, () => this.render(), this.viewState, this.plugin.settings, this.plugin, true);
  }

  async handleUndo() {
    await undoLastMutation(this.plugin);
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
      .setName("Incidents folder")
      .setDesc(
        "Folder scanned for open-incident notes (frontmatter status: open) surfaced in the Urgent strip at the top of the dashboard."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.incidentsFolder)
          .setValue(this.plugin.settings.incidentsFolder)
          .onChange(async (v) => {
            this.plugin.settings.incidentsFolder = v.trim() || DEFAULT_SETTINGS.incidentsFolder;
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
      .setName("Daily budget (USD)")
      .setDesc(
        "Spend guardrail: warn on the Today and Usage tabs when today's API-equivalent cost exceeds this. 0 = off."
      )
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.dailyBudgetUsd))
          .setValue(String(this.plugin.settings.dailyBudgetUsd))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.dailyBudgetUsd = isNaN(n) ? DEFAULT_SETTINGS.dailyBudgetUsd : n;
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

    new Setting(containerEl)
      .setName("Automation health path")
      .setDesc(
        "Vault-relative path to the exporter's automation-health.json (see node Operations/scripts/export-automation-health.mjs)."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.automationHealthPath)
          .setValue(this.plugin.settings.automationHealthPath)
          .onChange(async (v) => {
            this.plugin.settings.automationHealthPath =
              v.trim() || DEFAULT_SETTINGS.automationHealthPath;
            await save();
          })
      );

    containerEl.createEl("h2", { text: "Ops map" });

    new Setting(containerEl)
      .setName("Ops map path")
      .setDesc(
        "Vault-relative path to the exporter's ops-map.json (see node Operations/scripts/export-ops-map.mjs)."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.opsMapPath)
          .setValue(this.plugin.settings.opsMapPath)
          .onChange(async (v) => {
            this.plugin.settings.opsMapPath = v.trim() || DEFAULT_SETTINGS.opsMapPath;
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
  // Plugin-wide undo history (Reviewer M2): one stack, valid from every open
  // dashboard surface (leaf view + inline embeds), not one per view/root.
  // In-memory only; cleared in onunload.
  undoStack: UndoEntry[] = [];

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

    // Palette/hotkey-remappable counterpart to the toast's "Undo" link and
    // (in the leaf view) the Cmd+Z binding on DashboardView.scope. The
    // stack is plugin-wide, not view-scoped, so this must be reachable
    // regardless of which view is active (a MarkdownView showing the
    // embedded dashboard included, per Reviewer M2) -- gate on the stack
    // having something to undo, not on DashboardView being focused.
    this.addCommand({
      id: "undo-last-dashboard-action",
      name: "AIOS Dashboard: Undo last dashboard action",
      checkCallback: (checking) => {
        if (this.undoStack.length === 0) return false;
        if (!checking) void undoLastMutation(this);
        return true;
      },
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
        this,
        false,
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
    this.undoStack = [];
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
      renderDashboard(this.app, host, () => this.scheduleRefresh(), this.stateFor(host), this.settings, this, false);
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
