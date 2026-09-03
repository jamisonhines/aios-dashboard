// Tests for the Coordination-panel data model: computeCoordinationView (pure).
// Imports the SAME module main.ts bundles (model.mjs). Mirrors the exact
// definitions in Operations/scripts/coordination-report.mjs: active = row
// `state` (the closed-set State column, exact match after
// coordination-parse.mjs's own lowercase/emphasis/punctuation normalization,
// NOT a Status-prose prefix match); stale = active AND
// hoursSince(lastUpdate) > 24; merge queue size = parseLandingOrder items
// where landed is false.
//
// tsk-2026-09-03-002 step 3: the ledger() fixture builder below produces the
// MIGRATED shape (Session id + State + ... + Status columns, matching the
// live Projects/vagabond-ops-app/work-ledger.md post step 1), not the
// pre-restructure Status-only shape. Status is still present (transition-
// window convention -- 25 project folders have not migrated yet, per
// tsk-2026-09-03-001) but is no longer machine-read by this view.
// Run: node coordinationModel.test.mjs
import assert from "node:assert";
import {
  computeCoordinationView,
  isCoordinationQuestionAnswered,
  filterCoordinationQuestions,
  coordinationQuestionFilterCounts,
} from "./model.mjs";

const NOW = new Date("2026-08-29T09:30:00Z");

function ledger(rows, landingLines) {
  return [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "repo: ~/Projects/proj-a",
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Active sessions",
    "",
    "| Session | Session id | State | Branch | Worktree | Write-set | Started | Last update | Status |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Merge queue",
    "",
    "<!-- AUTO:BEGIN branch-inventory -->",
    "(none)",
    "<!-- AUTO:END -->",
    "",
    "### Landing order",
    "",
    ...landingLines,
    "",
  ].join("\n");
}

function questions(entries) {
  return [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "updated: 2026-08-28",
    "---",
    "",
    "# Questions for Jaymo",
    "",
    "## Open",
    "",
    ...entries,
    "## Answered",
    "",
    "(none)",
    "",
  ].join("\n");
}

// --- basic shape: active filtering, stale flagging, unlanded count, questions passthrough ---
{
  const LEDGER = ledger(
    [
      "| coder-build | id-1 | active | feat/x | ~/Projects/proj-a | src/foo.ts | 2026-08-29T08:00:00Z | 2026-08-29T09:00:00Z | **active.** Notes: [[#coder-build]] |",
      "| old-session | id-2 | **Active** | feat/y | ~/Projects/proj-a | src/bar.ts | 2026-08-27T08:00:00Z | 2026-08-27T09:00:00Z | **active.** Notes: [[#old-session]] |",
      "| finished-session | id-3 | done | feat/z | ~/Projects/proj-a | src/baz.ts | 2026-08-26T08:00:00Z | 2026-08-29T08:30:00Z | **done.** Notes: [[#finished-session]] |",
    ],
    ["1. feat/x - landed", "2. feat/y - ready", "3. feat/z - ready"]
  );
  const QUESTIONS = questions([
    "### Q-2026-08-28-01 Answered but unfiled question",
    "- Context: c",
    "- Asked by: s, 2026-08-28",
    "- Answer: yes go ahead",
    "",
    "### Q-2026-08-28-02 Still blank",
    "- Context: c",
    "- Asked by: s, 2026-08-28",
    "- Answer:",
    "",
  ]);

  const views = computeCoordinationView(
    [{ slug: "proj-a", ledgerContent: LEDGER, questionsContent: QUESTIONS }],
    NOW
  );
  assert.equal(views.length, 1, "one input project -> one view");
  const v = views[0];
  assert.equal(v.slug, "proj-a");

  assert.equal(v.activeSessions.length, 2, "'done' State row excluded; both 'active'/'**Active**' State rows included");
  assert.deepEqual(
    v.activeSessions.map((s) => s.session),
    ["coder-build", "old-session"],
    "State match tolerates case AND markdown emphasis (normalizeState lowercases and strips */_/`), source order preserved"
  );
  assert.deepEqual(v.activeSessions[0], {
    session: "coder-build",
    branch: "feat/x",
    lastUpdate: "2026-08-29T09:00:00Z",
    stale: false,
  }, "0.5h since last update -> not stale");
  assert.deepEqual(v.activeSessions[1], {
    session: "old-session",
    branch: "feat/y",
    lastUpdate: "2026-08-27T09:00:00Z",
    stale: true,
  }, "48.5h since last update -> stale");

  assert.equal(v.unlanded, 2, "2 of 3 landing-order items are not landed (item 1 says 'landed')");

  assert.deepEqual(v.questions, [
    { id: "Q-2026-08-28-01", date: "2026-08-28", title: "Answered but unfiled question", context: "c", answer: "yes go ahead" },
    { id: "Q-2026-08-28-02", date: "2026-08-28", title: "Still blank", context: "c", answer: "" },
  ]);

  // tsk-2026-09-03-002 step 5: this is the reference CLEAN ledger for the whole suite -- a
  // full State-column table with no orphans, no invalid rows/states, no intruding headings,
  // and a "## Merge queue" landmark right after it so the accounting control both runs and
  // balances. On a ledger this clean, `untrustworthy` must be false and `warnings` empty, and
  // (critically) the genuinely-48.5h-stale `old-session` row above keeps its `stale: true` --
  // the badge is NOT globally suppressed, only on a ledger that actually earns the suppression.
  assert.equal(v.untrustworthy, false, "no loud channel and a balanced accounting control -> trustworthy");
  assert.deepEqual(v.warnings, [], "a clean ledger produces zero warning lines");
}

