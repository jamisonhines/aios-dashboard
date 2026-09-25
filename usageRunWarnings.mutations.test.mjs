import assert from "node:assert";
import { spawn } from "node:child_process";
const child = await new Promise((resolve) => { const c = spawn(process.execPath, ["usageRunWarnings.test.mjs"], { env: { ...process.env, AIOS_USAGE_WARNINGS_MUTATIONS: "1" }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; c.stdout.on("data", d => stdout += d); c.stderr.on("data", d => stderr += d); c.once("exit", code => resolve({ code, stdout, stderr })); });
assert.equal(child.code, 0, `usage warning mutations must pass: ${child.stderr}`);
for (const phrase of ["R4-M1 MUTATION", "M11 MUTATION", "N5 MUTATION"]) assert.match(child.stdout, new RegExp(phrase), `mutation runner must execute ${phrase}`);
process.stdout.write(child.stdout);
