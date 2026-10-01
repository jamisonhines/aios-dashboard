// Offline searched, measured hue ranges; no generated colours at runtime.
// Reproduce with dev/search-usage-palettes.mjs; see docs/usage-palettes.md.
export const USAGE_PROVIDER_PALETTES = {
  claude: { light: ['#d1b200','#e300b4','#6d3a71','#e098c8','#ba0000','#ff5d00'], dark: ['#b29200','#a05600','#cb7885','#cd00a5','#854571','#e40042'] },
  openai: { light: ['#196130','#00bfff','#00a300','#0078bc','#2c00f2'], dark: ['#0f6593','#00a6aa','#6100fb','#708cef','#387c4a'] },
  local: { light: ['#8f4bff'], dark: ['#b547ff'] },
};
export const USAGE_EXPLICIT_MODEL_SLOTS = {
  'claude-sonnet-5': { provider:'claude', slot:0 },
  'claude-opus-5': { provider:'claude', slot:1 },
  'claude-opus-5-5': { provider:'claude', slot:2 },
  'claude-sonnet-5-5': { provider:'claude', slot:3 },
  'claude-haiku-4-5-20251001': { provider:'claude', slot:4 },
  'openai-codex/gpt-6-astra': { provider:'openai', slot:0 },
  'openai-codex/gpt-5.6-terra': { provider:'openai', slot:1 },
  'openai-codex/gpt-6-sol': { provider:'openai', slot:2 },
  'openai-codex/gpt-6.1-sol': { provider:'openai', slot:3 },
  'usage-group:local:all': { provider:'local', slot:0 },
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