// --- context passthrough: distinct per-question values, so a wiring bug
// (e.g. context accidentally echoing answer, or the field being dropped)
// cannot hide behind a coincidental match ---
{
  const LEDGER = ledger([], ["1. feat/x - ready"]);
  const QUESTIONS = questions([
    "### Q-2026-08-30-01 Question with a distinct multi-word context",
    "- Context: the background info goes here, not the answer",
    "- Asked by: s, 2026-08-30",
    "- Answer: the actual answer text, different from context",
    "",
    "### Q-2026-08-30-02 Question with no Context field at all",
    "- Asked by: s, 2026-08-30",
    "- Answer:",
    "",
  ]);
  const views = computeCoordinationView(
    [{ slug: "proj-a", ledgerContent: LEDGER, questionsContent: QUESTIONS }],
    NOW
  );
  const [q1, q2] = views[0].questions;
  assert.equal(q1.context, "the background info goes here, not the answer");
  assert.equal(q1.answer, "the actual answer text, different from context");
  assert.notEqual(q1.context, q1.answer, "context and answer are genuinely different fields, not the same value twice");
  assert.equal(q2.context, "", "absent Context field -> '', not undefined and not a throw");
}

// --- stale boundary: exactly 24h is NOT stale (matches coordination-report.mjs's strict `> 24`) ---
{
  const LEDGER = ledger(
    ["| s1 | id-1 | active | feat/x | wt | file.ts | 2026-08-28T09:30:00Z | 2026-08-28T09:30:00Z | **active.** |"],
    ["1. feat/x - ready"]
  );
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.equal(views[0].activeSessions[0].stale, false, "exactly 24h since last update is not > 24, so not stale");
}
{
  const LEDGER = ledger(
    ["| s1 | id-1 | active | feat/x | wt | file.ts | 2026-08-28T09:29:59Z | 2026-08-28T09:29:59Z | **active.** |"],
    ["1. feat/x - ready"]
  );
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.equal(views[0].activeSessions[0].stale, true, "24h and 1 second since last update IS stale");
}

// --- questionsContent missing or null -> empty questions, no throw ---
{
  const LEDGER = ledger([], ["1. feat/x - ready"]);
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.deepEqual(views[0].questions, [], "null questionsContent -> no questions, not an error");
  const views2 = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER }], NOW);
  assert.deepEqual(views2[0].questions, [], "missing questionsContent key -> no questions, not an error");
}

