import "./testFileTimeout.mjs";
// Fixture test: a SYNTHETIC scrubbed fixture (fixtures/synthetic-answer-save-fixture.md,
// invented project/session names, invented dates, invented content -- never the real
// vagabond-ops-app/questions.md; this suite must never write to ~/AIOS). Reviewer round 2,
// I-2: an earlier version of this fixture was a verbatim copy of the live file and carried
// a real customer surname, supplier cost prices, and staff login addresses into a
// GitHub-pushed repo. This fixture reproduces every FORMAT that made the real file fail to
// splice (bold-colon, bold-label, missing-line, missing-line-with-an-ANSWERED-bullet,
// multi-line-context-before-insertion), plus the round-2 negative/edge cases (a decoy
// "Answered:" bullet, an indented sub-bullet, mid-sentence prose, a fenced template
// example), with entirely fictional text.
//
// Reviewer round 2, M-4: the original version of this file only counted `diff -u` hunks,
// which context-merges a change adjacent to the intended edit into the SAME hunk, so a
// deletion right next to the edit (mutations D, E, H, I in the task report) stayed
// invisible here even though spliceAnswerModel.test.mjs caught all four. This version
// replaces the hunk count with two structurally independent, un-gameable checks:
//   1. LOCALITY: every OTHER heading-delimited block in the file (re-located dynamically
//      in the spliced output, not by a fixed line offset) must be byte-identical to the
//      original. Any bleed outside the target question's own block is caught here.
//   2. SHAPE: for a REPLACE-type splice (a real Answer line already existed under the new
//      regex), the target block's own total line count must be UNCHANGED (every Answer
//      field in this fixture is single-line, so a same-line replace never changes the
//      block's line count -- if it does, a line was wrongly deleted or added, catching
//      mutation H). For an INSERT-type splice (no Answer line existed at all), the new
//      Answer line's index inside the block must equal exactly one past the original
//      block's last non-blank content line -- catching D (blank-line walkback dropped),
//      E (inserted at the top instead of the end), and I (an extra line consumed).
//
// Run: node answerSaveFixture.test.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spliceAnswer } from "./model.mjs";
import { parseQuestionsOpen } from "../../AIOS/Operations/scripts/lib/coordination-parse.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "synthetic-answer-save-fixture.md");
const ORIGINAL = readFileSync(fixturePath, "utf8");

// Fixture sanity: no real-data leftovers, ever (Reviewer round 2, I-2 regression guard).
assert.ok(!/vagabond-ops-app-questions-2026-09-18/.test(ORIGINAL), "no reference to the old real-data fixture filename");
assert.ok(!/\bArndt\b/.test(ORIGINAL), "no real customer surname");
assert.ok(!/Ambassadori|COSTS!/.test(ORIGINAL), "no real supplier name or cost-sheet cell reference");
assert.ok(!/vagabondadventures\.ge|vagabondskischool\.ge/.test(ORIGINAL), "no real staff login address");

const open = parseQuestionsOpen(ORIGINAL);
assert.equal(open.length, 12, "fixture sanity check: exactly 12 synthetic Open questions");

// The exact pre-fix-shape classification, by construction (not measured against a live
// file, since this fixture never existed pre-fix -- these are the shapes DESIGNED to
// reproduce the 8-of-17 real failure classes from the original bug).
const INSERT_TYPE = new Set(["Q-2026-01-01-06", "Q-2026-01-01-07", "Q-2026-01-01-08"]);
const REPLACE_TYPE = new Set([
  "Q-2026-01-01-01", "Q-2026-01-01-02", "Q-2026-01-01-03", "Q-2026-01-01-04",
  "Q-2026-01-01-05", "Q-2026-01-01-09", "Q-2026-01-01-10", "Q-2026-01-01-11", "Q-2026-01-01-12",
]);
assert.equal(INSERT_TYPE.size + REPLACE_TYPE.size, 12, "every question is classified exactly once");
for (const q of open) {
  assert.ok(INSERT_TYPE.has(q.id) || REPLACE_TYPE.has(q.id), `${q.id} is not classified`);
}

