# Model Market Comparison For Refinely

Date: 2026-04-18

## Executive Recommendation

### Best default provider-native pair today

Use **Anthropic** with:

- **Light:** `claude-3-5-haiku-20241022`
- **Heavy:** `claude-sonnet-4-20250514`

Why:

- Best current fit for Refinely's actual runtime shape: fast structured clarify/decomposition plus stronger AR generation.
- Lowest integration risk in the current codebase because Anthropic thinking is already wired through the wrapper.
- Stronger heavy-lane safety than OpenAI right now because Refinely does **not** currently pass reasoning controls to GPT-5.x models.

### Best cost-optimized provider-native pair today

Use **Gemini** with:

- **Light:** `gemini-2.5-flash-lite`
- **Heavy:** `gemini-2.5-pro`

Why:

- Best price/performance among currently supported hosted providers.
- Stable model family, strong throughput, structured outputs, and thinking support.
- Best choice when latency and cost matter more than absolute top-end AR-writing quality.

### Best quality-first provider-native pair today

Use **Anthropic** with:

- **Light:** `claude-sonnet-4-20250514`
- **Heavy:** `claude-opus-4-1-20250805`

Why:

- Best practical heavy lane for the hardest AR-writing and cross-feature reasoning work.
- More usable than OpenAI `gpt-5.4-pro` for Refinely because `gpt-5.4-pro` drops structured outputs and is much slower.

### Best structured-output / long-context alternative

Use **OpenAI** with:

- **Light:** `gpt-5.4-mini`
- **Heavy:** `gpt-5.4`

Why:

- Excellent structured-output posture, long context, and tool support.
- Very competitive on cost versus Anthropic.
- Becomes more attractive if Refinely fixes the OpenAI reasoning gating bug in `src/core/llm.ts`.

## What The Codebase Actually Does

These constraints materially change the recommendation:

1. Refinely is **single-provider per run** today.
   - `provider` is global in the generator config, and light/heavy assignments are provider-scoped.
   - That means an "ideal" cross-provider route like Gemini light + Claude heavy is **not** shippable without new multi-provider routing.

2. `balanced` does **not** route heavy to both Decomposition and AR today.
   - Runtime source of truth in `src/services/model-strategy.ts:130-133` is:
     - `clarifyModel: light`
     - `decompositionModel: light`
     - `arModel: heavy`
   - UI copy in `src/frontend/src/SettingsView.tsx:1491` currently says balanced uses heavy for Decomposition + ARs. The code and UI are out of sync.

3. OpenAI and Azure OpenAI are partially underwired for GPT-5.x reasoning.
   - `src/core/llm.ts:126-129` only enables `reasoning: { effort }` for `o*` models.
   - `gpt-5.4` and `gpt-5.4-mini` support reasoning controls in the API, but Refinely does not currently send them.

4. Structured output reliability matters more here than generic chatbot quality.
   - Refinely is a multi-stage JSON-heavy workflow.
   - Current wrappers:
     - OpenAI / Azure OpenAI: `response_format: { type: 'json_object' }`
     - Gemini: `responseMimeType = 'application/json'` when not thinking
     - Ollama: `response_format: { type: 'json_object' }`
     - Anthropic: prompt-led JSON plus repair logic, not vendor-enforced JSON mode

## Representative Cost Model

The cost numbers below are **directional normalized estimates**, not billing forecasts.

They model a representative `balanced` Refinely run:

- Light lane total: **25k input + 2k output**
  - discovery assessment
  - clarify generation
  - decomposition
- Heavy lane total: **20k input + 21k output-equivalent**
  - AR generation
  - includes a reasoning-heavy uplift to reflect balanced/quality AR work

This is intentionally conservative for vendor comparison and reflects:

- current stage shape in `src/core/story-assistant-default.ts`
- AR reasoning emphasis from `docs/quality-improvement-plan.md:168-239`

## Comparison Matrix

Scores are Refinely-fit scores from 1 to 5, where 5 is best.

