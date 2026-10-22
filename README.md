# mydsh-auto-model-router

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

Each level is a user-assigned provider/model route with an **optional**
`reasoningEffort`: omitting it (or writing `null`) sends no effort at all —
required for models without a thinking mode (GLM/Qwen flash), which the host
otherwise rejects; `off` explicitly disables thinking; `high`/`max` set its
intensity. Levels may be left unconfigured; the router then falls to the nearest
configured level (direction depends on the cost
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
`<mydsh-auto-model-router-status>` report the host injects on session start —
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
dsh plugin --profile web add ./mydsh-auto-model-router
```

Or via the published npm package:

```bash
npm install @apinggithub/mydsh-auto-model-router
dsh plugin --profile web add @apinggithub/mydsh-auto-model-router
```

## Host compatibility

DSH treats a profile's plugin tree as one composition: a bundle whose patch
fails can stop the whole Harness from starting, and a plugin entry that throws
is reported as *did not activate* — the router simply disappears from the
running session. This plugin is therefore written to **mount, degrade and
log** rather than fail on a host whose surface moved.

| Host line | Status |
| --- | --- |
| 0.1.x – 0.3.x | Tested (`0.2.1-rc.2` is the reference host) |
| 0.4.x – 1.x | Allowed to mount, reported as *untested* in the log and in `GET /api/mydsh-auto-model-router/status` |

At mount, `compat.mjs` probes every API the plugin touches
(`llm.registerAdapter`, `llm.listModels`, `llm.stream`, scoped `ctx.inject`,
`webServer.register`, the optional `tokenMeter`) and records the result in the
status payload under `host.compat`. What that buys you on an unknown host:

- **No hard dependency on `tokenMeter`** — it is looked up softly and token
  spend falls back to the plugin's own estimator.
- **No virtual-provider requirement** — without `llm.registerAdapter` the
  plugin still mounts and logs one warning; the `Auto` model simply does not
  appear in the picker.
- **HTTP route aliases** — `webServer.register()`, `route()` or `addRoute()`
  are all accepted; without any of them the settings page shows its "no report
  yet" state instead of breaking.
- **Payload tolerance** — event handlers accept the current `{ agent }` /
  `(session, event)` shapes *and* a bare-agent / `{ session, event }` payload,
  and a handler that throws hands the host's own proposal back untouched. A
  router bug can no longer fail a user request.
- **No process globals** — the adapter is created per mount and closes over
  that mount's router, so several profiles in one process cannot overwrite
  each other.
- **Version report** — when the host exposes its version (environment, app
  service, or a resolvable manifest), a host outside `>=0.1.0-0 <0.4.0` logs
  one warning naming both versions. Capability probes run regardless, so a
  host that hides its version still reports what it actually provides.

The peer ranges (`>=0.1.0-0 <1.0.0`) and `engines.dsh` are deliberately wider
than the tested range so an upgrade does not hard-block installation; the
runtime warning is what tells you to file an issue.

## Configuration

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: mydsh-auto-model-router
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      isolate:
        modelRouter: true
      config:
        - id: mydsh-auto-model-router-runtime
          name: '@apinggithub/mydsh-auto-model-router'
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

            # ── Tier 3: free-quota preference (optional) ───────────────
            # Declare which routes are free-quota routes: they are preferred,
            # and a failed one is demoted for the session.
            freeQuota:
              enabled: true          # auto-disabled when nothing is declared
              routes:                # extra free routes that are not levels
                - provider: glm
                  model: glm-4.7-flash
                  maxLevel: L1       # highest level it serves (inclusive), default L1
                  reasoningEffort: off
              demoteOnError: true    # one failure demotes it for the session
              notify: true           # say so once per session

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

### Free-quota preference (freeQuota)

Many providers hand out free quota (Zhipu's `glm-4.7-flash`, for instance, is
permanently free), and a free route usually comes with the fine print: rate
limits, a quota that runs out, tighter parameter caps. This layer turns "free"
into a declarable route property and keeps a dead free route from failing the
whole turn.

Two declaration forms, which can be mixed:

```yaml
levels:
  L0: { provider: glm, model: glm-4.7-flash, reasoningEffort: off, freeQuota: true }
  L1: { provider: glm, model: glm-4.7-flash, reasoningEffort: low,  freeQuota: true }
  L2: { provider: deepseek-account, model: deepseek-flash, reasoningEffort: high }
  L3: { provider: deepseek-account, model: deepseek-flash, reasoningEffort: max }

# Or: keep the levels paid and let a declared free route claim their work.
freeQuota:
  routes:
    - { provider: glm, model: glm-4.7-flash, maxLevel: L1, reasoningEffort: off }
```

What it does:

1. **Preference** — a decision at or below `maxLevel` runs on the declared free
   route (free routes always carry an explicit `reasoningEffort`, defaulting to
   `off`, so they never fall into the adapter's own default thinking level).
2. **Demotion on failure** — any failure on a free route (quota exhausted, 429
   rate limit, rejected credentials, rejected parameters) marks that route as
   burned **for this session** and the request is retried on the next viable
   route — normally the paid route that level was configured with.
3. **No retrying a dead route** — after a demotion the fallback walk skips every
   burned free route, so one session never hits the same wall twice.
4. **Visible** — with `notify: true` the plugin injects one message saying which
   free route failed, why, and what is used instead (at most once per session).
5. **Session-scoped** — the demotion lasts for the current session only; the
   next session tries the free route again. With nothing declared free the whole
   layer is inert, so existing profiles behave exactly as before.

> Note: free **vision** models often have a much smaller output cap (e.g.
> `glm-4v-flash` allows `max_tokens ≤ 1024`). Fix those on the provider's
> `models` entry with `maxTokens` — the router cannot guess them for you. If you
> see `INVALID_REQUEST: max_tokens …`, add `maxTokens` to that model.

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

## Companion plugin: cost by tier

`tier-cost/` ships the second plugin of this repository,
**`@apinggithub/dsh-tier-cost`**: it folds session logs into per-level (L0–L3)
token usage and spend, borrowing per-turn cost from the billing plugin
`@kenz1117/dsh-ui-usage-billing` (it owns no price table of its own) and adding a
"Tier Cost" settings section — because the four levels usually share one model,
a per-model panel cannot tell you which tier paid.

```bash
dsh plugin --profile desktop add ./tier-cost
```

See [tier-cost/README.md](tier-cost/README.md) for details.

## License

MIT

### Context-window guard (contextGuard)

A level may declare its model's `contextWindow`. When the session's live context
(the input side of the last request, including cache reads/writes) exceeds
`window × headroom` (default 0.85) the level is **skipped** and the router
drifts up to the nearest level that fits; if no declared window fits, the
original level stands (fail open) so the provider answers with a real error the
fallback chain can handle. Each skip is recorded once per (level, session) and
visible in `/status` under `contextGuard`. With no window declared anywhere the
layer is inert.

```yaml
levels:
  L0: { provider: bailian, model: qwen-max, contextWindow: 32768 }   # guard small windows
contextGuard: { enabled: true, headroom: 0.85 }
```

## Deploying to another machine

One machine = three commands (this repository ships both plugins):

```powershell
# 1. Install from npm (peer ranges are host-adaptive; no allow-version exemption needed)
dsh plugin --profile desktop add '@apinggithub/mydsh-auto-model-router@0.3.1'

# 2. Optional: per-tier cost panel
dsh plugin --profile desktop add '@apinggithub/dsh-tier-cost@0.1.0'

# 3. Restart DSH once (bundles are composed at boot; config edits hot-reload)
```

From source instead: `git clone …` then `dsh plugin --profile desktop add ./mydsh-auto-model-router`.

### Every machine ships its own levels block

The factory defaults are legacy routes that may not exist on that machine. Write your own
block at the end of `profiles/<profile>/cordis.patch.yml` — provider/model must be routes
**that machine** can actually use (do not copy ids across machines):

```yaml
- id: mydsh-auto-model-router-runtime
  name: '@apinggithub/mydsh-auto-model-router'
  config:
    levels:
      # reasoningEffort: null = the model has no thinking mode (Qwen/GLM flash have none).
      # Must be null, otherwise the host rejects the request with UNSUPPORTED_REASONING_EFFORT.
      L0: { provider: zhipu, model: glm-4.7-flash, reasoningEffort: null, freeQuota: true }
      L1: { provider: zhipu, model: glm-4.5-flash, reasoningEffort: null, freeQuota: true }
      L2: { provider: zhipu, model: glm-4-flash,   reasoningEffort: null }
      L3: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: max }
    freeQuota:    { enabled: true, demoteOnError: true, notify: true }
    contextGuard: { enabled: true, headroom: 0.85 }
    quotaWatch:   { enabled: true, provider: bailian-dell-vostro, balanceFloorCny: 10 }
