// Offline searched, measured hue ranges; no generated colours at runtime.
// Reproduce with dev/search-usage-palettes.mjs; see docs/usage-palettes.md.
export const USAGE_PROVIDER_PALETTES = {
  claude: { light: ['#d1b200','#f75e1c','#ff00cf','#b10030'], dark: ['#f35077','#b40019','#ba0091','#9d7300'] },
  openai: { light: ['#365d1b','#006ba9','#00a15f','#00bcfa'], dark: ['#007748','#0065a9','#57ac00','#27a7a8'] },
  local: { light: ['#9f59ff','#dc99cd','#7e0d93'], dark: ['#9475b8','#7700ff','#de28ff'] },
};
export const USAGE_EXPLICIT_MODEL_SLOTS = {
  'claude-sonnet-5': { provider:'claude', slot:0 },
  'claude-opus-5': { provider:'claude', slot:1 },
  'claude-opus-5-5': { provider:'claude', slot:2 },
  'openai-codex/gpt-6-astra': { provider:'openai', slot:0 },
  'openai-codex/gpt-5.6-terra': { provider:'openai', slot:1 },
  'openai-codex/gpt-5.6-sol': { provider:'openai', slot:2 },
  'qwen3.6:35b-a3b-coding-mtp-q4_K_M': { provider:'local', slot:0 },
  'ollama-bench-131k/qwen3.8:27b': { provider:'local', slot:1 },
  'ollama-bench-131k-topp/qwen3.8:27b': { provider:'local', slot:2 },
};
export const USAGE_PROVIDER_LABELS = {claude:'Claude',openai:'OpenAI',local:'Local'};
export function usagePaletteStyles(palettes = USAGE_PROVIDER_PALETTES) {
  return Object.entries(palettes).flatMap(([provider, modes]) =>
    modes.light.map((light, slot) => {
      const bar = `.aios-dashboard-root .aios-usage-bar-${provider}-${slot}`;
      const dot = `.aios-dashboard-root .aios-usage-dot-${provider}-${slot}`;
      return `${bar}{fill:${light}}${dot}{background:${light}}.theme-dark ${bar}{fill:${modes.dark[slot]}}.theme-dark ${dot}{background:${modes.dark[slot]}}`;
    })
  ).join('\n');
}
