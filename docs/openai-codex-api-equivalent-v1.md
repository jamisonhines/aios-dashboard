# `openai-codex-api-equivalent-v1` provenance

**Retrieved: 2026-09-16**  
**Effective for this exporter:** the local OpenAI Codex base rate card available on that date.  
**Units:** USD per million tokens (USD/Mtok).

This is the local provenance record for the dashboard's API-equivalent estimates. It is not a statement of OpenAI subscription billing, allowance, quota, or entitlement.

## Exact local sources

Primary rate source, inspected on the retrieval date:

- `/Users/jaymo/.pi/agent/models-store.json` — active `openai-codex` model catalog, including each model's `cost` object, `tiers`, and `contextWindow`.

Cross-check source, inspected on the retrieval date:

- `/Users/jaymo/AIOS/.pi/npm/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json` — installed Pi provider catalog containing the same model rate objects.

Observed token-field/cost cross-check (not used to infer missing rates):

- `/Users/jaymo/.pi/agent/sessions/--Users-jaymo-AIOS--/2026-09-14T04-30-43-670Z_01a09e2e-83d6-7286-abd7-b122fb79c725.jsonl` — `gpt-5.5` records with separate input, output, cache-read, and cache-write values/costs. It confirms the catalog's zero separate cache-write price for that model.

The older comparison document `/Users/jaymo/AIOS/Projects/aios-model-migration/aios-model-migration.md` identifies the candidate Codex models and 272K concern, but it is **not** a rate authority for this card: its Sol cached-input comparison value differs from the active catalogs.

## Base rate card used by the exporter

All rates below are the base tier from the local catalogs, applied to their corresponding normalized transcript buckets.

| Model | Input | Cache read | Cache write | Output | Applicable token tier |
| --- | ---: | ---: | ---: | ---: | --- |
| gpt-5.5 | 5 | 0.5 | 0 | 30 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-5.6-luna | 0.2 | 0.02 | 0.25 | 1.2 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-5.6-sol | 5 | 0.5 | 6.25 | 30 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-5.6-terra | 2 | 0.2 | 2.5 | 12 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-6-astra | 10 | 1 | 12.5 | 50 | base tier; `inputTokensAbove` 272,000 is not selected |

### Cache-write semantics

`cacheRead` is priced from the normalized `cache_read_input_tokens` / Pi `cacheRead` bucket. `cacheWrite` is priced from normalized `cache_creation_input_tokens` / Pi `cacheWrite`; it is a separate cache-creation charge, not a multiplier derived from input price. A value of zero means the catalog specifies no separate cache-write charge for that model, not that the transcript has no cached input.

## 272K higher-tier limitation

The same local catalogs establish a higher tier when `inputTokensAbove` is 272,000:

| Model | Input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.5 | 10 | 1 | 0 | 45 |
| gpt-5.6-luna | 0.4 | 0.04 | 0.5 | 1.8 |
| gpt-5.6-sol | 10 | 1 | 12.5 | 45 |
| gpt-5.6-terra | 4 | 0.4 | 5 | 18 |
| gpt-6-astra | 20 | 2 | 25 | 75 |

The exporter intentionally does **not** select those higher rates. Current transcript entries expose independent fresh-input, cache-read, cache-write, and output buckets, but do **not expose a reliable per-entry threshold discriminator** for the catalog's `inputTokensAbove` condition. Deriving it from one bucket or an ad-hoc sum would invent a billing rule. Therefore every `openai-codex-api-equivalent-v1` estimate deliberately uses the base rates above, including entries whose actual provider billing could have qualified for the 272K tier. The serialized `costSemantics` metadata and Usage-tab footer disclose this limitation.