```

The providers themselves must already be configured in `cordis.patch.yml` (`llm-pi-ai`'s
`providers:` section), with keys in the DSH credential store or an `apiKeyEnv`.

`tier-cost` has zero hard dependencies beyond the host: without the router every turn folds
into manual/unknown, without the billing plugin tokens are counted and cost stays 0 — both
cases self-report in the panel notes.

**Multi-machine, same account**: quotas and balances live on the provider's side, so nothing
is accumulated locally — `quotaWatch` reads the cloud bill. But each machine configures its own
credentials (the store does not sync).

## Quota watchdog (quotaWatch)

### What it fixes

An exhausted free tier does not always produce an error: the provider may silently switch it to
pay-as-you-go. `demoteOnError` has nothing to catch then, and the route keeps spending (see
[the silent-billing trap](#the-silent-billing-trap-of-free-quota-real-incident--rules)). The
watchdog reads the **bill** instead and retires a "free" model within one poll.

### What it can see

| Source | Gives | Limit |
| --- | --- | --- |
| `QueryAccountBalance` | available balance (CNY) | near real-time |
| `DescribeInstanceBill` | spend per model for the cycle | **T+1** |
| `QueryResourcePackageInstances` | resource-package remainder | empty when none exist |
| DeepSeek `GET /user/balance` | platform balance | near real-time |

There is **no** public "remaining free quota" API — that progress bar only exists in the
provider console. So the semantics are *detect and demote*, not *block in advance*; the real
guard against overspend is still the provider-side "stop when exhausted" switch.

### Configuration

```yaml
quotaWatch:
  enabled: true
  provider: bailian-dell-vostro      # which configured provider the bill describes
  productCode: sfm                   # 百炼's product code on the Aliyun bill
  pollMs: 1800000                    # 30 min (minimum 60000)
  balanceFloorCny: 10                # below this Aliyun balance, every paid level pauses; 0 = off
  demoteOnSpend: true                # any spend on a guarded model retires its route
  deepseekBalanceFloor: 10           # below this, only deepseek-official pauses; 0 = off
  deepseekApiKeyRef: DEEPSEEK_API_KEY
  accessKeyIdRef: ALIBABA_CLOUD_ACCESS_KEY_ID
  accessKeySecretRef: ALIBABA_CLOUD_ACCESS_KEY_SECRET
  timeoutMs: 20000