| Candidate pair | Clarify quality | AR quality | JSON reliability | Speed / throughput | Cost efficiency | Integration fit | Approx. balanced run cost | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Anthropic: `Haiku 3.5` + `Sonnet 4` | 4 | 5 | 3 | 4 | 3 | 5 | **$0.403** | **Best overall default today** |
| OpenAI: `GPT-5.4 mini` + `GPT-5.4` | 4 | 4 | 5 | 4 | 3 | 3 | **$0.393** | Best structured-output alternative; improve after wrapper fix |
| Gemini: `2.5 Flash-Lite` + `2.5 Pro` | 3 | 4 | 4 | 5 | 5 | 4 | **$0.238** | **Best cost-optimized default today** |
| Azure OpenAI: `GPT-5.4-mini` + `GPT-5.4` | 4 | 4 | 5 | 3 | 3 | 2 | **$0.393** | Best enterprise-hosted OpenAI path; rollout friction matters |
| Anthropic quality: `Sonnet 4` + `Opus 4.1` | 5 | 5 | 3 | 2 | 1 | 4 | **$1.980** | **Best quality-first pair** |
| Ollama: `qwen2.5:14b` + `qwen2.5:72b` or `deepseek-v3` | 2 | 2 | 3 | 2 | n/a | 4 | n/a | Privacy / control fallback, not default quality path |
| Mistral near-term: `mistral-small-2603` + `mistral-medium-2508` | 3 | 4 | 5 | 4 | 5 | 1 | **$0.055** | Most promising near-term integration candidate |
| xAI near-term: `grok-4-1-fast-reasoning` + `grok-4.20-reasoning` | 4 | 4 | 5 | 5 | 4 | 1 | **$0.172** | Most interesting near-term frontier challenger |
| Groq near-term: `openai/gpt-oss-20b` + `openai/gpt-oss-120b` | 2 | 3 | 5 | 5 | 5 | 1 | **$0.018** | Fastest lab option, not a default AR-quality choice yet |

## Recommended Defaults By Provider Family

### Anthropic

- **Ship now:** `claude-3-5-haiku-20241022` light + `claude-sonnet-4-20250514` heavy
- **Quality-first fallback:** `claude-sonnet-4-20250514` light + `claude-opus-4-1-20250805` heavy

### OpenAI

- **Ship after wrapper fix:** `gpt-5.4-mini` light + `gpt-5.4` heavy
- **Lower-risk fallback:** `gpt-4.1-mini` light + `gpt-4.1` heavy if you prefer a non-reasoning, lower-variance path

### Gemini

- **Best value:** `gemini-2.5-flash-lite` light + `gemini-2.5-pro` heavy
- **Higher-speed fallback:** `gemini-2.5-flash` light + `gemini-2.5-pro` heavy

### Azure OpenAI

- **Enterprise default where available:** `gpt-5.4-mini` light + `gpt-5.4` heavy
- **Availability fallback:** `gpt-4.1-mini` light + `gpt-4.1` heavy

### Ollama

- **Practical local pair:** `qwen2.5:14b` light + `qwen2.5:72b` heavy
- **Alternative heavy:** `deepseek-v3`

Note: Ollama should be treated as a privacy / control path, not the default quality path.

### Near-term additions worth integrating

- **Mistral:** `mistral-small-2603` light + `mistral-medium-2508` heavy
- **xAI:** `grok-4-1-fast-reasoning` light + `grok-4.20-reasoning` heavy
- **Groq:** `openai/gpt-oss-20b` light + `openai/gpt-oss-120b` heavy

## Scenario Validation

### 1. Short focused ask with low ambiguity

- Winner: **Gemini 2.5 Flash-Lite + 2.5 Pro**
- Reason: lowest cost, highest throughput, enough structure discipline for simple clarify + generation.

### 2. Ambiguous workflow-heavy ask needing strong clarification

