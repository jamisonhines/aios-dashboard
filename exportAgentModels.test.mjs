import "./testFileTimeout.mjs";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testResolveNativeModelConfigForNode, buildAgentModelsSnapshot, loadCustomModels, mergeCatalogs, parseCachedCatalog, parseAgentFrontmatter } from "./vault-scripts/export-agent-models.mjs";
import { catalogCandidates, safeFallbackCandidates } from "./model.mjs";

assert.deepEqual(parseCachedCatalog('{"openrouter":{"models":[{"id":"openai/gpt-a"}]}}').providers, [{ id: "openrouter", access: "catalog-only", availability: "unknown", models: ["openrouter/openai/gpt-a"], sources: ["cached catalog"] }]);
assert.equal(parseCachedCatalog("not json").error, "cached model catalog is malformed");
const vault = await fs.mkdtemp(path.join(os.tmpdir(), "agent-model-export-"));
try {
  const userHome = path.join(vault, "user"); const agentDir = path.join(userHome, ".pi", "agent"); await fs.mkdir(path.join(vault, ".pi", "agents", "nested"), { recursive: true }); await fs.mkdir(agentDir, { recursive: true });
  const customPath = path.join(agentDir, "models.json");
  const qwenStyle = "\uFEFF// Pi JSONC comment\n{\n  \"providers\": {\n    \"local-runtime\": {\n      \"baseUrl\": \"http://PRIVATE_HOST/v1\",\n      \"api\": \"openai-completions\",\n      \"apiKey\": \"!PRIVATE_COMMAND_CANARY\",\n      \"headers\": { \"authorization\": \"PRIVATE_HEADER\" },\n      \"models\": [{ \"id\": \"qwen-local\", \"thinkingLevelMap\": { \"high\": \"high\" }, \"samplingParams\": { \"temperature\": 0.2 }, }, { \"id\": \"future-local-model\" },],\n      \"modelOverrides\": { \"known\": { \"contextWindow\": 1024 } },\n    },\n  },\n}\n";
  await fs.writeFile(customPath, qwenStyle);
  const custom = await loadCustomModels(customPath);
  assert.equal(custom.error, null, "native Pi 0.85.1 ModelConfig accepts valid BOM, comments, trailing commas, headers, overrides, thinking map, sampling parameters, and Qwen-style configuration");
  assert.deepEqual(custom.providers, [{ id: "local-runtime", access: "configured", availability: "unknown", models: ["local-runtime/future-local-model", "local-runtime/qwen-local"], sources: ["Pi 0.85.1 user models.json"] }], "native boundary exports only exact validated provider/model identities");
  assert.ok(!JSON.stringify(custom).includes("PRIVATE_"), "native adapter output never leaks or resolves private values");
  for (const [name, invalid] of Object.entries({
    blockComment: "{/* Pi rejects block comments */ \"providers\": {}}",
    numericHeader: '{"providers":{"local":{"baseUrl":"http://localhost/v1","api":"openai-completions","headers":{"Authorization":3},"models":[{"id":"x"}]}}}',
    overrideWindow: '{"providers":{"local":{"baseUrl":"http://localhost/v1","api":"openai-completions","models":[{"id":"x"}],"modelOverrides":{"x":{"contextWindow":"large"}}}}}',
    thinkingNumber: '{"providers":{"local":{"baseUrl":"http://localhost/v1","api":"openai-completions","models":[{"id":"x","thinkingLevelMap":{"high":4}}]}}}',
    samplingArray: '{"providers":{"local":{"baseUrl":"http://localhost/v1","api":"openai-completions","models":[{"id":"x","samplingParams":[]}]}}}'
  })) { await fs.writeFile(customPath, invalid); const result = await loadCustomModels(customPath); assert.equal(result.providers.length, 0, `${name}: invalid native custom source yields no identities`); assert.equal(result.error, "Pi rejected custom models.json syntax/schema; run Pi validation locally.", `${name}: native rejection is safe and actionable`); }
  await fs.writeFile(customPath, qwenStyle);
  assert.deepEqual(mergeCatalogs(parseCachedCatalog('{"local-runtime":{"models":[{"id":"qwen-local"},{"id":"cached-only"}]}}'), await loadCustomModels(customPath)), [{ id: "local-runtime", access: "configured", availability: "unknown", models: ["local-runtime/cached-only", "local-runtime/future-local-model", "local-runtime/qwen-local"], sources: ["Pi 0.85.1 user models.json", "cached catalog"] }], "validated native custom and cache identities dedupe exactly");
  await fs.writeFile(path.join(vault, ".pi", "agents", "nested", "tooling.md"), '---\nname: tooling\nmodel: bare-model\n---\n');
  await fs.writeFile(path.join(vault, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { tooling: { model: false, systemPrompt: "PRIVATE_CANARY" } } } }));
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}");
  const snapshot = await buildAgentModelsSnapshot({ vaultRoot: vault, userHome, modelsStoreRaw: '{"openrouter":{"models":[{"id":"openai/gpt-a"}]}}' });
  assert.ok(snapshot.catalog.providers.some((provider) => provider.models.includes("local-runtime/future-local-model")), "future native-valid local model reaches snapshot automatically");
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE_"), "snapshot retains strict custom privacy boundary");
  const beforeValid = await fs.readFile(customPath, "utf8");
  const validReadSnapshot = await buildAgentModelsSnapshot({ vaultRoot: vault, userHome, modelsStoreRaw: '{"cached":{"models":[{"id":"safe"}]}}' });
  assert.equal(await fs.readFile(customPath, "utf8"), beforeValid, "read-only snapshot API preserves valid user models.json bytes");
  assert.ok(validReadSnapshot.catalog.providers.some((provider) => provider.id === "local-runtime"));
  const malformedSecret = '{"providers":{"bad":{"apiKey":s3cr3t}}}'; await fs.writeFile(customPath, malformedSecret);
  const beforeInvalid = await fs.readFile(customPath, "utf8"); const invalidSnapshot = await buildAgentModelsSnapshot({ vaultRoot: vault, userHome, modelsStoreRaw: '{"cached":{"models":[{"id":"safe"}]}}' });
  assert.equal(await fs.readFile(customPath, "utf8"), beforeInvalid, "read-only snapshot API preserves invalid user models.json bytes");
  assert.equal(invalidSnapshot.catalog.providers.some((provider) => provider.id === "bad"), false, "native-rejected custom source never reaches picker catalog"); assert.equal(invalidSnapshot.catalog.error, "Pi rejected custom models.json syntax/schema; run Pi validation locally."); assert.ok(!JSON.stringify(invalidSnapshot).includes("s3cr3t"), "native parse errors never serialize malformed private canaries");
  const fakePrefix = path.join(vault, "fake-prefix"), fakeNode = path.join(fakePrefix, "bin", "node"), fakeRoot = path.join(fakePrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), outside = path.join(vault, "outside-canary.js");
  await fs.mkdir(path.dirname(fakeNode), { recursive: true }); await fs.writeFile(fakeNode, "not node"); await fs.mkdir(path.join(fakeRoot, "dist", "core"), { recursive: true }); await fs.writeFile(path.join(fakeRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" })); await fs.writeFile(outside, "globalThis.__outsideCanary=true; export class ModelConfig {};"); await fs.symlink(outside, path.join(fakeRoot, "dist", "core", "model-config.js"));
  await assert.rejects(() => __testResolveNativeModelConfigForNode(fakeNode), /untrusted Pi ModelConfig module/); assert.equal(globalThis.__outsideCanary, undefined, "module symlink escape is rejected before importing outside code");
  const fakePrefixRootLink = path.join(vault, "fake-prefix-root-link"), fakeNodeRootLink = path.join(fakePrefixRootLink, "bin", "node"), fakeExpectedRoot = path.join(fakePrefixRootLink, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), fakeOutsidePackage = path.join(vault, "outside-package"); await fs.mkdir(path.dirname(fakeNodeRootLink), { recursive: true }); await fs.writeFile(fakeNodeRootLink, "not node"); await fs.mkdir(path.dirname(fakeExpectedRoot), { recursive: true }); await fs.mkdir(fakeOutsidePackage); await fs.symlink(fakeOutsidePackage, fakeExpectedRoot); await assert.rejects(() => __testResolveNativeModelConfigForNode(fakeNodeRootLink), /untrusted Pi package root/); assert.equal(globalThis.__outsideCanary, undefined, "package-root symlink escape is rejected before importing code");
  const activeCatalog = { providers: parseCachedCatalog('{"openrouter":{"models":[{"id":"openai/gpt-a"}]}}').providers.map((provider) => ({ ...provider, access: "connected", availability: "active" })) };
  assert.deepEqual(catalogCandidates(activeCatalog, ["openrouter"]), ["openrouter/openai/gpt-a"]); assert.deepEqual(safeFallbackCandidates(activeCatalog, "other/primary", ["openrouter"]), ["openrouter/openai/gpt-a"]);
  assert.deepEqual(parseAgentFrontmatter('---\nname: tooling\nfallbackModels: p/b, p/c\n---\n'), { name: "tooling", package: null, model: null, fallbackModels: ["p/b", "p/c"] });
} finally { await fs.rm(vault, { recursive: true, force: true }); }
console.log("exportAgentModels: all assertions passed");
