import "./testFileTimeout.mjs";
// Tests for spliceAnswer (Operations/scripts/lib/coordination-parse.mjs,
// vault-canonical, re-exported by model.mjs -- imported here through
// model.mjs, the SAME import site main.ts's saveCoordinationAnswer uses, so
// a bundling regression in that relative path would fail this suite too).
//
// Covers the live bug: typing an answer to a question whose Answer line is
// bold ("- **Answer:**" / "- **Answer**:") or altogether missing produced a
// silent no-op Notice and nothing saved. Measured against the real
// Projects/vagabond-ops-app/questions.md (2026-09-18): 8 of 17 Open
// questions could not be spliced under the old plain-only ANSWER_LINE_RE.
//
// Run: node spliceAnswerModel.test.mjs
import assert from "node:assert";
import { spliceAnswer } from "./model.mjs";
import { parseQuestionsOpen } from "../../AIOS/Operations/scripts/lib/coordination-parse.mjs";

function questionsFile(bodyLines, { updated = "2026-09-10" } = {}) {
  return [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    `updated: ${updated}`,
    "---",
    "",
    "# Questions",
    "",
    "## Open",
    "",
    ...bodyLines,
    "## Answered",
    "",
    "(none)",
    "",
  ].join("\n");
}

// --- plain form, unchanged behavior (pre-existing case, guards against a regression) ---
{
  const before = questionsFile([
    "### Q-2026-09-01-01 A plain-form question",
    "- Context: c",
    "- Answer:",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-01-01", "yes, go ahead", "2026-09-18");
  assert.notEqual(after, null, "plain '- Answer:' line still splices");
  assert.ok(after.includes("- Answer: yes, go ahead"), "new answer text written on the plain line");
  assert.ok(after.includes("updated: 2026-09-18"), "frontmatter updated: bumped");
  assert.ok(!after.includes("updated: 2026-09-10"), "old updated: value replaced, not left behind");
}

// --- bold variant 1: "- **Answer:**" (bold wraps label AND colon) ---
{
  const before = questionsFile([
    "### Q-2026-09-01-02 A bold-colon question",
    "- Context: c",
    "- **Answer:**",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-01-02", "Taylor is admin.", "2026-09-18");
  assert.notEqual(after, null, "bold '- **Answer:**' line must splice, not return null");
  assert.ok(after.includes("- Answer: Taylor is admin."), "written back in the normalized plain form");
  assert.ok(!after.includes("**Answer:**"), "the old bold line is replaced, not left duplicated alongside the new one");
}

// --- bold variant 2: "- **Answer**:" (bold wraps only the label, colon outside) ---
{
  const before = questionsFile([
    "### Q-2026-09-01-03 A bold-label-only question",
    "- Context: c",
    "- **Answer**:",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-01-03", "confirmed", "2026-09-18");
  assert.notEqual(after, null, "bold '- **Answer**:' line must splice, not return null");
  assert.ok(after.includes("- Answer: confirmed"), "written back in the normalized plain form");
  assert.ok(!after.includes("**Answer**"), "the old bold line is replaced");
}

// --- bold form with existing inline text is replaced wholesale, not appended ---
{
  const before = questionsFile([
    "### Q-2026-09-01-04 A bold question with existing text",
    "- **Answer:** old stale text that must be replaced",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-01-04", "brand new answer", "2026-09-18");
  assert.ok(after.includes("- Answer: brand new answer"));
  assert.ok(!after.includes("old stale text"), "the old bold-form text is fully replaced, not left dangling");
}

// --- missing Answer line entirely: inserted at the end of the bullet list,
// before trailing blanks, WITHOUT touching any other bullet -- including an
// "ANSWERED ..." bullet left behind by another session (the exact real-world
// shape of Q-2026-09-18-01). ---
{
  const before = questionsFile([
    "### Q-2026-09-18-01 No Answer field at all, only an ANSWERED bullet",
    "- Asked: someone, 2026-09-18.",
    "- **ANSWERED 2026-09-18 by Jaymo, CONDITIONALLY.** Verbatim: do the default thing.",
    "  Filed as [[#D-2026-09-18-01]].",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-18-01", "the real dashboard answer", "2026-09-18");
  assert.notEqual(after, null, "a block with no Answer line at all must insert one, not return null");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  // Every original bullet line survives byte-identical, in order.
  const askedIdx = afterLines.indexOf("- Asked: someone, 2026-09-18.");
  assert.ok(askedIdx !== -1, "the Asked bullet is untouched");
  assert.ok(
    afterLines.some((l) => l.startsWith("- **ANSWERED 2026-09-18 by Jaymo, CONDITIONALLY.**")),
    "the existing ANSWERED bullet is untouched, not overwritten or removed"
  );
  assert.ok(
    afterLines.some((l) => l === "  Filed as [[#D-2026-09-18-01]]."),
    "the ANSWERED bullet's continuation line is untouched"
  );
  // The new Answer line is inserted AFTER the ANSWERED bullet's continuation line, i.e. at
  // the end of the bullet list, immediately before the blank separator / next heading.
  const answeredContIdx = afterLines.indexOf("  Filed as [[#D-2026-09-18-01]].");
  const newAnswerIdx = afterLines.indexOf("- Answer: the real dashboard answer");
  assert.ok(newAnswerIdx !== -1, "the new Answer line exists");
  assert.equal(newAnswerIdx, answeredContIdx + 1, "the new Answer line is inserted immediately after the last existing bullet content");
  assert.equal(afterLines[newAnswerIdx + 1].trim(), "", "the blank separator before the next section survives after the inserted line");
}

// --- missing Answer line, no other bullets at all (edge case: empty body) ---
{
  const before = questionsFile(["### Q-2026-09-18-02 Nothing under this heading at all", "", ""]);
  const after = spliceAnswer(before, "Q-2026-09-18-02", "answer to an empty block", "2026-09-18");
  assert.notEqual(after, null);
  assert.ok(after.includes("- Answer: answer to an empty block"));
}

// --- multi-line answer text is collapsed onto one line, whitespace-normalized ---
{
  const before = questionsFile([
    "### Q-2026-09-01-05 Multi-line answer input",
    "- Answer:",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-01-05", "line one\nline two   with  extra   spaces\n", "2026-09-18");
  assert.ok(after.includes("- Answer: line one line two with extra spaces"), "newlines and repeated whitespace collapsed to single spaces");
}

// --- existing plain multi-line Answer block is fully replaced, trailing blanks preserved ---
{
  const before = [
    "---",
    "project: proj-a",
    "convention: session-coordination v1",
    "updated: 2026-09-10",
    "---",
    "",
    "# Questions",
    "",
    "## Open",
    "",
    "### Q-2026-09-01-06 Existing multi-line answer",
    "- Answer: old line one",
    "  old line two continuation",
    "- Asked by: s, 2026-09-01",
    "",
    "",
    "### Q-2026-09-01-07 Next question",
    "- Answer:",
    "",
    "## Answered",
    "",
    "(none)",
    "",
  ].join("\n");
  const after = spliceAnswer(before, "Q-2026-09-01-06", "brand new single line", "2026-09-18");
  assert.ok(after.includes("- Answer: brand new single line"));
  assert.ok(!after.includes("old line one"));
  assert.ok(!after.includes("old line two continuation"));
  assert.ok(after.includes("- Asked by: s, 2026-09-01"), "the following bullet (Asked by) is untouched");
  // Trailing blank-line run before the next "### Q-..." heading is preserved (two blank lines).
  const afterLines = after.split("\n");
  const askedIdx = afterLines.indexOf("- Asked by: s, 2026-09-01");
  assert.equal(afterLines[askedIdx + 1], "", "first trailing blank preserved");
  assert.equal(afterLines[askedIdx + 2], "", "second trailing blank preserved");
  assert.equal(afterLines[askedIdx + 3], "### Q-2026-09-01-07 Next question", "next question heading undisturbed");
  // The next question's own body is completely untouched.
  assert.ok(after.includes("### Q-2026-09-01-07 Next question\n- Answer:\n"), "the sibling question's block is byte-identical");
}

// --- unknown question id -> null (heading not found) ---
{
  const before = questionsFile(["### Q-2026-09-01-08 Some question", "- Answer:", ""]);
  assert.equal(spliceAnswer(before, "Q-2026-09-99-99", "x", "2026-09-18"), null, "an id with no matching heading returns null");
}

// --- no "## Open" section at all -> null ---
{
  const before = "---\nproject: p\n---\n\n# Questions\n\n## Answered\n\n(none)\n";
  assert.equal(spliceAnswer(before, "Q-2026-09-01-01", "x", "2026-09-18"), null, "no '## Open' heading -> null");
}

// =====================================================================
// Reviewer round 2, I-4: the regex's REJECT boundary, through the SAME
// model.mjs import path main.ts's Save button uses. A save next to each of
// these must leave the decoy line byte-identical and insert a NEW line
// rather than overwriting it (mirrors the vault suite's own boundary pins).
// =====================================================================

{
  const before = questionsFile([
    "### Q-2026-09-02-01 Has an unrelated Answered: bullet",
    "- **Answered:** yes, filed as D-2026-09-02-01",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-02-01", "the real answer", "2026-09-18");
  assert.ok(after);
  assert.match(after, /- \*\*Answered:\*\* yes, filed as D-2026-09-02-01\n- Answer: the real answer\n/, "'Answered:' bullet survives untouched, new line appended after it");
}

{
  const before = questionsFile([
    "### Q-2026-09-02-02 Has an indented sub-bullet",
    "- Context: has a nested list",
    "  - Answer: nested text, not the question's field",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-02-02", "the real answer", "2026-09-18");
  assert.ok(after);
  assert.match(after, /  - Answer: nested text, not the question's field\n- Answer: the real answer\n/, "indented sub-bullet survives untouched, new line appended after it");
}

{
  const before = questionsFile([
    "### Q-2026-09-02-03 Has prose mentioning Answer: mid-sentence",
    "- Note: see Answer: inside this sentence",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-02-03", "the real answer", "2026-09-18");
  assert.ok(after);
  assert.match(after, /- Note: see Answer: inside this sentence\n- Answer: the real answer\n/, "mid-sentence prose survives untouched, new line appended after it");
}

// --- M-3: an Answer-shaped line inside a fenced code block is never the real field ---
{
  const before = questionsFile([
    "### Q-2026-09-02-04 Has a fenced template example",
    "- Context: template below",
    "```",
    "- **Answer:** <fill in>",
    "```",
    "- Answer: old real answer",
    "",
  ]);
  const after = spliceAnswer(before, "Q-2026-09-02-04", "new real answer", "2026-09-18");
  assert.ok(after);
  assert.match(after, /```\n- \*\*Answer:\*\* <fill in>\n```\n- Answer: new real answer\n/, "the fence and its example are untouched, only the real line outside it changed");
}

// =====================================================================
// Reviewer round 3, Important I-5 (new defect introduced by round 2's M-3
// fix): fence detection was whole-file, so one unbalanced/mismatched fence
// anywhere above a question marked every LATER question as "fenced" --
// reads went blank and every save inserted another Answer line next to the
// one it could no longer find. Fixed in the vault lib (computeBlockFence,
// per-question-block, same-character-close, unclosed-means-not-a-fence).
// Mirrored here through the SAME model.mjs import path main.ts uses, plus
// parseQuestionsOpen directly (also vault-canonical) for the read side.
// =====================================================================

function multiQuestionFile2(bodyLines) {
  return [
    "---", "project: proj-a", "convention: session-coordination v1", "updated: 2026-09-10", "---", "",
    "# Questions", "",
    "## Open", "",
    ...bodyLines,
    "## Answered", "",
    "(none)", "",
  ].join("\n");
}

// --- Shape 1: unclosed fence in one question must not blank out a sibling ---
{
  const before = multiQuestionFile2([
    "### Q-2026-09-03-01 Has an unclosed fence",
    "- Context: pasted output below",
    "```",
    "some output that never closes",
    "- Asked by: s, 2026-09-03",
    "",
    "### Q-2026-09-03-02 A plain sibling question",
    "- Answer: yes do it",
    "",
  ]);
  const entries = parseQuestionsOpen(before);
  assert.equal(entries.find((e) => e.id === "Q-2026-09-03-02").answer, "yes do it", "the sibling is not blanked by Q1's unclosed fence");

  let cur = before;
  for (let i = 0; i < 3; i++) cur = spliceAnswer(cur, "Q-2026-09-03-02", `round ${i}`, "2026-09-1" + i);
  assert.equal((cur.match(/^- Answer:/gm) || []).length, 1, "exactly one Answer line after 3 saves, no pile-up");
}

// --- Shape 2: a standalone one-line fence marker never closes within the block ---
{
  const before = multiQuestionFile2([
    "### Q-2026-09-03-03 Has a standalone one-line fence marker",
    "- Context: see below",
    "```npm test```",
    "- Answer: yes",
    "",
  ]);
  const entries = parseQuestionsOpen(before);
  assert.equal(entries[0].answer, "yes");

  let cur = before;
  for (let i = 0; i < 3; i++) cur = spliceAnswer(cur, "Q-2026-09-03-03", `round ${i}`, "2026-09-1" + i);
  assert.equal((cur.match(/^- Answer:/gm) || []).length, 1);
  assert.match(cur, /```npm test```\n- Answer: round 2\n/);
}

// --- Shape 3: a fence line above "## Open" entirely has no effect ---
{
  const before = [
    "---", "project: proj-a", "convention: session-coordination v1", "updated: 2026-09-10", "---", "",
    "# Questions", "",
    "```", "(stray fence-looking line before ## Open)", "",
    "## Open", "",
    "### Q-2026-09-03-04 A plain question after the stray fence above the section",
    "- Answer: yes",
    "",
    "## Answered", "",
    "(none)", "",
  ].join("\n");
  const entries = parseQuestionsOpen(before);
  assert.equal(entries[0].answer, "yes");
  let cur = before;
  for (let i = 0; i < 3; i++) cur = spliceAnswer(cur, "Q-2026-09-03-04", `round ${i}`, "2026-09-1" + i);
  assert.equal((cur.match(/^- Answer:/gm) || []).length, 1);
}

// --- Shape 4: a ~~~ fence containing a ``` line -- mismatched char must not close it ---
{
  const before = multiQuestionFile2([
    "### Q-2026-09-03-05 Has a ~~~ fence containing a ``` line",
    "- Context: outer fence uses ~~~",
    "~~~",
    "- **Answer:** fake, still inside the ~~~ fence despite the ``` line below",
    "```",
    "~~~",
    "- Answer: the real answer",
    "",
    "### Q-2026-09-03-06 A plain sibling question",
    "- Answer: also fine",
    "",
  ]);
  const entries = parseQuestionsOpen(before);
  assert.equal(entries.find((e) => e.id === "Q-2026-09-03-05").answer, "the real answer");
  assert.equal(entries.find((e) => e.id === "Q-2026-09-03-06").answer, "also fine");

  let cur = before;
  for (let i = 0; i < 3; i++) cur = spliceAnswer(cur, "Q-2026-09-03-05", `round ${i}`, "2026-09-1" + i);
  assert.equal((cur.match(/^- Answer:/gm) || []).length, 2, "one per question, none swallowed by the fence");
}

// --- Same-character boundary probe (distinguishes "closer must match the opener's
// character" from "any long-enough run closes any fence" -- shape 4 above does NOT
// distinguish this, since its mismatched-then-matched closer pair hides the same
// content either way) ---
{
  const before = multiQuestionFile2([
    "### Q-2026-09-03-08 Same-char boundary probe",
    "- Context: c",
    "~~~",
    "- **Answer:** fake near the top, must stay hidden either way",
    "```",
    "- Answer: text that must stay hidden under correct char-matching, since the ~~~ fence is still open here",
    "~~~",
    "- Asked by: s, 2026-09-03",
    "",
  ]);
  const entries = parseQuestionsOpen(before);
  assert.equal(entries[0].answer, "", "both Answer-shaped lines are still inside the ~~~ fence (it only closes on the LATER ~~~, not the mismatched ``` in between)");
  const after = spliceAnswer(before, "Q-2026-09-03-08", "the real save", "2026-09-18");
  assert.match(after, /- Asked by: s, 2026-09-03\n- Answer: the real save\n/, "insert at the end, not an overwrite of the line that must stay hidden");
}

// --- A balanced fence still works (M-3 preserved through the round-3 rewrite) ---
{
  const before = multiQuestionFile2([
    "### Q-2026-09-03-07 Balanced fenced template",
    "- Context: template below",
    "```",
    "- **Answer:** <fill in>",
    "```",
    "- Answer: old real answer",
    "",
  ]);
  const entries = parseQuestionsOpen(before);
  assert.equal(entries[0].answer, "old real answer");
  const after = spliceAnswer(before, "Q-2026-09-03-07", "new real answer", "2026-09-18");
  assert.match(after, /```\n- \*\*Answer:\*\* <fill in>\n```\n- Answer: new real answer\n/);
}

console.log("spliceAnswerModel.test.mjs: all assertions passed");
