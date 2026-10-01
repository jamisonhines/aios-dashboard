// Fixed provider palettes. Values and validation are documented in docs/usage-palettes.md.
// Bundled CSS avoids requiring an extra deployed file. Only fixed palette
// steps are emitted; model ranks and filters never participate.
export function usagePaletteStyles(palettes = USAGE_PROVIDER_PALETTES) {
  return Object.entries(palettes).flatMap(([provider, modes]) =>
    modes.light.map((light, slot) => {
      const bar = `.aios-dashboard-root .aios-usage-bar-${provider}-${slot}`;
      const dot = `.aios-dashboard-root .aios-usage-dot-${provider}-${slot}`;
      return `${bar}{fill:${light}}${dot}{background:${light}}.theme-dark ${bar}{fill:${modes.dark[slot]}}.theme-dark ${dot}{background:${modes.dark[slot]}}`;
    })
  ).join("\n");
}
export const USAGE_PROVIDER_PALETTES = {
  "claude": {
    "light": [
      "#854000",
      "#fe77bd",
      "#8f3600",
      "#ff767c",
      "#9e1900",
      "#e89c00",
      "#970663",
      "#f49300",
      "#a30026",
      "#ff7f37",
      "#883f00",
      "#ff73bd",
      "#923500",
      "#ff7279",
      "#a11400",
      "#e99a00",
      "#9a0064",
      "#f59100",
      "#a60024",
      "#ff7c2f",
      "#8a3f00",
      "#ff70bc",
      "#943400",
      "#ff6e77"
    ],
    "dark": [
      "#924b00",
      "#e15ca3",
      "#9c4200",
      "#ee5a63",
      "#ac2900",
      "#cc8200",
      "#a41c6e",
      "#d87800",
      "#b01530",
      "#eb640d",
      "#944b00",
      "#e259a3",
      "#9f4100",
      "#ef5661",
      "#af2600",
      "#cd8000",
      "#a7186f",
      "#d97600",
      "#b30e2f",
      "#ec6000",
      "#974b00",
      "#e355a2",
      "#a14000",
      "#f1525e"
    ]
  },
  "openai": {
    "light": [
      "#006b00",
      "#8ea0ff",
      "#006f2d",
      "#1cb5ff",
      "#00714f",
      "#53ca5d",
      "#3d40b7",
      "#00cf83",
      "#0056b2",
      "#00d0a6",
      "#006c00",
      "#8c9eff",
      "#00712c",
      "#00b4ff",
      "#00724f",
      "#4dca59",
      "#3d3fbb",
      "#00ce80",
      "#0056b6",
      "#00d0a5",
      "#006e00",
      "#8a9cff",
      "#00722b",
      "#00b3ff"
    ],
    "dark": [
      "#177225",
      "#7a89e7",
      "#007642",
      "#3699e2",
      "#00775b",
      "#53a858",
      "#4a54ae",
      "#1fab73",
      "#0064a9",
      "#00ac8c",
      "#167324",
      "#7988e7",
      "#007742",
      "#3398e2",
      "#00785b",
      "#51a757",
      "#4b55b0",
      "#17ab72",
      "#0065ab",
      "#00ac8b",
      "#157524",
      "#7887e7",
      "#007843",
      "#2f97e2"
    ]
  },
  "local": {
    "light": [
      "#644089",
      "#c099ea",
      "#663f88",
      "#c298e9",
      "#683e88",
      "#c497e8",
      "#693d87",
      "#c596e7",
      "#6b3d86",
      "#c795e6",
      "#6d3c86",
      "#c993e4",
      "#6f3b85",
      "#cb92e3",
      "#703a84",
      "#cd91e2",
      "#723a83",
      "#cf90e0",
      "#743982",
      "#d08fdf",
      "#763881",
      "#d28edd",
      "#773780",
      "#d48ddb"
    ],
    "dark": [
      "#6f4b95",
      "#a67fce",
      "#714a94",
      "#a87ecd",
      "#734994",
      "#a97dcc",
      "#754993",
      "#ab7ccb",
      "#774893",
      "#ad7bca",
      "#784792",
      "#af7ac9",
      "#7a4691",
      "#b079c8",
      "#7c4690",
      "#b278c6",
      "#7e458f",
      "#b477c5",
      "#80448e",
      "#b576c3",
      "#82438d",
      "#b775c2",
      "#83438c",
      "#b973c0"
    ]
  }
};

export const USAGE_EXPLICIT_MODEL_SLOTS = {
  "claude-fable-5-1": {
    "provider": "claude",
    "slot": 0
  },
  "claude-opus-5": {
    "provider": "claude",
    "slot": 1
  },
  "claude-opus-5-5": {
    "provider": "claude",
    "slot": 2
  },
  "claude-sonnet-5": {
    "provider": "claude",
    "slot": 3
  },
  "claude-sonnet-5-5": {
    "provider": "claude",
    "slot": 4
  },
  "claude-opus-4-8": {
    "provider": "claude",
    "slot": 5
  },
  "claude-haiku-4-5-20251001": {
    "provider": "claude",
    "slot": 6
  },
  "claude-fable-5": {
    "provider": "claude",
    "slot": 7
  },
  "fable": {
    "provider": "claude",
    "slot": 8
  },
  "opus": {
    "provider": "claude",
    "slot": 9
  },
  "sonnet": {
    "provider": "claude",
    "slot": 10
  },
  "haiku": {
    "provider": "claude",
    "slot": 11
  },
  "other": {
    "provider": "claude",
    "slot": 12
  },
  "openai-codex/gpt-5.5": {
    "provider": "openai",
    "slot": 0
  },
  "openai-codex/gpt-5.6-luna": {
    "provider": "openai",
    "slot": 1
  },
  "openai-codex/gpt-5.6-sol": {
    "provider": "openai",
    "slot": 2
  },
  "openai-codex/gpt-5.6-terra": {
    "provider": "openai",
    "slot": 3
  },
  "openai-codex/gpt-6-astra": {
    "provider": "openai",
    "slot": 4
  },
  "openai-codex/gpt-6-sol": {
    "provider": "openai",
    "slot": 5
  },
  "openai-codex/gpt-6.1-sol": {
    "provider": "openai",
    "slot": 6
  },
  "openai-codex/gpt-6-luna": {
    "provider": "openai",
    "slot": 8
  },
  "openai-codex/codex-auto-review": {
    "provider": "openai",
    "slot": 7
  }
};