// --- no active sessions, no landing order -> zeroed, not throw ---
{
  const LEDGER = ledger([], []);
  const views = computeCoordinationView([{ slug: "p", ledgerContent: LEDGER, questionsContent: null }], NOW);
  assert.deepEqual(views[0].activeSessions, []);
  assert.equal(views[0].unlanded, 0);
}

// --- multiple projects: one view per input, in input order ---
{
  const LEDGER = ledger([], []);
  const views = computeCoordinationView(
    [
      { slug: "proj-b", ledgerContent: LEDGER, questionsContent: null },
      { slug: "proj-a", ledgerContent: LEDGER, questionsContent: null },
    ],
    NOW
  );
  assert.deepEqual(views.map((v) => v.slug), ["proj-b", "proj-a"], "input order is preserved, not re-sorted");
}

// --- empty inputs -> empty output ---
assert.deepEqual(computeCoordinationView([], NOW), [], "no participating projects -> no views");

// --- isCoordinationQuestionAnswered / filterCoordinationQuestions /
// coordinationQuestionFilterCounts: the filter-chip data model, owner
// feedback 2026-08-30 ("lets put a filtered tab (answered, unanswered,
// all) next to Open Questions"). Same shared predicate the "answered" pill
// uses in main.ts (renderCoordinationQuestion calls this function instead
// of repeating .trim().length > 0), so the pill and the filter chips can
// never disagree. ---

const Q_ANSWERED = { id: "Q-1", date: "2026-08-30", title: "t1", context: "", answer: "yes go ahead" };
const Q_BLANK = { id: "Q-2", date: "2026-08-30", title: "t2", context: "", answer: "" };
// Boundary case: a whitespace-only answer (the file literally has
// "- Answer:    ") must count as UNANSWERED, matching the pill's
// .trim().length > 0 semantics exactly, not merely "answer !== ''".
const Q_WHITESPACE = { id: "Q-3", date: "2026-08-30", title: "t3", context: "", answer: "   \t  " };

assert.equal(isCoordinationQuestionAnswered(Q_ANSWERED), true, "non-empty trimmed answer -> answered");
assert.equal(isCoordinationQuestionAnswered(Q_BLANK), false, "empty answer -> unanswered");
assert.equal(
  isCoordinationQuestionAnswered(Q_WHITESPACE),
  false,
  "whitespace-only answer -> unanswered (matches the answered-pill's .trim() semantics)"
);

const MIXED = [Q_ANSWERED, Q_BLANK, Q_WHITESPACE];

assert.deepEqual(
  filterCoordinationQuestions(MIXED, "answered").map((q) => q.id),
  ["Q-1"],
  "'answered' filter keeps only the trimmed-non-empty answer"
);
assert.deepEqual(
  filterCoordinationQuestions(MIXED, "unanswered").map((q) => q.id),
  ["Q-2", "Q-3"],
  "'unanswered' filter includes both the blank AND the whitespace-only answer"
);
assert.deepEqual(
  filterCoordinationQuestions(MIXED, "all").map((q) => q.id),
  ["Q-1", "Q-2", "Q-3"],
  "'all' filter returns every question, input order preserved"
);
assert.deepEqual(filterCoordinationQuestions([], "all"), [], "empty input -> empty output, no throw");
assert.notEqual(
  filterCoordinationQuestions(MIXED, "all"),
  MIXED,
  "'all' returns a new array (slice), not the same reference"
);

assert.deepEqual(
  coordinationQuestionFilterCounts(MIXED),
  { unanswered: 2, answered: 1, all: 3 },
  "counts match the filtered lengths exactly, including the whitespace-only boundary case"
);
assert.deepEqual(
  coordinationQuestionFilterCounts([]),
  { unanswered: 0, answered: 0, all: 0 },
  "empty input -> zeroed counts, no throw"
);

