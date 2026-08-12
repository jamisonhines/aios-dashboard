// Tests for the incidents-strip data model: computeIncidents (pure). Imports
// the SAME module main.ts bundles (model.mjs). Run: node incidentsModel.test.mjs
import assert from "node:assert";
import { computeIncidents } from "./model.mjs";

const NOW = new Date("2026-08-12T09:00:00+04:00");

const note = (path, frontmatter) => ({ path, frontmatter });

// --- empty input: no notes -> no rows ---
assert.deepEqual(computeIncidents({ notes: [], now: NOW }), [], "no notes -> no rows");
assert.deepEqual(computeIncidents({ notes: undefined, now: NOW }), [], "missing notes array -> no rows");

// --- open-vs-resolved filtering ---
{
  const input = {
    now: NOW,
    notes: [
      note("Operations/incidents/INC-2026-08-12-01-vss-down.md", {
        status: "open",
        item: "VSS production rollback",
        summary: "Site was down for cold visitors, rolled back to last known-good",
        property: "vss",
        detected: "2026-08-12T03:14:00+04:00",
      }),
      note("Operations/incidents/INC-2026-08-10-01-fixed.md", {
        status: "resolved",
        item: "Already fixed",
        summary: "n/a",
        property: "vss",
        detected: "2026-08-10T03:14:00+04:00",
      }),
    ],
  };
  const rows = computeIncidents(input);
  assert.equal(rows.length, 1, "only the open incident is returned");
  assert.equal(rows[0].item, "VSS production rollback", "correct incident surfaced");
}

// --- sort order: newest-detected first ---
{
  const input = {
    now: NOW,
    notes: [
      note("a.md", { status: "open", item: "older", detected: "2026-08-10T00:00:00+04:00" }),
      note("b.md", { status: "open", item: "newest", detected: "2026-08-12T00:00:00+04:00" }),
      note("c.md", { status: "open", item: "middle", detected: "2026-08-11T00:00:00+04:00" }),
    ],
  };
  const rows = computeIncidents(input);
  assert.deepEqual(
    rows.map((r) => r.item),
    ["newest", "middle", "older"],
    "sorted newest-detected first"
  );
}

// --- prompt: uses frontmatter prompt when present and non-empty ---
{
  const input = {
    now: NOW,
    notes: [
      note("x.md", { status: "open", item: "x", prompt: "Read x.md and fix it." }),
    ],
  };
  assert.equal(
    computeIncidents(input)[0].prompt,
    "Read x.md and fix it.",
    "uses the note's own prompt when present"
  );
}

// --- prompt fallback: missing prompt field ---
{
  const input = { now: NOW, notes: [note("y.md", { status: "open", item: "y" })] };
  const row = computeIncidents(input)[0];
  assert.ok(typeof row.prompt === "string" && row.prompt.length > 0, "fallback prompt is non-empty");
  assert.ok(row.prompt.includes("y.md"), "fallback prompt names the note path");
}

// --- prompt fallback: empty-string prompt field ---
{
  const input = { now: NOW, notes: [note("z.md", { status: "open", item: "z", prompt: "" })] };
  const row = computeIncidents(input)[0];
  assert.ok(row.prompt.length > 0, "empty-string prompt still gets a non-empty fallback");
  assert.ok(row.prompt.includes("z.md"), "fallback prompt names the note path");
}

// --- prompt fallback: whitespace-only prompt field ---
{
  const input = { now: NOW, notes: [note("w.md", { status: "open", item: "w", prompt: "   " })] };
  const row = computeIncidents(input)[0];
  assert.ok(row.prompt.length > 0, "whitespace-only prompt still gets a non-empty fallback");
}

// --- ageDays computation ---
{
  const input = {
    now: NOW,
    notes: [note("age.md", { status: "open", item: "age", detected: "2026-08-09T09:00:00+04:00" })],
  };
  assert.equal(computeIncidents(input)[0].ageDays, 3, "ageDays computed from now - detected");
}

// --- malformed input: missing frontmatter entirely ---
{
  const input = { now: NOW, notes: [{ path: "no-fm.md" }] };
  assert.doesNotThrow(() => computeIncidents(input), "note with no frontmatter does not throw");
  assert.deepEqual(computeIncidents(input), [], "no frontmatter -> no status -> excluded, not crashed");
}