```

### Aliyun RAM: how to grant the least privilege

**Never use the root account's AccessKey.** Instead:

1. Console → **RAM** → Users → create a user with **programmatic access only**;
2. Give it **read-only billing**: attach the system policy `AliyunBSSReadOnlyAccess`, or a custom
   policy allowing just `bss:QueryAccountBalance`, `bss:DescribeInstanceBill`,
   `bss:QueryResourcePackageInstances`;
3. Create an **AccessKey** and store it in the DSH credential store — nothing else, no write scope;
4. The plugin only ever issues two GETs per poll.

> Never put the AccessKey **secret** in `cordis.patch.yml`, and never commit it. The config
> carries reference names (`accessKeyIdRef` / `accessKeySecretRef`) only.

### Where credentials live

The watchdog resolves them through `ctx.credentials.resolve(ref)`, i.e. the **DSH credential
store** (`$DSH_HOME/.credentials.yaml`, the same file that holds provider API keys):

```yaml
refs:
  ALIBABA_CLOUD_ACCESS_KEY_ID: LTAI...
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: ...
  DEEPSEEK_API_KEY: sk-...
```

Two ways to write it:

- **GUI**: Plugins → built-in plugin settings → Models / credentials, using the ref names above;
- **Command line** (keeps the secret out of shell history and out of any chat):

```powershell
$sec = Read-Host -AsSecureString 'Paste AccessKey Secret'
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
# write it into $DSH_HOME/.credentials.yaml, then delete any temporary plaintext file
```

⚠️ **Multi-machine**: configure credentials once per machine. Quotas and balances live on the
provider side, so every machine reads the same numbers.

### Status

`GET /api/mydsh-auto-model-router/status` → `quotaWatch`:

```json
{
  "enabled": true, "lastCheckAt": "2026-10-22T09:57:18Z", "lastError": null,
  "balanceCny": 28.21, "cycle": "2026-10",
  "spendByModel": { "glm-5.3": 62.5611, "qwen3.8-flash": 8.0478 },
  "totalCny": 70.67, "exhausted": [], "balanceLow": false,
  "deepseekBalanceCny": 158.25, "deepseekBlocked": false, "deepseekError": null
}
```

Any step that fails lands in `lastError` / `deepseekError` and never breaks routing.

### Catalog freshness guard (modelsGuard)

When a provider retires a model id, the level pointing at it goes stale. The
guard reads what each provider actually advertises (`ctx.llm.listModels`) at
activation and every `refreshMs` (default 10 min): a stale level's requests
**drift to the nearest fresh level** instead of failing, and the status report
names same-family candidate ids so the fix stays a one-line edit. Unreadable or
empty catalogs fail open (never marked stale); environments without a catalog
reader leave the layer inert.

```yaml
modelsGuard: { enabled: true, refreshMs: 600000 }
```

> The static list remains configuration (`cordis.patch.yml`) on purpose: the
> plugin never decides *which* new model to adopt (windows, prices and
> capabilities all change) — it guarantees a dead tier is not selected and
> tells you what to switch to.

## Publishing to npm

Both plugins live in this repository and publish independently:

```bash
npm publish                 # @apinggithub/mydsh-auto-model-router (root)
cd tier-cost && npm publish # @apinggithub/dsh-tier-cost
```

From 0.2.0 the peerDependencies are host-adaptive ranges, so fresh machines no
longer need the allow-version exemption (only 0.1.1 and earlier did). Run
`npm login --scope=apinggithub` once per package account setup.

## The silent-billing trap of free quota (real incident · rules)

A true story from the author's machine: L1 pointed at the Bailian free model `glm-5.3`
(`freeQuota: true`). When the quota ran out the provider did **not** return the promised
403 (`stop-when-exhausted` had not actually taken effect for that model) — calls kept
succeeding, now silently at pay-as-you-go rates, for a full day until a billing alert
arrived. `demoteOnError` had no error to catch.

Three rules, all required:

1. **Verify "stop when exhausted" per model on the provider side** (make one over-quota
   call and confirm a 403). The router can only switch lines on errors it can see;
   a provider that silently converts a free route into paid billing is invisible to it.
2. **Keep `costControl.defaultLevel` on a stable paid tier.** In this file's examples a
   `defaultLevel: L1` where L1 is a free tier is exactly the incident shape. Prefer free
   only at L0, or keep an explicit paid replacement for every free tier.
3. **Watch the billing panel per tier.** A "free" tier whose cost line keeps growing and
   never zeroes is burning money — drop it from the free routes immediately.

> Another sharp edge: quota pools are counted per **provider+model**. The same id on two
> providers (e.g. `qwen3.8-flash` on both `bailian` and `qianwen`) are **separate pools**;
> quota and billing never cross over.
