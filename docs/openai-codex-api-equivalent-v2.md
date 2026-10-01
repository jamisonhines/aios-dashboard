# `openai-codex-api-equivalent-v2` provenance

**Retrieved: 2026-10-01**  
**Effective for this exporter:** the local OpenAI Codex base rate card available on that date.  
**Units:** USD per million tokens (USD/Mtok).

This is the local provenance record for API-equivalent estimates, not subscription billing, allowance, quota, or entitlement.

## Exact local sources

Primary source: `~/.pi/agent/models-store.json`, active `openai-codex` models' `cost` objects (base tier).

Cross-check: `<vault>/.pi/npm/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json`, the installed Pi provider catalog named in v1. Its five v1 rows agree unchanged. It does not yet contain gpt-6-sol, gpt-6.1-sol, or gpt-6-luna, so those three rows are supported by the active primary catalog, not independently corroborated by the installed catalog. There is no conflicting installed rate for them. No rate is inferred from transcript costs or a model's name.

The source locations use home/vault-relative notation to avoid publishing machine-specific paths. V1 remains the historical record; its rate rows are unchanged.

## Base rate card used by the exporter

| Model | Input | Cache read | Cache write | Output | Applicable token tier |
| --- | ---: | ---: | ---: | ---: | --- |
| gpt-5.5 | 5 | 0.5 | 0 | 30 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-5.6-luna | 0.2 | 0.02 | 0.25 | 1.2 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-5.6-sol | 5 | 0.5 | 6.25 | 30 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-5.6-terra | 2 | 0.2 | 2.5 | 12 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-6-astra | 10 | 1 | 12.5 | 50 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-6-sol | 2 | 0.2 | 2.5 | 10 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-6.1-sol | 2 | 0.1 | 2.5 | 10 | base tier; `inputTokensAbove` 272,000 is not selected |
| gpt-6-luna | 0.1 | 0.01 | 0.125 | 0.5 | base tier; `inputTokensAbove` 272,000 is not selected |

### Cache-write semantics

`cacheRead` prices normalized `cache_read_input_tokens` / Pi `cacheRead`. `cacheWrite` prices normalized `cache_creation_input_tokens` / Pi `cacheWrite`, a separate cache-creation charge. Zero is a catalog rate, not evidence of absent cached input. Codex sessions map inclusive `input_tokens` minus `cached_input_tokens` to uncached input, cached input to cache read, and `cache_write_input_tokens` to cache write. Reasoning output is already part of output and is not added again.

## 272K higher-tier limitation

| Model | Input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.5 | 10 | 1 | 0 | 45 |
| gpt-5.6-luna | 0.4 | 0.04 | 0.5 | 1.8 |
| gpt-5.6-sol | 10 | 1 | 12.5 | 45 |
| gpt-5.6-terra | 4 | 0.4 | 5 | 18 |
| gpt-6-astra | 20 | 2 | 25 | 75 |
| gpt-6-sol | 4 | 0.4 | 5 | 15 |
| gpt-6.1-sol | 4 | 0.2 | 5 | 15 |
| gpt-6-luna | 0.2 | 0.02 | 0.25 | 0.75 |

V2 deliberately uses base rates for all entries, as v1 did. Transcripts lack a reliable per-entry discriminator for the catalog's `inputTokensAbove` condition. Inferring a threshold from an ad-hoc sum would invent a billing rule. Serialized `costSemantics` and the Usage footer disclose this limitation. A missing model remains unpriced, including `codex-auto-review`.
