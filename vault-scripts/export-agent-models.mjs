#!/usr/bin/env node
// Manual, local-only Pi configuration snapshot. It never opens auth.json,
// executes config values, or exports keys, headers, endpoints, or credentials.
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withOwnedExportLock, writeJsonAtomic } from "./export-json-atomic.mjs";

const digest = (raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const modelValue = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const list = (value) => typeof value === "string" ? value.replace(/^\[|\]$/g, "").split("\n").flatMap((line) => (line.trim().replace(/^-\s+/, "")).split(",")).map((item) => item.trim().replace(/^["\']|["\']$/g, "")).filter(Boolean) : [];
async function readOptional(file) { try { return await fs.readFile(file, "utf8"); } catch { return null; } }
function parseSettings(raw, label) { if (raw == null) return { value: {}, error: null }; try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? { value, error: null } : { value: {}, error: `${label} is not a JSON object` }; } catch { return { value: {}, error: `${label} is malformed` }; } }

// Native Pi boundary adapter. ModelConfig is internal, not a stable package export.
// The only trusted candidate is beneath the current Node installation prefix.
const PI_MODEL_CONFIG_VERSION = "0.85.1";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const isContained = (root, candidate) => { const relative = path.relative(root, candidate); return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
async function safeOwnedOrdinary(file) {
  const stat = await fs.lstat(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  return stat.isFile() && stat.uid === uid && (stat.mode & 0o022) === 0;
}
async function safeOwnedDirectory(directory) {
  const stat = await fs.lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
}
async function resolveNativeModelConfigForNode(nodePath) {
  const node = await fs.realpath(nodePath);
  const prefix = path.dirname(path.dirname(node));
  const expectedRoot = path.join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  const root = await fs.realpath(expectedRoot);
  if (root !== expectedRoot || !isContained(prefix, root) || !(await safeOwnedDirectory(root))) throw new Error("untrusted Pi package root");
  const packageFile = path.join(root, "package.json"); const moduleFile = path.join(root, "dist", "core", "model-config.js");
  const modulePath = await fs.realpath(moduleFile);
  if (!isContained(root, modulePath) || !(await safeOwnedOrdinary(modulePath)) || !(await safeOwnedOrdinary(packageFile))) throw new Error("untrusted Pi ModelConfig module");
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (pkg?.name !== PI_PACKAGE || pkg?.version !== PI_MODEL_CONFIG_VERSION) throw new Error("incompatible Pi package");
  return { modulePath, version: pkg.version };
}
export const __testResolveNativeModelConfigForNode = resolveNativeModelConfigForNode;
async function findPiModelConfig() {
  try { return await resolveNativeModelConfigForNode(process.execPath); }
  catch { throw new Error(`Pi ${PI_MODEL_CONFIG_VERSION} credential-blind ModelConfig is unavailable or incompatible with this Node installation. Run the exporter with the supported Pi installation.`); }
}
export async function loadCustomModels(modelsPath) {
  let native;
  try { native = await findPiModelConfig(); }
  catch (error) { return { providers: [], error: error instanceof Error ? error.message : "Pi custom models adapter unavailable." }; }
  let ModelConfig;
  try { ({ ModelConfig } = await import(pathToFileURL(native.modulePath).href)); }
  catch { return { providers: [], error: "Pi custom models adapter unavailable." }; }
  if (!ModelConfig || typeof ModelConfig.load !== "function") return { providers: [], error: "Pi custom models adapter unavailable." };
  const config = await ModelConfig.load(modelsPath);
  if (config.getError()) return { providers: [], error: "Pi rejected custom models.json syntax/schema; run Pi validation locally." };
  const providers = config.getProviderIds().flatMap((id) => {
    const provider = config.getProvider(id);
    const models = Array.isArray(provider?.models) ? [...new Set(provider.models.map((model) => modelValue(model?.id)).filter(Boolean).map((model) => `${id}/${model}`))].sort() : [];
    return models.length ? [{ id, access: "configured", availability: "unknown", models, sources: [`Pi ${native.version} user models.json`] }] : [];
  });
  return { providers: providers.sort((a, b) => a.id.localeCompare(b.id)), error: null };
}
export function parseCachedCatalog(raw) {
  if (raw == null) return { providers: [], error: "cached model catalog is missing" };
  let store; try { store = JSON.parse(raw); } catch { return { providers: [], error: "cached model catalog is malformed" }; }
  if (!store || typeof store !== "object" || Array.isArray(store)) return { providers: [], error: "cached model catalog is malformed" };
  const root = store.providers && typeof store.providers === "object" ? store.providers : store;
  const providers = Object.entries(root).flatMap(([id, entry]) => {
    const rawModels = Array.isArray(entry) ? entry : Array.isArray(entry?.models) ? entry.models : [];
    const models = [...new Set(rawModels.map((item) => typeof item === "string" ? item : item?.id).filter((item) => typeof item === "string" && item.trim()).map((item) => `${id}/${item}`))].sort();
    return models.length ? [{ id, access: "catalog-only", availability: "unknown", models, sources: ["cached catalog"] }] : [];
  });
  return providers.length ? { providers: providers.sort((a, b) => a.id.localeCompare(b.id)), error: null } : { providers: [], error: "cached model catalog has no usable provider models" };
}
export function mergeCatalogs(...catalogs) {
  const byId = new Map();
  for (const catalog of catalogs) for (const provider of catalog.providers || []) {
    const previous = byId.get(provider.id) || { id: provider.id, access: "catalog-only", availability: "unknown", models: [], sources: [] };
    previous.models = [...new Set([...previous.models, ...provider.models])].sort(); previous.sources = [...new Set([...previous.sources, ...(provider.sources || [])])].sort();
    if (provider.access === "configured") previous.access = "configured";
    byId.set(provider.id, previous);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function parseAgentFrontmatter(text) {
  const match = typeof text === "string" && text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { name: null, package: null, model: null, fallbackModels: [] };
  const fields = {}; let key = null;
  for (const raw of match[1].split("\n")) { const entry = raw.match(/^([\w-]+):\s*(.*)$/); if (entry) { key = entry[1]; fields[key] = entry[2].replace(/^["']|["']$/g, ""); continue; } if (key && /^\s+/.test(raw)) fields[key] += `\n${raw.trim()}`; else key = null; }
  return { name: modelValue(fields.name), package: modelValue(fields.package), model: modelValue(fields.model), fallbackModels: list(fields.fallbackModels) };
}
async function listProjectAgents(root) { const output = []; async function visit(dir) { let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await visit(file); else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) output.push(file); } } await visit(root); return output.sort(); }
function ordinaryOverride(settings, name) { return settings?.subagents?.agentOverrides?.[name]; }
function providerOverridePresent(settings, name) { return Object.values(settings?.subagents?.agentOverridesByProvider || {}).some((agents) => agents?.[name] !== undefined); }
function cleanOverride(source, override) { if (!override || typeof override !== "object") return null; return { source, ...(Object.prototype.hasOwnProperty.call(override, "model") ? { model: override.model === false ? null : modelValue(override.model) } : {}), ...(Object.prototype.hasOwnProperty.call(override, "fallbackModels") ? { fallbackModels: Array.isArray(override.fallbackModels) ? override.fallbackModels.filter((v) => typeof v === "string") : override.fallbackModels === false ? [] : undefined } : {}) }; }
function choose(agent, user, project) { const userOverride = ordinaryOverride(user, agent.name); const projectOverride = ordinaryOverride(project, agent.name); const has = (object, key) => object && Object.prototype.hasOwnProperty.call(object, key); const pick = has(projectOverride, "model") ? projectOverride.model : has(userOverride, "model") ? userOverride.model : agent.model; const fallback = has(projectOverride, "fallbackModels") ? projectOverride.fallbackModels : has(userOverride, "fallbackModels") ? userOverride.fallbackModels : agent.fallbackModels; const defaultModel = project?.subagents?.defaultModel ?? user?.subagents?.defaultModel ?? null; const model = pick === "inherit" || pick === false ? null : modelValue(pick) || modelValue(defaultModel); const source = pick === false ? "runtime parent model (model cleared by override)" : has(projectOverride, "model") ? "project agent override" : has(userOverride, "model") ? "user agent override" : agent.model === "inherit" ? "parent session model (inherit)" : agent.model ? "project agent frontmatter" : defaultModel ? "subagents.defaultModel" : "parent session model"; return { model, source, fallbackModels: Array.isArray(fallback) ? fallback.filter((v) => typeof v === "string" && v !== model) : [], overrides: [cleanOverride("user agent override", userOverride), cleanOverride("project agent override", projectOverride)].filter(Boolean) }; }
export async function buildAgentModelsSnapshot({ vaultRoot, userHome = os.homedir(), modelsStoreRaw } = {}) {
  if (!vaultRoot) throw new Error("vaultRoot is required"); const projectPath = path.join(vaultRoot, ".pi", "settings.json"); const projectRaw = await readOptional(projectPath); const userRaw = await readOptional(path.join(userHome, ".pi", "agent", "settings.json")); const project = parseSettings(projectRaw, "project Pi settings"); const user = parseSettings(userRaw, "user Pi settings");
  const cached = parseCachedCatalog(modelsStoreRaw === undefined ? await readOptional(path.join(userHome, ".pi", "agent", "models-store.json")) : modelsStoreRaw);
  const customPath = path.join(userHome, ".pi", "agent", "models.json");
  const custom = await loadCustomModels(customPath); const providers = mergeCatalogs(cached, custom);
  const agents = []; for (const file of await listProjectAgents(path.join(vaultRoot, ".pi", "agents"))) { const parsed = parseAgentFrontmatter(await readOptional(file) || ""); if (!parsed.name) continue; const effective = choose(parsed, user.value, project.value); const canonical = !parsed.package; agents.push({ name: parsed.name, requested: { model: parsed.model, fallbackModels: parsed.fallbackModels }, effective: { model: effective.model, source: effective.source, fallbackModels: effective.fallbackModels }, runtimeOnly: providerOverridePresent(user.value, parsed.name) || providerOverridePresent(project.value, parsed.name), supported: canonical, ...(canonical ? { writeTarget: ".pi/settings.json", writePrecondition: { digest: digest(projectRaw || "") } } : { unsupportedReason: "Package-qualified project agent requires native package discovery; read-only." }), overrides: effective.overrides }); }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), catalog: { source: "pi-models-store-cache+user-models-json", freshness: "unknown", providers, ...([cached.error, custom.error].filter(Boolean).length ? { error: [cached.error, custom.error].filter(Boolean).join(". ") } : {}) }, errors: [project.error, user.error].filter(Boolean), agents };
}
export async function main(vaultRoot = process.argv[2] || process.cwd()) { const snapshot = await buildAgentModelsSnapshot({ vaultRoot }); const output = path.join(vaultRoot, "Operations", "agent-models.json"); const result = await withOwnedExportLock(output, ({ isOwner }) => writeJsonAtomic(output, snapshot, { beforeRename: isOwner })); if (result.busy) { console.log(`agent-models export busy; another writer holds ${output}.lock`); return; } console.log(`agent-models: ${snapshot.agents.length} agent(s) -> ${output}`); }
const direct = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url; if (direct) main().catch((error) => { console.error("agent-models: export failed:", error?.message || error); process.exitCode = 1; });