// --- malformed input: frontmatter is null ---
{
  const input = { now: NOW, notes: [note("null-fm.md", null)] };
  assert.doesNotThrow(() => computeIncidents(input), "null frontmatter does not throw");
  assert.deepEqual(computeIncidents(input), []);
}

// --- malformed input: status wrong case ---
{
  const input = { now: NOW, notes: [note("case.md", { status: "OPEN", item: "cased" })] };
  const rows = computeIncidents(input);
  assert.equal(rows.length, 1, "status is matched case-insensitively");
  assert.equal(rows[0].item, "cased");
}
{
  const input = { now: NOW, notes: [note("case2.md", { status: "  Open  ", item: "cased2" })] };
  assert.equal(computeIncidents(input).length, 1, "status is trimmed and matched case-insensitively");
}

// --- malformed input: status missing entirely ---
{
  const input = { now: NOW, notes: [note("nostatus.md", { item: "no status" })] };
  assert.deepEqual(computeIncidents(input), [], "missing status excludes the note, does not throw");
}

// --- malformed input: status is not a string (e.g. a number or object) ---
{
  const input = { now: NOW, notes: [note("weird.md", { status: 1, item: "weird" })] };
  assert.doesNotThrow(() => computeIncidents(input));
  assert.deepEqual(computeIncidents(input), [], "non-string status excludes the note, does not throw");
}

// --- malformed input: detected is absent ---
{
  const input = { now: NOW, notes: [note("nodate.md", { status: "open", item: "no date" })] };
  const rows = computeIncidents(input);
  assert.equal(rows.length, 1, "still surfaced despite missing detected date");
  assert.equal(rows[0].ageDays, 0, "ageDays falls back to 0 when detected is absent");
}

// --- malformed input: detected is a garbled string ---
{
  const input = { now: NOW, notes: [note("baddate.md", { status: "open", item: "bad date", detected: "not-a-date" })] };
  const rows = computeIncidents(input);
  assert.equal(rows.length, 1, "still surfaced despite a garbled detected date");
  assert.equal(rows[0].ageDays, 0, "ageDays falls back to 0 for an unparsable detected date");
}

// --- malformed input: undated notes sink to the bottom of the sort, never lead ---
{
  const input = {
    now: NOW,
    notes: [
      note("undated.md", { status: "open", item: "undated" }),
      note("dated.md", { status: "open", item: "dated", detected: "2026-01-01T00:00:00+04:00" }),
    ],
  };
  const rows = computeIncidents(input);
  assert.deepEqual(rows.map((r) => r.item), ["dated", "undated"], "undated notes sort after every dated note");
}

// --- malformed input: tags is a string instead of a list (computeIncidents ignores tags, must not throw) ---
{
  const input = { now: NOW, notes: [note("tagstring.md", { status: "open", item: "tagged", tags: "urgent, incident" })] };
  assert.doesNotThrow(() => computeIncidents(input));
  assert.equal(computeIncidents(input).length, 1, "string tags do not affect filtering or crash");
}

// --- malformed input: item/summary/property missing -> safe fallbacks, no throw ---
{
  const input = { now: NOW, notes: [note("Operations/incidents/INC-bare.md", { status: "open" })] };
  const rows = computeIncidents(input);
  assert.equal(rows.length, 1, "bare open note still surfaced");
  assert.equal(rows[0].item, "INC-bare.md", "missing item falls back to the note's filename");
  assert.equal(rows[0].summary, "", "missing summary falls back to an empty string, not undefined/null");
  assert.equal(rows[0].property, "", "missing property falls back to an empty string, not undefined/null");
}

// --- malformed input: the whole note is not an object ---
{
  const input = { now: NOW, notes: [null, undefined, "not-a-note", 42] };
  assert.doesNotThrow(() => computeIncidents(input), "junk entries in the notes array do not throw");
  assert.deepEqual(computeIncidents(input), []);
}

// --- malformed input: path missing ---
{
  const input = { now: NOW, notes: [{ frontmatter: { status: "open", item: "no path" } }] };
  assert.doesNotThrow(() => computeIncidents(input));
  assert.deepEqual(computeIncidents(input), [], "a note with no path is excluded, not thrown");
}

console.log("incidentsModel: all assertions passed");
