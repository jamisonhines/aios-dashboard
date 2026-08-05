// Tests for the dashboard undo-stack pure helpers: pushUndoEntry, popUndoEntry,
// undoEntryStillSafe, mutationNoticeText, undoNoticeText, undoConflictNoticeText,
// undoEmptyNoticeText, undoCollisionNoticeText, isEditableEventTarget,
// taskStatusActionLabel. Run: node undoModel.test.mjs
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
  undoCollisionNoticeText,
  isEditableEventTarget,
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
  mutationNoticeText(entry("x", { label: 'Marked "Ship it" done' }), true),
  'Marked "Ship it" done. Cmd+Z to undo.',
  "leaf view: mutation notice names the action and hints Cmd+Z"
);
assert.equal(
  mutationNoticeText(entry("x", { label: 'Marked "Ship it" done' }), false),
  'Marked "Ship it" done.',
  "embed (no Cmd+Z available): mutation notice must NOT promise the shortcut"
);
assert.equal(
  undoNoticeText(entry("x", { label: 'Marked "Ship it" done' })),
  'Undone: Marked "Ship it" done.',
  "undo notice names what was undone"
);
assert.equal(undoConflictNoticeText(), "AIOS: changed on disk since, not undoing.", "conflict notice text");
assert.equal(undoEmptyNoticeText(), "AIOS: nothing to undo.", "empty-stack notice text");
assert.equal(
  undoCollisionNoticeText("Operations/tasks/open/tsk-1.md"),
  'AIOS: could not undo -- "Operations/tasks/open/tsk-1.md" already exists.',
  "collision notice names the blocking path"
);

// --- retry-on-throw (Reviewer Min3): a popped entry that undoLastMutation
// could not apply (thrown failure, or the Min2 move-back collision) goes
// BACK onto the stack via the same push primitive, so the next Undo click
// retries it once the obstruction clears. Model-level: pop-then-repush must
// restore the exact same stack (order + identity), not a lossy variant.
// Only a tamper refusal skips this -- that path never repushes, it just
// drops the entry, which is exercised by popUndoEntry alone above. This is
// also the "one stack, plugin-owned" contract: push/pop operate on a bare
// array, which is exactly what plugin.undoStack now is (Reviewer M2 moved
// it off the old per-root WeakMap).
const retryStack = [entry("r1"), entry("r2")];
const { entry: poppedForRetry, stack: afterPop } = popUndoEntry(retryStack);
const requeued = pushUndoEntry(afterPop, poppedForRetry);
assert.deepEqual(requeued, retryStack, "pop-then-repush (retry-on-throw) restores the exact same stack");

// --- isEditableEventTarget (Reviewer M1: don't swallow native text undo) ---
assert.equal(isEditableEventTarget("INPUT", false), true, "input elements are editable targets");
assert.equal(isEditableEventTarget("input", false), true, "tag-name match is case-insensitive");
assert.equal(isEditableEventTarget("TEXTAREA", false), true, "textarea elements are editable targets");
assert.equal(isEditableEventTarget("DIV", true), true, "contenteditable wins regardless of tag name");
assert.equal(isEditableEventTarget("BUTTON", false), false, "a plain button is not an editable target");
assert.equal(isEditableEventTarget(null, false), false, "no tag name, not contenteditable -> not editable");
assert.equal(isEditableEventTarget(undefined, false), false, "undefined tag name is handled safely");

// --- taskStatusActionLabel ---
assert.equal(taskStatusActionLabel("Completed", "Ship it"), 'Marked "Ship it" done', "Completed gets the 'done' phrasing");
assert.equal(taskStatusActionLabel("Started", "Ship it"), 'Started "Ship it"', "other verbs pass through");
assert.equal(taskStatusActionLabel("Cancelled", "Ship it"), 'Cancelled "Ship it"', "Cancelled phrasing");
assert.equal(taskStatusActionLabel("Reopened", "Ship it"), 'Reopened "Ship it"', "Reopened phrasing");

console.log("undoModel: all assertions passed");
