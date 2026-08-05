// Tests for the dashboard undo-stack pure helpers: pushUndoEntry, popUndoEntry,
// undoEntryStillSafe, mutationNoticeText, undoNoticeText, undoConflictNoticeText,
// undoEmptyNoticeText, taskStatusActionLabel. Run: node undoModel.test.mjs
import assert from "node:assert";
import {
  UNDO_STACK_CAP,
  pushUndoEntry,
  popUndoEntry,
  undoEntryStillSafe,
  mutationNoticeText,
  undoNoticeText,
  undoConflictNoticeText,
  undoEmptyNoticeText,
  taskStatusActionLabel,
} from "./model.mjs";

const entry = (id, overrides) => ({
  id,
  label: `Marked "task ${id}" done`,
  kind: "edit-move",
  pathAfter: `Operations/tasks/done/2026/08/tsk-${id}.md`,
  contentAfter: `content-after-${id}`,
  pathBefore: `Operations/tasks/open/tsk-${id}.md`,
  contentBefore: `content-before-${id}`,
  ...overrides,
});

// --- pushUndoEntry ---
assert.equal(UNDO_STACK_CAP, 20, "cap is 20");
let stack = [];
stack = pushUndoEntry(stack, entry("1"));
assert.equal(stack.length, 1, "push grows the stack");
assert.equal(stack[0].id, "1", "entry stored");

const before = [];
const after = pushUndoEntry(before, entry("2"));
assert.deepEqual(before, [], "pushUndoEntry does not mutate the input array");
assert.equal(after.length, 1, "returns a new array with the entry");

// cap eviction: pushing 21 entries keeps only the most recent 20, oldest first dropped.
let capped = [];
for (let i = 1; i <= 25; i++) capped = pushUndoEntry(capped, entry(String(i)));
assert.equal(capped.length, 20, "stack capped at 20");
assert.equal(capped[0].id, "6", "oldest entries evicted (1-5 dropped)");
assert.equal(capped[19].id, "25", "newest entry retained at the end");

// --- popUndoEntry ---
const emptyPop = popUndoEntry([]);
assert.equal(emptyPop.entry, null, "pop on empty stack returns null entry");
assert.deepEqual(emptyPop.stack, [], "pop on empty stack returns an (empty) stack");

let s2 = [entry("a"), entry("b"), entry("c")];
const pop1 = popUndoEntry(s2);
assert.equal(pop1.entry.id, "c", "pop returns the most recently pushed entry (LIFO)");
assert.deepEqual(
  pop1.stack.map((e) => e.id),
  ["a", "b"],
  "pop removes only the top entry"
);
assert.deepEqual(
  s2.map((e) => e.id),
  ["a", "b", "c"],
  "popUndoEntry does not mutate the input array"
);

// --- undoEntryStillSafe ---
const e = entry("safe");
assert.equal(undoEntryStillSafe(e, "content-after-safe"), true, "matching content is safe to undo");
assert.equal(undoEntryStillSafe(e, "content-after-safe-EDITED"), false, "changed content refuses undo");
assert.equal(undoEntryStillSafe(e, undefined), false, "missing current content refuses undo");
assert.equal(undoEntryStillSafe(e, 123), false, "non-string current content refuses undo");

// --- notice text builders ---
assert.equal(
  mutationNoticeText(entry("x", { label: 'Marked "Ship it" done' })),
  'Marked "Ship it" done. Cmd+Z to undo.',
  "mutation notice names the action and hints Cmd+Z"
);
assert.equal(
  undoNoticeText(entry("x", { label: 'Marked "Ship it" done' })),
  'Undone: Marked "Ship it" done.',
  "undo notice names what was undone"
);
assert.equal(undoConflictNoticeText(), "AIOS: changed on disk since, not undoing.", "conflict notice text");
assert.equal(undoEmptyNoticeText(), "AIOS: nothing to undo.", "empty-stack notice text");

// --- taskStatusActionLabel ---
assert.equal(taskStatusActionLabel("Completed", "Ship it"), 'Marked "Ship it" done', "Completed gets the 'done' phrasing");
assert.equal(taskStatusActionLabel("Started", "Ship it"), 'Started "Ship it"', "other verbs pass through");
assert.equal(taskStatusActionLabel("Cancelled", "Ship it"), 'Cancelled "Ship it"', "Cancelled phrasing");
assert.equal(taskStatusActionLabel("Reopened", "Ship it"), 'Reopened "Ship it"', "Reopened phrasing");

console.log("undoModel: all assertions passed");