// =====================================================================
// tsk-2026-09-03-002 step 5: the untrustworthy-parse verdict
// (computeCoordinationView wiring coordination-accounting.mjs's
// checkActiveSessionsAccounting / findStrayClaimRows / describeActiveSessionsWarnings /
// staleClearSuspensionNotice). Fixtures and assertion text below deliberately mirror
// ~/AIOS/Operations/scripts/tests/coordination-report.test.mjs's own isolated-channel
// fixtures (H8/S8/ROW pattern, customLedger/makeCustomVault shape) so a warning line
// reads identically whether it came from the CLI report or this panel -- the whole point
// of both consumers sharing describeActiveSessionsWarnings. Per the task brief: inline
// fixtures only, never the live vault ledger; the frozen snapshot fixture is a separate,
// older 9-column shape and is not used here on purpose (these fixtures use the CURRENT
// 8-column, State-only shape, Status dropped).
// =====================================================================

const H8 = "| Session | Session id | State | Branch | Worktree | Write-set | Started | Last update |";
const S8 = "|---|---|---|---|---|---|---|---|";
// lastUpdate defaults to 0.5h before NOW (fresh); pass an explicit ISO string to control
// staleness. Started is fixed and irrelevant to every assertion below.
const ROW8 = (n, st, lastUpdate = "2026-08-29T09:00:00Z") =>
  `| ${n} | id-${n} | ${st} | feat/${n} | ~/Projects/proj-a | src/${n}.ts | 2026-08-27T08:00:00Z | ${lastUpdate} |`;

// activeSessionsLines: the raw lines directly under "## Active sessions" (header,
// separator, rows, and any glued-in prose/headings under test), mirroring
// coordination-report.test.mjs's makeCustomVault exactly, minus the filesystem/git
// scaffolding this pure-model suite does not need. landmarkHeading: which landmark
// closes the span for the accounting control (default "## Session notes", present in
// every isolated-channel fixture below unless the test is exercising landmark behavior
// itself); pass null to omit it entirely (the ran:false / accounting-mismatch fixtures
// build their own ledger by hand instead, same as the vault suite does).
function customLedger(slug, activeSessionsLines, { landmarkHeading = "## Session notes" } = {}) {
  const lines = [
    "---",
    `project: ${slug}`,
    "convention: session-coordination v1",
    `repo: ~/Projects/${slug}`,
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Active sessions",
    "",
    ...activeSessionsLines,
    "",
  ];
  if (landmarkHeading) lines.push(landmarkHeading, "", "### x", "", "prose", "");
  lines.push("## Merge queue", "", "<!-- AUTO:BEGIN branch-inventory -->", "(none)", "<!-- AUTO:END -->", "");
  return lines.join("\n");
}

function soleView(slug, ledgerContent) {
  return computeCoordinationView([{ slug, ledgerContent, questionsContent: null }], NOW)[0];
}

// --- channel 1/7: orphans -- prose glued directly under the heading means the header row
// is never found at all; every subsequent "|" line (header, separator, and the one data
// row) is reported as an orphan instead of being parsed or silently dropped. ---
{
  const LEDGER = customLedger("proj-a", [
    "prose glued directly under the heading, no real header row reachable here",
    "",
    H8,
    S8,
    ROW8("s1", "active"),
  ]);
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true, "orphans channel fires -> untrustworthy");
  assert.equal(
    v.warnings.length,
    2,
    "isolated: the orphans line plus the stale-clear suspension notice, nothing else (no table was recognized at all, so stateColumnMissing correctly stays clear, and the control balances against the same 3 orphaned '|' lines)"
  );
  assert.match(
    v.warnings[0],
    /^3 unparsed table row\(s\) in Active sessions \(Projects\/proj-a\/work-ledger\.md, lines \d+, \d+, \d+\), fix the ledger$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);
  assert.equal(v.activeSessions.length, 0, "nothing was recognized as a session row -- everything fell through to orphans");
}

