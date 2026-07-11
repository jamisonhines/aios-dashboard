// Tests for the automation-health exporter's pure parts (build 2.6 m2):
// launchctl parse, schedule description, next-occurrence math, overdue
// period, state derivation, and red-first sorting. Imports the REAL functions
// from the repo-canonical exporter (vault-scripts/, deployed to the vault by
// deploy.sh). Importing the exporter never scans launchd (direct-execution
// guard). Run: node exportAutomationHealth.test.mjs
import assert from "node:assert";
import {
  DEFAULT_LABEL_PREFIXES,
  STATE_ORDER,
  parseLaunchctlList,
  describeSchedule,
  nextCalendarOccurrence,
  computeNextExpected,
  schedulePeriodMs,
  computeJobState,
  sortJobsRedFirst,
  resolvePrefixes,
} from "./vault-scripts/export-automation-health.mjs";

// A fixed "now": Saturday 2026-07-11 12:00 local time.
const NOW = new Date(2026, 6, 11, 12, 0, 0);
assert.equal(NOW.getDay(), 6, "fixture sanity: 2026-07-11 is a Saturday");

// --- parseLaunchctlList ---
{
  const text =
    "PID\tStatus\tLabel\n" +
    "-\t127\tcom.jaymo.morning-brief\n" +
    "-\t126\tcom.jaymo.daily-archive\n" +
    "2172\t0\tcom.jaymo.dispatch-bot\n" +
    "-\t0\tge.vagabondadventures.triage\n" +
    "\n" +
    "garbage line\n";
  const map = parseLaunchctlList(text);
  assert.equal(map.size, 4, "4 parsed rows (header + garbage skipped)");
  assert.deepEqual(map.get("com.jaymo.morning-brief"), { pid: null, lastExitStatus: 127 });
  assert.deepEqual(map.get("com.jaymo.daily-archive"), { pid: null, lastExitStatus: 126 });
  assert.deepEqual(map.get("com.jaymo.dispatch-bot"), { pid: 2172, lastExitStatus: 0 });
  assert.equal(map.has("PID"), false, "header line skipped");
}
assert.equal(parseLaunchctlList("").size, 0, "empty text -> empty map");

// --- describeSchedule ---
assert.equal(
  describeSchedule({ calendar: { Hour: 7, Minute: 0 } }),
  "daily 07:00",
  "single daily dict"
);
assert.equal(
  describeSchedule({ calendar: { Weekday: 1, Hour: 9, Minute: 0 } }),
  "Mon 09:00",
  "weekday dict"
);
assert.equal(
  describeSchedule({
    calendar: [
      { Hour: 6, Minute: 0 },
      { Hour: 12, Minute: 0 },
      { Hour: 18, Minute: 0 },
    ],
  }),
  "daily 06:00 / daily 12:00 / daily 18:00",
  "array of dicts joins"
);
assert.equal(describeSchedule({ interval: 900 }), "every 15m", "interval in minutes");
assert.equal(describeSchedule({ interval: 7200 }), "every 2h", "interval in hours");
assert.equal(describeSchedule({ interval: 45 }), "every 45s", "interval in seconds");
assert.equal(describeSchedule({ runAtLoad: true }), "at load", "run-at-load only");
assert.equal(describeSchedule({}), "unscheduled", "nothing set");

// --- nextCalendarOccurrence ---
{
  // 07:00 daily, now 12:00 -> tomorrow 07:00.
  const occ = nextCalendarOccurrence({ Hour: 7, Minute: 0 }, NOW);
  assert.equal(occ.getDate(), 12, "past today's time -> tomorrow");
  assert.equal(occ.getHours(), 7);
}
{
  // 18:00 daily, now 12:00 -> today 18:00.
  const occ = nextCalendarOccurrence({ Hour: 18, Minute: 0 }, NOW);
  assert.equal(occ.getDate(), 11, "still ahead today -> today");
  assert.equal(occ.getHours(), 18);
}
{
  // Monday 09:00 from Saturday noon -> Monday the 13th.
  const occ = nextCalendarOccurrence({ Weekday: 1, Hour: 9, Minute: 0 }, NOW);
  assert.equal(occ.getDay(), 1, "lands on a Monday");
  assert.equal(occ.getDate(), 13);
  assert.equal(occ.getHours(), 9);
}
{
  // launchd Weekday 7 = Sunday, same as 0.
  const occ = nextCalendarOccurrence({ Weekday: 7, Hour: 9, Minute: 0 }, NOW);
  assert.equal(occ.getDay(), 0, "Weekday 7 treated as Sunday");
  assert.equal(occ.getDate(), 12);
}
{
  // Missing Hour defaults to 0 (midnight).
  const occ = nextCalendarOccurrence({ Minute: 30 }, NOW);
  assert.equal(occ.getHours(), 0);
  assert.equal(occ.getMinutes(), 30);
}