- Winner: **Anthropic Haiku 3.5 + Sonnet 4**
- Reason: better clarify quality and better heavy-lane recovery for ARs, while still fast enough in interactive use.

### 3. Large multi-feature ask needing decomposition plus richer ARs

- Winner: **Anthropic Sonnet 4 + Opus 4.1** for quality-first
- Practical production default: **Anthropic Haiku 3.5 + Sonnet 4**
- OpenAI becomes competitive here once GPT-5 reasoning controls are actually sent by Refinely.

## Risks, Caveats, And Watch List

### Highest-impact caveats

- OpenAI recommendations are artificially weakened by the current wrapper bug that withholds GPT-5 reasoning controls.
- Anthropic is the best current operational fit, but its current Refinely wrapper does not enforce vendor-native JSON mode the way OpenAI, Gemini, and Ollama do.
- Azure OpenAI is strong for enterprise constraints, but model availability and feature parity remain region- and rollout-dependent.
- Ollama cost is not directly comparable to hosted APIs; infra cost, ops burden, and model quality dominate.

### Watch list

- **Mistral Small 4 / Medium 3.1:** strongest near-term price-performance candidate if Refinely adds Mistral.
- **xAI Grok 4.20 / 4.1 Fast:** strongest near-term premium challenger if tool-calling and structured output prove stable in evals.
- **Groq GPT-OSS 120B / 20B:** extremely compelling for speed labs and batch-style experimentation, but not yet the safest default for AR quality.

### Repo drift worth fixing soon

- `src/frontend/src/modelStrategyCatalog.json` appears partially stale relative to current official vendor catalogs.
- Azure catalog entries are empty in the bundled strategy catalog.
- The balanced-profile UI copy should be aligned with the actual route.

## Bottom Line

If you want the safest production move **today**, keep Refinely on **Anthropic** and set:

- `light = claude-3-5-haiku-20241022`
- `heavy = claude-sonnet-4-20250514`

If you want the best current **cost / speed** profile on supported providers, move to **Gemini** with:

- `light = gemini-2.5-flash-lite`
- `heavy = gemini-2.5-pro`

If you want the strongest **next upgrade candidate**, fix the GPT-5 reasoning wiring and re-evaluate **OpenAI GPT-5.4 mini + GPT-5.4**.

If you are willing to add one new provider, **Mistral** is the most compelling near-term integration target, with **xAI** next and **Groq** as the speed-first experiment track.

## Sources

- OpenAI models and pricing:
  - https://developers.openai.com/api/docs/models
  - https://developers.openai.com/api/docs/models/gpt-5.4
  - https://developers.openai.com/api/docs/models/gpt-5.4-mini
  - https://developers.openai.com/api/docs/models/gpt-5.4-pro
- Anthropic models and pricing:
  - https://docs.anthropic.com/en/docs/about-claude/models/all-models
  - https://docs.anthropic.com/en/docs/about-claude/pricing
- Gemini models, pricing, deprecations, and quotas:
  - https://ai.google.dev/models/gemini
  - https://ai.google.dev/pricing
  - https://ai.google.dev/gemini-api/docs/deprecations
  - https://ai.google.dev/gemini-api/docs/quota
- Azure OpenAI model availability:
  - https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models
  - https://learn.microsoft.com/en-us/azure/ai-foundry/azure-openai-in-ai-foundry
- Mistral:
  - https://docs.mistral.ai/getting-started/models
  - https://docs.mistral.ai/models/mistral-small-4-0-26-03
  - https://docs.mistral.ai/models/mistral-medium-3-1-25-08
  - https://docs.mistral.ai/models/magistral-medium-1-2-25-09
- xAI:
  - https://docs.x.ai/docs/overview
  - https://x.ai/api
  - https://docs.x.ai/docs/models
- Groq:
  - https://console.groq.com/docs/models
  - https://console.groq.com/docs/model/openai/gpt-oss-120b
  - https://console.groq.com/docs/model/llama-3.1-8b-instant