// --- channel 2/7: invalidRows -- a wrong cell count, isolated from the row that parses fine. ---
{
  const LEDGER = customLedger("proj-a", [
    H8,
    S8,
    ROW8("s1", "active"),
    "| s2 | id-s2 | active | feat/s2 | wt | ws | 2026-08-29T08:00:00Z |", // 7 cells, not 8: missing Last update
  ]);
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true);
  assert.equal(v.warnings.length, 2, "isolated: the invalidRows line plus the suspension notice, no other channel");
  assert.match(
    v.warnings[0],
    /^1 malformed table row\(s\) in Active sessions \(Projects\/proj-a\/work-ledger\.md\): line \d+ \(expected 8 cells, found 7\)$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);
  assert.deepEqual(v.activeSessions.map((s) => s.session), ["s1"], "the malformed row never becomes a session; the well-formed one still does");
}

// --- channel 3/7: invalidStates -- a State cell outside the closed set {active,done,blocked}. ---
{
  const LEDGER = customLedger("proj-a", [H8, S8, ROW8("s1", "pending"), ROW8("s2", "active")]);
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true);
  assert.equal(v.warnings.length, 2, "isolated: the invalidStates line plus the suspension notice, no other channel");
  assert.match(
    v.warnings[0],
    /^1 row\(s\) with an invalid State value in Active sessions \(Projects\/proj-a\/work-ledger\.md\): line \d+ \(session "s1", State="pending"\)$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);
  assert.deepEqual(v.activeSessions.map((s) => s.session), ["s2"], "s1's invalid state excludes it from 'active'; it is not silently dropped (still counted for the accounting control), just not active");
}

// --- channel 4/7: headingTruncations -- a deeper heading glued mid-table, walked past and
// named. Doubles as the "sessions still returned and correct when untrustworthy" proof: s1
// sits BEFORE the intruding heading, is unaffected by it, and is a genuinely 48.5h-stale
// active row whose `stale` flag must still read false once the ledger is untrustworthy. ---
{
  const LEDGER = customLedger("proj-a", [
    H8,
    S8,
    ROW8("s1", "active", "2026-08-27T09:00:00Z"), // 48.5h before NOW -- would read stale if trustworthy
    "",
    "### an intruding sub-heading",
    "",
  ]);
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true);
  assert.equal(
    v.warnings.length,
    2,
    "isolated: the headingTruncations line plus the suspension notice (nothing trails the intruding heading in this fixture, so orphans stays empty, and the parser correctly walks past a deeper heading, so the control still balances)"
  );
  assert.match(
    v.warnings[0],
    /^1 heading\(s\) found inside what should be one contiguous Active sessions table \(Projects\/proj-a\/work-ledger\.md\): line \d+ \("### an intruding sub-heading"\) -- the block was truncated, fix the ledger$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);

  assert.equal(v.activeSessions.length, 1, "the ANSWER (session list) is still correct even though the ACTION (trusting the stale badge) is refused");
  assert.deepEqual(
    v.activeSessions[0],
    { session: "s1", branch: "feat/s1", lastUpdate: "2026-08-27T09:00:00Z", stale: false },
    "session/branch/lastUpdate are all correct, but stale is suppressed to false despite 48.5h since last update -- an untrustworthy ledger never presents the stale badge as actionable"
  );
}

// --- channel 5/7: stateColumnMissing -- a recognized table with neither State nor Status. ---
{
  const H_NO_STATE = "| Session | Session id | Branch | Worktree | Write-set | Started | Last update |";
  const S_NO_STATE = "|---|---|---|---|---|---|---|";
  const LEDGER = customLedger("proj-a", [
    H_NO_STATE,
    S_NO_STATE,
    "| s1 | id-s1 | feat/s1 | wt | ws | 2026-08-27T08:00:00Z | 2026-08-29T09:00:00Z |",
  ]);
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true);
  assert.equal(v.warnings.length, 2, "isolated: the stateColumnMissing line plus the suspension notice, no other channel");
  assert.match(
    v.warnings[0],
    /^Active sessions table \(Projects\/proj-a\/work-ledger\.md\) has neither a State nor a Status column -- no machine-readable liveness signal exists for any row$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);
  assert.equal(v.activeSessions.length, 0, "with no State and no Status column, nothing can read as active");
}