// --- computeNextExpected ---
{
  // Array of dicts: earliest upcoming wins (18:00 today beats tomorrow 06:00).
  const iso = computeNextExpected(
    { calendar: [{ Hour: 6, Minute: 0 }, { Hour: 18, Minute: 0 }] },
    null,
    NOW
  );
  assert.equal(iso, new Date(2026, 6, 11, 18, 0, 0).toISOString(), "earliest occurrence wins");
}
{
  // StartInterval: lastActivity + interval.
  const last = new Date(2026, 6, 11, 11, 50, 0).toISOString();
  const iso = computeNextExpected({ interval: 900 }, last, NOW);
  assert.equal(iso, new Date(2026, 6, 11, 12, 5, 0).toISOString(), "lastActivity + 15m");
}
assert.equal(
  computeNextExpected({ interval: 900 }, null, NOW),
  null,
  "interval with no activity -> null"
);
assert.equal(computeNextExpected({ runAtLoad: true }, null, NOW), null, "RunAtLoad -> null");

// --- schedulePeriodMs ---
assert.equal(schedulePeriodMs({ calendar: { Hour: 7 } }), 86400000, "daily = 24h");
assert.equal(
  schedulePeriodMs({ calendar: { Weekday: 1, Hour: 9 } }),
  7 * 86400000,
  "weekly = 7d"
);
assert.equal(
  schedulePeriodMs({ calendar: [{ Hour: 6 }, { Hour: 12 }, { Hour: 18 }] }),
  86400000 / 3,
  "3x daily = 8h effective period"
);
assert.equal(
  schedulePeriodMs({ calendar: [{ Weekday: 1, Hour: 9 }, { Weekday: 4, Hour: 9 }] }),
  (7 * 86400000) / 2,
  "2x weekly = 3.5d effective period"
);
assert.equal(schedulePeriodMs({ interval: 900 }), 900000, "interval seconds -> ms");
assert.equal(schedulePeriodMs({ runAtLoad: true }), null, "RunAtLoad has no period");

// --- computeJobState ---
const daily = { calendar: { Hour: 7, Minute: 0 } };
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
assert.equal(
  computeJobState({ loaded: false, pid: null, lastExitStatus: null, lastActivity: null, schedule: daily }, NOW),
  "unknown",
  "not in launchctl list -> unknown (not loaded)"
);
assert.equal(
  computeJobState({ loaded: true, pid: 2172, lastExitStatus: 0, lastActivity: hoursAgo(1), schedule: { runAtLoad: true } }, NOW),
  "running",
  "live pid -> running"
);
assert.equal(
  computeJobState({ loaded: true, pid: null, lastExitStatus: 127, lastActivity: hoursAgo(5), schedule: daily }, NOW),
  "error",
  "exit 127 -> error"
);
assert.equal(
  computeJobState({ loaded: true, pid: null, lastExitStatus: 126, lastActivity: hoursAgo(5), schedule: daily }, NOW),
  "error",
  "exit 126 -> error"
);
assert.equal(
  computeJobState({ loaded: true, pid: null, lastExitStatus: 0, lastActivity: hoursAgo(40), schedule: daily }, NOW),
  "overdue",
  "daily job silent 40h (> 24h * 1.25 = 30h) -> overdue"
);
assert.equal(
  computeJobState({ loaded: true, pid: null, lastExitStatus: 0, lastActivity: hoursAgo(20), schedule: daily }, NOW),
  "ok",
  "daily job 20h ago (< 30h) -> ok"
);
assert.equal(
  computeJobState({ loaded: true, pid: null, lastExitStatus: 0, lastActivity: null, schedule: daily }, NOW),
  "ok",
  "no logs to date -> not judged overdue"
);
assert.equal(
  computeJobState({ loaded: true, pid: 99, lastExitStatus: 1, lastActivity: null, schedule: daily }, NOW),
  "running",
  "running wins over a prior nonzero exit"
);

// --- sortJobsRedFirst ---
{
  const jobs = [
    { label: "b-ok", state: "ok" },
    { label: "a-running", state: "running" },
    { label: "z-error", state: "error" },
    { label: "a-error", state: "error" },
    { label: "m-overdue", state: "overdue" },
    { label: "q-unknown", state: "unknown" },
  ];
  const sorted = sortJobsRedFirst(jobs).map((j) => j.label);
  assert.deepEqual(
    sorted,
    ["q-unknown", "a-error", "z-error", "m-overdue", "a-running", "b-ok"],
    "red first, label a-z within a state"
  );
  assert.deepEqual(STATE_ORDER, ["unknown", "error", "overdue", "running", "ok"]);
}

// --- resolvePrefixes ---
assert.deepEqual(resolvePrefixes(undefined), DEFAULT_LABEL_PREFIXES, "no arg -> defaults");
assert.deepEqual(resolvePrefixes(""), DEFAULT_LABEL_PREFIXES, "empty arg -> defaults");
assert.deepEqual(resolvePrefixes("com.acme., org.x."), ["com.acme.", "org.x."], "comma override");
assert.deepEqual(DEFAULT_LABEL_PREFIXES, ["com.jaymo.", "com.aios.", "ge.vagabondadventures."]);

console.log("exportAutomationHealth.test.mjs: all assertions passed");