let ok = 0;
const stillFailing = [];
const results = new Map();
for (const q of open) {
  const r = spliceAnswer(ORIGINAL, q.id, `TEST ANSWER for ${q.id}`, "2026-01-02");
  if (r === null) {
    stillFailing.push(q.id);
  } else {
    ok++;
    results.set(q.id, r);
  }
}

assert.equal(stillFailing.length, 0, `all 12 Open questions must splice; still failing: ${stillFailing.join(", ")}`);
assert.equal(ok, 12);

// --- shared oracle: heading-delimited blocks, independent of the production module's own
// span logic (a "## " or "### " heading starts a new block; a block runs to the next such
// heading or EOF). Used both to isolate "everything outside the target" and to locate the
// target block's own text precisely. ---
function extractBlocks(content) {
  const lines = content.split("\n");
  const headingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) headingIdx.push(i);
  }
  const blocks = new Map();
  for (let k = 0; k < headingIdx.length; k++) {
    const start = headingIdx[k];
    const end = k + 1 < headingIdx.length ? headingIdx[k + 1] : lines.length;
    blocks.set(lines[start], { lines: lines.slice(start, end), headingLine: lines[start] });
  }
  return blocks;
}

const originalBlocks = extractBlocks(ORIGINAL);

// --- frontmatter: only the `updated:` scalar may differ, checked once per result ---
function frontmatterUnchangedExceptUpdated(after, newUpdated) {
  const origFm = ORIGINAL.match(/^---\n([\s\S]*?)\n---/)[1];
  const afterFm = after.match(/^---\n([\s\S]*?)\n---/)[1];
  const origNormalized = origFm.replace(/^updated:.*$/m, "updated: <X>");
  const afterNormalized = afterFm.replace(/^updated:.*$/m, "updated: <X>");
  assert.equal(afterNormalized, origNormalized, "only the updated: scalar may differ in frontmatter");
  assert.match(afterFm, new RegExp(`^updated: ${newUpdated}$`, "m"));
}

for (const [id, after] of results) {
  frontmatterUnchangedExceptUpdated(after, "2026-01-02");

  const afterBlocks = extractBlocks(after);
  const targetHeading = [...originalBlocks.keys()].find((h) => h.includes(id));
  assert.ok(targetHeading, `${id}: heading found in original blocks`);

  // 1. LOCALITY: every block except the target's own is byte-identical, found dynamically
  // in `after` (not at a fixed offset) -- this is what actually catches an insert/replace
  // that bleeds into a neighbouring block (mutation I: "insert eats the next line").
  for (const [heading, block] of originalBlocks) {
    if (heading === targetHeading) continue;
    const afterBlock = afterBlocks.get(heading);
    assert.ok(afterBlock, `${id}: sibling block "${heading}" must still exist in the spliced output`);
    assert.deepEqual(
      afterBlock.lines,
      block.lines,
      `${id}: sibling block "${heading}" must be byte-identical (a change here means the target's splice bled outside its own block)`
    );
  }

  // 2. SHAPE: replace-type keeps the exact same line count; insert-type's new line lands
  // exactly one past the last original content line, and the trailing blank survives.
  const origBlock = originalBlocks.get(targetHeading);
  const afterBlock = afterBlocks.get(targetHeading);
  if (REPLACE_TYPE.has(id)) {
    assert.equal(
      afterBlock.lines.length,
      origBlock.lines.length,
      `${id}: a same-line replace must not change the block's total line count (catches mutation H, an extra line deleted after the answer block)`
    );
  } else {
    // INSERT_TYPE: find the last non-blank content line in the ORIGINAL block (after the
    // heading), which is where the new Answer line must land, immediately after it.
    let lastContentIdx = origBlock.lines.length - 1;
    while (lastContentIdx > 0 && origBlock.lines[lastContentIdx].trim() === "") lastContentIdx--;
    const expectedNewLineIdx = lastContentIdx + 1;
    assert.equal(
      afterBlock.lines[expectedNewLineIdx],
      `- Answer: TEST ANSWER for ${id}`,
      `${id}: the inserted Answer line must land immediately after the last original bullet, not at the top (mutation E) and not swallowing a line (mutation I)`
    );
    // Trailing blank-line count preserved: everything from the new line onward in `after`
    // must match everything from the insertion point onward in the original, i.e. the
    // insert is a pure splice-in with nothing else disturbed (catches mutation D, the
    // trailing-blank walkback dropped).
    assert.deepEqual(
      afterBlock.lines.slice(expectedNewLineIdx + 1),
      origBlock.lines.slice(expectedNewLineIdx),
      `${id}: everything after the inserted line must be byte-identical to everything from the insertion point onward in the original`
    );
  }
}

