# dsh-tier-cost

Per-**routing-level** (L0–L3) spend for the DSH auto model router
([`@apinggithub/mydsh-auto-model-router`](../README.md)).

The auto router dispatches each request to a different level. A billing panel
can break spend down by **model**, but when all four levels point at the same
model and differ only in thinking effort (the recommended setup), every call
collapses into one row and you cannot tell which level paid for what. This
plugin restores that dimension.

## How it works

```
session logs (usage of every assistant/message)
        │  attributed via the closest preceding request/header.config
        ▼
router level table  ──▶  each turn mapped to L0/L1/L2/L3/free/manual/unknown
        │
        ▼
billing plugin /api/billing/usage-stats byTurn  ──▶  cost joined per (sessionId, turn)
        │
        ▼
GET /api/tier-cost/usage  ──▶  "Tier Cost" settings section
```

- **Tokens are counted here** from the session logs — no other plugin needed.
- **Money is borrowed** from `@kenz1117/dsh-ui-usage-billing` when it is
  installed (its per-turn cost, including peak/off-peak and cache rates). This
  plugin owns no price table, so it cannot disagree with the panel you already
  trust. Without that plugin it still counts tokens and shows ¥0.
- **The level table is borrowed** from the router's
  `/api/mydsh-auto-model-router/status` (`levels` + `freeQuota`), so config
  changes need no reinstall here.

## Buckets

| Bucket | Meaning |
| --- | --- |
| `L0`–`L3` | dispatched through the router's level table (exact provider+model+effort first, then provider+model) |
| `free` | a route declared in `freeQuota.routes` that is not a level |
| `manual` | you picked a real model yourself; the router was not in the loop |
| `unknown` | the level table exists but nothing matched (title/compaction side calls) |

**Known limitation**: two levels that share provider, model *and* effort are
indistinguishable in the log and fold into the lower one — keep levels distinct
in at least the effort or the model.

## Install

```bash
dsh plugin --profile desktop add ./tier-cost
```

## Configuration

```yaml
- id: dsh-tier-cost
  name: '@apinggithub/dsh-tier-cost'
  config:
    sessionsDir: null      # default <DSH_HOME>/sessions (or ~/.dsh/sessions)
    baseUrl: null          # derived from the request Host header by default
    cacheMs: 10000         # cache for the level table / billing data
    timeoutMs: 15000       # timeout for the peer plugin routes
    includeSubagents: true # fold subagent sessions too (default true)
```

## Route

```
GET /api/tier-cost/usage
```

Loopback only. Returns `{ ok, generatedAt, turns, sessionLogs, levels, totals,
costPriced, costPartial, levelTable, levelLabels, notes }`.

## Test

```bash
node --test *.test.mjs
```

## License

MIT