// --- channel 6/7: headingInFence -- the '## Active sessions' heading itself lands somewhere
// an unclosed-then-closed code fence makes ambiguous. Hand-built (not customLedger): the
// fence must open BEFORE the heading and close right after the one data row, isolated from
// the landmark search which happens after the fence closes again. ---
{
  const LEDGER = [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "repo: ~/Projects/proj-a",
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "```",
    "oops never closed here, above the heading",
    "## Active sessions",
    "",
    H8,
    S8,
    ROW8("s1", "active"),
    "```",
    "",
    "## Session notes",
    "",
    "### x",
    "",
    "prose",
    "",
    "## Merge queue",
    "",
    "<!-- AUTO:BEGIN branch-inventory -->",
    "(none)",
    "<!-- AUTO:END -->",
    "",
  ].join("\n");
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true);
  assert.equal(
    v.warnings.length,
    2,
    "isolated: the headingInFence line plus the suspension notice (the fence closes again before the landmark, so the table under the fenced heading is still read normally and the control still balances)"
  );
  assert.match(
    v.warnings[0],
    /^the '## Active sessions' heading \(Projects\/proj-a\/work-ledger\.md\) was matched somewhere an unclosed code fence makes ambiguous -- verify by hand$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);
  assert.equal(v.activeSessions.length, 1, "the row under the fenced heading is still read normally -- fence-gating only affects the heading match, not the row parse");
}

// --- channel 7/7: findStrayClaimRows -- the Reviewer's Critical-1 shape: a claim row
// appended ONE LINE below a landmark heading is invisible to the parser AND to the span
// control (both stop at the same line, both agree, both wrong) -- the stray-row scan is
// the ONLY channel that catches it. ---
{
  const LEDGER = [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "repo: ~/Projects/proj-a",
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Active sessions",
    "",
    H8,
    S8,
    ROW8("live-one", "active"),
    "",
    "## Session notes",
    ROW8("newclaim", "active"), // off-by-one: glued immediately below the landmark, no blank line
    "",
    "### live-one",
    "",
    "prose",
    "",
    "## Merge queue",
    "",
    "<!-- AUTO:BEGIN branch-inventory -->",
    "(none)",
    "<!-- AUTO:END -->",
    "",
  ].join("\n");
  const v = soleView("proj-a", LEDGER);
  assert.deepEqual(v.activeSessions.map((s) => s.session), ["live-one"], "the parser itself still only sees live-one -- newclaim is genuinely invisible to it");
  assert.equal(v.untrustworthy, true, "the stray-row scan is the ONLY thing that catches this shape");
  assert.equal(
    v.warnings.length,
    2,
    "isolated: the stray-row line plus the suspension notice (the span control alone is blind here BY CONSTRUCTION -- its own landmark search and the parser's sectionEnd land on the same line and agree, wrongly -- must not ALSO fire as a mismatch or a could-not-run)"
  );
  assert.match(
    v.warnings[0],
    /^1 stray claim-shaped row\(s\) found OUTSIDE the recognized Active sessions table \(Projects\/proj-a\/work-ledger\.md, lines \d+\) -- a landmark-titled heading may be masking real claim rows, fix the ledger$/
  );
  assert.match(v.warnings[1], /^STALE-CLEAR SUSPENDED \(Projects\/proj-a\/work-ledger\.md\):/);
}

// --- the accounting control's THIRD state: ran:false (no landmark heading anywhere in the
// file at all) is a LOUD finding, not a silent pass. Sessions still print unconditionally. ---
{
  const LEDGER = [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "repo: ~/Projects/proj-a",
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Active sessions",
    "",
    H8,
    S8,
    ROW8("s1", "active"),
    "",
    "## Something else entirely",
    "",
    "no landmark heading anywhere in this file",
    "",
  ].join("\n");
  const v = soleView("proj-a", LEDGER);
  assert.equal(v.untrustworthy, true, "the control could not run at all -- treated as untrustworthy, not as a silent ok");
  assert.ok(
    v.warnings.some((l) => /^ACCOUNTING CONTROL COULD NOT RUN \(Projects\/proj-a\/work-ledger\.md\): no landmark heading/.test(l)),
    "the ran:false reason is surfaced as its own loud warning line"
  );
  assert.equal(v.activeSessions.length, 1, "sessions still print unconditionally even when the control cannot run at all");
  assert.equal(v.activeSessions[0].stale, false, "stale suppressed under untrustworthy, same as every other loud channel");
}

