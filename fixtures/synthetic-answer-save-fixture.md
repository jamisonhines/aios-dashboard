---
project: synthetic-fixture-project
convention: session-coordination v1
updated: 2026-01-01
---

# Questions for Jaymo

Synthetic fixture, Reviewer round 2 (I-2). Every question below is fictional:
made-up project name, made-up session names, made-up dates, made-up content.
No customer name, no supplier data, no cost figure, no login address, no
security detail from any real project appears anywhere in this file. It
exists only to reproduce, in a shape safe to commit and push, the exact
Answer-line formats that made the real vagabond-ops-app/questions.md fail to
splice, plus the negative/edge cases Reviewer round 2 asked for.

## Open

### Q-2026-01-01-01 A normal question, already has a plain answer
- Context: control case, must be unaffected by the fix either way.
- Asked by: session-alpha, 2026-01-01
- Answer: yes, proceed as planned

### Q-2026-01-01-02 A normal question, blank plain Answer line
- Context: control case, already worked before the fix (plain form).
- Asked by: session-alpha, 2026-01-01
- Answer:

### Q-2026-01-01-03 Bold-colon Answer line, blank
- Context: reproduces the real Q-2026-09-17-07 shape exactly.
- Asked by: session-bravo, 2026-01-01
- **Answer:**

### Q-2026-01-01-04 Bold-label Answer line, blank
- Context: the other bold sub-variant, colon outside the emphasis run.
- Asked by: session-bravo, 2026-01-01
- **Answer**:

### Q-2026-01-01-05 Bold-colon Answer line WITH text already recorded
- Context: proves the READ side (extractAnswerText / isCoordinationQuestionAnswered)
  honours the bold form too, not just the write side. This exact shape is
  additionally exercised end-to-end through computeCoordinationView in
  coordinationModel.test.mjs (Reviewer round 2 M-6), the real plugin read
  path this claim is about, not just against the vault lib directly.
- Asked by: session-charlie, 2026-01-01
- **Answer:** partial info already recorded by hand

### Q-2026-01-01-06 Missing Answer line entirely, nothing else unusual
- Context: reproduces the plain "no Answer field at all" shape.
- Asked by: session-delta, 2026-01-01

### Q-2026-01-01-07 Missing Answer line, has an ANSWERED narrative bullet instead
- Asked: session-echo, 2026-01-01, while planning a synthetic scenario.
- **ANSWERED 2026-01-01 by Jaymo, CONDITIONALLY.** Verbatim: "do the default
  thing for now, revisit later." Filed as [[#D-2026-01-01-01]]. This bullet
  must survive a save byte-identical, in its original position -- reproduces
  the real Q-2026-09-18-01 shape exactly.

### Q-2026-01-01-08 Missing Answer line, with a multi-line Context bullet before it
- Context: this context wraps onto a second line here
  and a third line too, so the insertion point must land AFTER all of it,
  not in the middle of the continuation.
- Asked by: session-foxtrot, 2026-01-01

### Q-2026-01-01-09 Has an unrelated "- **Answered:**" bullet plus a real blank Answer line
- Context: the label is "Answered", not "Answer" -- must never be confused with the real field.
- **Answered:** this is someone's own field named Answered, not the question's Answer
- Asked by: session-golf, 2026-01-01
- Answer:

### Q-2026-01-01-10 Has an indented sub-bullet "  - Answer:" plus a real top-level blank Answer line
- Context: has a nested list
  - Answer: this is a NESTED bullet's own text, not the question's Answer field
- Asked by: session-hotel, 2026-01-01
- Answer:

### Q-2026-01-01-11 Has prose mentioning "Answer:" mid-sentence plus a real top-level blank Answer line
- Note: see Answer: inside this sentence, which is not a field line at all
- Asked by: session-india, 2026-01-01
- Answer:

### Q-2026-01-01-12 Has a fenced template example plus a real blank Answer line outside it
- Context: template shown below for reference
```
- **Answer:** <fill in the answer here>
```
- Answer:

## Answered

### Q-2025-12-01-01 Already answered and filed, for section-boundary coverage
- Context: proves a splice never reaches into the Answered section.
- Asked by: session-juliet, 2025-12-01
- Answer: filed already, this must never be touched by any test above
