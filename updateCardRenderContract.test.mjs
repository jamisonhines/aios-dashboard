import "./testFileTimeout.mjs";
// Review m-1 (2026-10-23): main.ts only draws what createUpdateController decides. These pins fail
// if the button, the modal callback or the spawn timeout is wired around the tested controller.
import assert from "node:assert";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const start = source.indexOf("function renderUpdateCard(");
assert.ok(start > 0, "RC-0 renderUpdateCard exists");
const render = source.slice(start, source.indexOf("\n}\n", start));

for (const required of [
  "const updateController = createUpdateController({",
  "runEngine: runUpdateEngine,",
  "updateController.ensureChecked();",
  "const v = updateController.view();",
  "if (v.showUpdate) {",
  "const req = updateController.requestUpdate();",
  "new UpdateConfirmModal(app, req.body, req.confirmLabel, req.go).open();",
  "checkBtn.disabled = v.checkDisabled;",
  "updateController.checkNow();",
]) assert.ok(source.includes(required), `RC-1 main.ts wiring includes: ${required}`);

// The render function draws the button only inside the showUpdate branch, and hands the modal the controller's go().
const buttonAt = render.indexOf("aios-update-go");
const branchAt = render.indexOf("if (v.showUpdate) {");
assert.ok(buttonAt > branchAt && branchAt > 0, "RC-2 the Update button is created only inside if (v.showUpdate)");

// The card never builds an apply argv, never chooses the code flag and never kills apply itself.
for (const banned of ["buildApplyArgv", "allowCode", "startUpdateApply", "startUpdateCheck", "UPDATE_APPLY_TIMEOUT_MS", "--allow-code", "--expect-commit"]) {
  assert.ok(!source.includes(banned), `RC-3 main.ts does not contain ${banned}`);
}
// The spawn helper only arms a kill timer when it is given a number (apply passes null).
const spawnAt = source.indexOf("function runUpdateEngine(");
const spawnBody = source.slice(spawnAt, source.indexOf("\n}\n", spawnAt));
assert.match(spawnBody, /if \(typeof opts\.timeoutMs === "number"\) \{\s*const t = setTimeout\(/, "RC-4 the kill timer is armed only for a numeric timeout");
assert.match(spawnBody, /started: false/, "RC-5 a launch that never started says so (nothing ran)");
console.log("updateCardRenderContract.test.mjs: all assertions passed");