// --- the accounting control's ok:false (MISMATCH) state: the "accepted parser gap" -- a
// same-level heading intruding mid-table silently ends the parser's own span with every
// parser-side channel clean, and only the control's independent count catches the loss. ---
{
  const LEDGER = [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "repo: ~/Projects/proj-a",
    "updated: 2026-08-29",
    "---",
    "",
    "# Work Ledger",
    "",
    "## Active sessions",
    "",
    H8,
    S8,
    ROW8("live-1", "active"),
    ROW8("live-2", "active"),
    "",
    "## an intruding same-level heading",
    "",
    ROW8("live-3", "active"),
    ROW8("live-4", "active"),
    "",
    "## Merge queue",
    "",
    "<!-- AUTO:BEGIN branch-inventory -->",
    "(none)",
    "<!-- AUTO:END -->",
    "",
    "### Landing order",
    "",
    "1. (ordered)",
    "",
    "## WIP rules",
    "",
    "- Max 3.",
    "",
  ].join("\n");
  const v = soleView("proj-a", LEDGER);
  assert.deepEqual(
    v.activeSessions.map((s) => s.session),
    ["live-1", "live-2"],
    "the parser itself silently drops live-3 and live-4 -- the accepted gap, reproduced"
  );
  assert.equal(v.untrustworthy, true, "the accounting control's independent count disagrees with the parser's reduced total -- caught");
  assert.ok(
    v.warnings.some((l) =>
      /^ACCOUNTING MISMATCH \(Projects\/proj-a\/work-ledger\.md\): parser accounted for 4 '\|' line\(s\), the control independently counted 6/.test(l)
    ),
    "CAUGHT: control counted 6 '|' lines (header+sep+4 rows) between the heading and '## Merge queue', the parser only accounted for 4 (header+sep+2 rows it actually recognized)"
  );
}

// --- per-ledger scoping: one dirty ledger and one clean ledger in the SAME
// computeCoordinationView call. The dirty ledger's suppression must not leak into the clean
// one, and vice versa -- each ledger's untrustworthy/warnings/stale-suppression is computed
// independently, in the same pass. ---
{
  const DIRTY = customLedger("dirty-proj", [
    H8,
    S8,
    ROW8("dirty-stale", "active", "2026-08-27T09:00:00Z"), // 48.5h before NOW
    "",
    "### an intruding sub-heading",
    "",
  ]);
  const CLEAN = customLedger("clean-proj", [
    H8,
    S8,
    ROW8("clean-stale", "active", "2026-08-27T09:00:00Z"), // also 48.5h before NOW, genuinely stale
  ]);
  const views = computeCoordinationView(
    [
      { slug: "dirty-proj", ledgerContent: DIRTY, questionsContent: null },
      { slug: "clean-proj", ledgerContent: CLEAN, questionsContent: null },
    ],
    NOW
  );
  const dirty = views.find((v) => v.slug === "dirty-proj");
  const clean = views.find((v) => v.slug === "clean-proj");

  assert.equal(dirty.untrustworthy, true);
  assert.deepEqual(dirty.activeSessions.map((s) => s.session), ["dirty-stale"]);
  assert.equal(dirty.activeSessions[0].stale, false, "dirty ledger: stale badge suppressed");

  assert.equal(clean.untrustworthy, false, "the dirty ledger's warnings must not leak into the clean one processed in the same call");
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.activeSessions.map((s) => s.session), ["clean-stale"]);
  assert.equal(clean.activeSessions[0].stale, true, "clean ledger in the SAME call keeps its stale badge -- suppression is scoped per-ledger, not global");
}

console.log("coordinationModel.test.mjs: all assertions passed");
