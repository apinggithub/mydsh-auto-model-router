# dsh-auto-model-router

A hybrid auto model-router plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Routes each agent request through **four capability levels (L0–L3)** with three user-facing routing modes: a zero-latency **heuristic lock** (text-width thresholds), a **fixed-level** mode, and **fully-auto** mode (keyword scoring + optional LLM classifier). Failure fallback chains and budget control round it out.

> Design inspired by [open-world-project/model-router](https://github.com/open-world-project/model-router) (Hermes Agent) and [opencode-model-router](https://github.com/marco-jardim/opencode-model-router) (fast/medium/heavy tiers): tiered routing plus a cost mode that decides the drift direction on ambiguity.

## Acknowledgements

This plugin builds on ideas from the following open-source projects:

- [open-world-project/model-router](https://github.com/open-world-project/model-router) — Hermes Agent's auto model-router with keyword scoring and cost-aware tier selection
- [opencode-model-router](https://github.com/marco-jardim/opencode-model-router) — OpenCode's fast/medium/heavy tier delegation plugin
- [openclaw-routing-yaml](https://github.com/glasshousehq-os/openclaw-routing-yaml) — OpenClaw's declarative per-task model routing via YAML
- [openmarkai/openclaw-router](https://github.com/openmarkai/openclaw-router) — Benchmark-driven model routing with real evaluation data
- [MoeAisaka/openclaw-model-policy-router](https://github.com/MoeAisaka/openclaw-model-policy-router) — Policy-driven fail-closed model routing for OpenClaw
- [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode) — DSH's auto permission mode; inspired the client settings section pattern
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — The host platform this plugin is built for

- English (this file)
- [中文](README.zh.md)

## How it works

One decision is made **per user input** (not per agent step). Steps within the
same input reuse the decision — the LLM classifier is never called per step.

```
user input (new)
  │
  ▼
┌─ current mode?
│
│ MODE A heuristic lock (default)
│   text width of the last N inputs (CJK=2, other=1)
│   ├─ ≤10  → L0
│   ├─ ≤100 → L1 (locked)
│   └─ >100 → ask once: pin a fixed level? enable fully-auto?
│
│ MODE B fixed level
│   use the pinned level; re-ask every askEveryInputs inputs
│   window falls back ≤100 → return to MODE A
│
│ MODE C fully-auto
│   ① keyword scoring: L1 hits +1, L2 +2, L3 +3 (weights configurable)
│      0 → L0 · 1-5 → L1 · 6-15 → L2 · 16+ → L3 (bands configurable)
│   ② score 0 → LLM classifier on 本次+上次输入+上次回复
│   ③ window falls back ≤100 → return to MODE A
└──────────────────────────────────────────────────────
  │
  ▼
agent/request reuses the decision for every step of this input
  │
  ▼
LLM dispatch
```

### The four levels

| Level | Typical tasks | Model guidance |
| --- | --- | --- |
| `L0` | everyday chat, quick answers | cheapest/fastest |
| `L1` | small edits, simple tests | regular |
| `L2` | writing code, review, refactoring | strong |
| `L3` | complex bug fixes, multi-step tasks, reports | most powerful |

Each level is a user-assigned provider/model route with a **required**
`reasoningEffort` (defaults to `off` when omitted): `off` = no thinking mode,
`high`/`max` = thinking intensity. Levels may be left unconfigured; the router
then falls to the nearest configured level (direction depends on the cost
mode).

## Auto mode in the model selector

The plugin registers a virtual `auto` provider, so the model selector shows an
**Auto Router** group with a single **Auto** model:

```
Auto Router
  └─ Auto
deepseek-official
  ├─ deepseek-v4-flash
  └─ deepseek-v4-flash
```

- Pick **Auto** → this plugin routes the session through the L0–L3 levels.
- Pick any **real model** → the plugin passes the request through untouched;
  your explicit choice wins and the router stays out of the way.

### Settings section (browser)

The browser half registers an **Auto Router** page in DSH's settings panel
(gear icon → sidebar). It renders the current routing policy — the same
`<dsh-auto-model-router-status>` report the host injects on session start —
with a hint telling you to change the configuration through AI conversation:
just tell the agent in chat (e.g. *"change L2 to deepseek-v4-flash with max
reasoning"* or *"switch cost mode to cost-first"*), and the AI edits
`cordis.patch.yml` for you; restart DSH to apply.

Selecting **Auto** in the model picker applies immediately — there is no
confirmation dialog.

No client build step is needed: `client.js` is a self-contained ModuleLoader
bundle maintained in this repository (`pnpm run build:client` regenerates it
from `client/`).

## Install

```bash
dsh plugin --profile web add ./dsh-auto-model-router
```

Or via the published npm package:

```bash
npm install @adverts13/dsh-auto-model-router
dsh plugin --profile web add @adverts13/dsh-auto-model-router
```

## Configuration

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-auto-model-router
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      isolate:
        modelRouter: true
      config:
        - id: dsh-auto-model-router-runtime
          name: '@adverts13/dsh-auto-model-router'
          config:
            # ── four levels (the shipped defaults) ─────────────────────
            # reasoningEffort: off = no thinking, medium/high/max = intensity.
            levels:
              L0:                              # everyday chat
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: off
              L1:                              # code & tests
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: medium
              L2:                              # writing & review
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: high
              L3:                              # complex multi-step
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: max

            # Keyword rules only take part in fully-auto mode. Empty by default.
            rules: []

            # ── MODE A: heuristic lock (zero latency) ──────────────────
            heuristic:
              windowSize: 3        # count the last N user inputs
              counting: cjk2       # CJK char = 2, others = 1; or 'tokens'
              thresholds:          # width → level (user-adjustable)
                - maxChars: 10
                  level: L0
                - maxChars: 100
                  level: L1        # lock ceiling; >100 asks the user

            # ── MODE C: keyword scoring (fully-auto) ───────────────────
            scoring:
              weights:             # per-hit score per level
                L1: 1
                L2: 2
                L3: 3
              bands:               # score → level (user-adjustable)
                - maxScore: 0
                  level: L0
                - maxScore: 5
                  level: L1
                - maxScore: 15
                  level: L2
                - maxScore: null
                  level: L3

            # ── Tier 2: cost control (user-configurable) ───────────────
            costControl:
              enabled: true
              mode: balanced        # cost-first | quality-first | balanced
              defaultLevel: L1      # level used when no rule matches
              tokenBudgetPerSession: 0   # 0 = no budget limit (default);
                                        # positive value caps per-session spend
              # What happens when the session budget is exhausted:
              #   silent  — switch to the cheapest level without telling the user
              #   notify  — inject a user-visible notice explaining the switch
              #   ask     — pop a dialog; user may keep the current model
              #             (waives the budget for the rest of the session)
              downgradeBehavior: notify

            # ── LLM classifier (fully-auto fallback; enabled by default) ──
            llmClassifier:
              enabled: true
              model:
                provider: deepseek-official
                model: deepseek-v4-flash
              requestTimeoutMs: 10000

            # Fixed-level mode re-asks every N user inputs.
            askEveryInputs: 3

            # ── Tier 4: failure fallback chain (model-level) ───────────
            fallbackChain:
              - provider: deepseek-official
                model: deepseek-v4-flash

            maxRetries: 1
```

### costControl modes

| mode | default level (no rule hit) | ambiguity drift |
| --- | --- | --- |
| `cost-first` | lowest configured level | **down** (cheaper) |
| `quality-first` | highest configured level | **up** (stronger) |
| `balanced` | `costControl.defaultLevel` | stay put |

A rule hit always wins over the cost mode: a level the user explicitly matched
is never downgraded by the cost layer.

### Budget downgrade is visible

`tokenBudgetPerSession` **defaults to 0 (no budget)** — the cost layer never
forces a downgrade from budget exhaustion, and `downgradeBehavior` is inert.
Set a positive value to cap spend per session:

- e.g. `tokenBudgetPerSession: 300000`: downgrade once the session uses 300k tokens.
- The downgrade behavior is controlled by `downgradeBehavior` (default `notify`):
  - `notify`: inject a user-visible message explaining the budget is exhausted,
    which model the remaining requests use, and how to raise the cap.
  - `ask`: pop a dialog asking "switch to the cheaper model or keep the current
    one?"; choosing "keep" waives the budget for the rest of the session.
  - `silent`: switch silently (not recommended — the user wonders why answers
    got worse).

### On-load consultation (no client UI)

On the **first session** after installing or hot-reloading the plugin, DSH:

1. Injects a status report message (level→model mapping, cost mode, budget,
   fallback chain). The language follows `settings.yaml`'s
   `locale.preference` (`zh`/`en`, default `en`).
2. Pops a dialog with three questions (asked once per plugin load):

| Question | Options |
| --- | --- |
| Q1 Tier-1 rules | Keep current rules / **View current rules** (injects the rule list) |
| Q2 Tier-2 cost mode | Keep current / cost-first / balanced / quality-first (applies immediately) |
| Q3 Other config | Skip / **Check a setting** (type budget, fallbackChain, classifier, …; injects its current value) |

The injected lists and values let the user **decide** whether to adjust;
persistent changes still live in `cordis.patch.yml` (the messages say so).
Headless or no-question-channel setups degrade to report-only and never block.

## Rule syntax

- Plain text: `match: 'refactor'` — case-insensitive substring.
- Regex literal: `match: '/\\bdebug\\b/'` — slashes delimit the pattern, optional flags after the last slash (`/.../i`).
- Rules are evaluated **in order**; the first match wins.
- `match` can target user message text, tool-call results text, or the session `cwd` (matched as `cwd:<path>`).

## What the plugin hooks

| DSH event | Purpose |
| --- | --- |
| `agent/session-start` | reset per-session routing state |
| `agent/pre-step` | token accounting for budget tracking |
| `system-prompt/assemble` | keep `{{model}}` prompt variables consistent |
| `agent/request` | **the routing decision** — replace provider/model |
| `agent/request-error` | fallback chain → `{ kind: 'retry' }` |
| `session/event` | track spend from assistant messages |

## Testing

```bash
npm test        # node --test *.test.mjs
```

No external services are required — all layers are unit-tested against fixtures.

## Known Issues

- **Fully-auto mode latency**: When the LLM classifier is enabled, the first
  step of each new user input incurs an additional LLM call (classification).
  While subsequent steps within the same input are cached and fast, the overall
  round-trip for multi-step tasks is noticeably slower than directly selecting
  a model. Contributions to optimize this are welcome — the classifier could
  potentially be cached across sessions, or a lighter heuristic could be used
  as a first pass before falling back to the LLM.

## License

MIT
