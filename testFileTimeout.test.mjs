import "./testFileTimeout.mjs";
import assert from "node:assert";
import { spawn } from "node:child_process";
const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["--import", "./testFileTimeout.mjs", "-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, AIOS_TEST_FILE_TIMEOUT_MS: "40" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => stderr += d); child.once("exit", (code) => resolve({ code, stderr }));
});
assert.equal(result.code, 1, `timeout must fail and exit, got ${JSON.stringify(result)}`);
assert.match(result.stderr, /TEST FILE TIMEOUT/, `timeout must identify itself, got ${JSON.stringify(result)}`);
console.log("test-file timeout: hard unref timer failed and exited a hung process");