// --- specifically confirm the ANSWERED-bullet-preserving insert case ---
{
  const after = results.get("Q-2026-01-01-07");
  assert.ok(
    after.includes("- **ANSWERED 2026-01-01 by Jaymo, CONDITIONALLY.**"),
    "Q-2026-01-01-07's ANSWERED bullet survives the splice untouched"
  );
  assert.ok(after.includes('thing for now, revisit later." Filed as [[#D-2026-01-01-01]]. This bullet'), "its continuation line survives too");
  assert.ok(after.includes("- Answer: TEST ANSWER for Q-2026-01-01-07"));
}

// --- specifically confirm a real bold-form replace (scoped to Q-2026-01-01-03's OWN
// block: Q-2026-01-01-05 legitimately keeps its own "**Answer:**" text since it is a
// DIFFERENT, unspliced question in this particular result) ---
{
  assert.ok(ORIGINAL.includes("- **Answer:**"), "fixture sanity check: the bold-empty form is really present");
  const after = results.get("Q-2026-01-01-03");
  const block03 = after.slice(after.indexOf("### Q-2026-01-01-03"), after.indexOf("### Q-2026-01-01-04"));
  assert.doesNotMatch(block03, /\*\*Answer:\*\*/, "the bold line for THIS question is gone, not duplicated alongside the new plain one");
  assert.match(block03, /\n- Answer: TEST ANSWER for Q-2026-01-01-03\n/);
}

// --- specifically confirm the fenced-template case (M-3): the fake line inside the fence
// survives untouched, only the real line outside it changes ---
{
  const after = results.get("Q-2026-01-01-12");
  assert.ok(after.includes("```\n- **Answer:** <fill in the answer here>\n```"), "the fenced template example is byte-identical");
  assert.ok(after.includes("- Answer: TEST ANSWER for Q-2026-01-01-12"), "the real line outside the fence was updated");
}

// --- specifically confirm the three negative-match decoys survive every relevant splice ---
{
  const after09 = results.get("Q-2026-01-01-09");
  assert.ok(after09.includes("- **Answered:** this is someone's own field named Answered, not the question's Answer"));
  const after10 = results.get("Q-2026-01-01-10");
  assert.ok(after10.includes("  - Answer: this is a NESTED bullet's own text, not the question's Answer field"));
  const after11 = results.get("Q-2026-01-01-11");
  assert.ok(after11.includes("- Note: see Answer: inside this sentence, which is not a field line at all"));
}

// --- the "## Answered" section (a separate question, outside "## Open" entirely) is never
// reachable by any splice above, for any id ---
for (const [, after] of results) {
  assert.ok(after.includes("- Answer: filed already, this must never be touched by any test above"));
}

console.log("answerSaveFixture.test.mjs: all assertions passed (12/12 synthetic Open questions splice, locality + shape verified per question)");
