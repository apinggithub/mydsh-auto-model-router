# Changelog

Behaviour-visible changes only; see the commits for the full diff.

## 0.2.2 — the virtual model tells the host what it can do

Reported on DSH 0.2.1: picking **Auto** in a thinking conversation failed with
`The content[].thinking in the thinking mode must be passed back to the API`.
The router had rewritten the request correctly on earlier turns, but when a call
still reached the virtual `auto` adapter, the host had already assembled the
conversation for a model that advertises **no context window and no reasoning
efforts** — so the thinking blocks it must echo were missing from the request.

- `auto.resolveModel()` now borrows the routed model's own capability metadata
  through `ctx.llm.resolveModelInfo(provider, model)`:
  - `context.contextWindow` — so the host budgets compaction against the real
    window instead of an unknown one;
  - `reasoning.efforts` / `defaultEffort` — so the host treats the route as
    thinking-capable and keeps echoing `thinking` blocks;
  - `defaultMaxTokens`, `systemPromptUpdate`, `inputModalities` — same defaults
    the routed model would have materialised.
- The default effort follows the configured default level's `reasoningEffort`,
  so an Auto request asks for the thinking intensity the level declares.
- Degrades instead of failing: a host without `resolveModelInfo`, a failing
  lookup, or an empty level table still yields the four DeepSeek efforts and a
  1M window, and `provider`/`id` always stay `auto`/`auto` so host validation
  accepts the result.
- Tests: new `adapter-metadata.test.mjs` (8 cases) pins the metadata contract,
  including the "routed model rejects the level's effort" fallback. 71 tests.

## 0.2.1 — host-compatibility hardening

The plugin now assumes the host surface will move. It mounts and degrades
instead of failing — important because a throwing plugin entry is reported as
"did not activate" and the router silently disappears, and a failing bundle
patch can keep the whole Host from starting.

- **No process globals.** `globalThis.__dshAutoModelRouter` / `__dshLl` are
  gone. `createAutoAdapter({ router, llm })` binds the adapter to one mount, so
  several profiles in one process stay independent and the plugin stops leaking
  a private API onto the global object.
- **`tokenMeter` is a soft dependency.** It is no longer in `inject`; a host
  that renames or drops the service no longer fails the mount, and token
  accounting falls back to the local estimator.
- **Missing `llm.registerAdapter` degrades.** The plugin still mounts and logs
  one warning; routing keeps working for sessions already on provider `auto`.
- **HTTP route registration tolerates renames.** `webServer.register()`,
  `route()` and `addRoute()` are all accepted; a failed claim is a no-op, not an
  exception.
- **Event handling is payload-tolerant.** Handlers accept `{ agent }` *and* a
  bare agent, `(session, event)` *and* `{ session, event }`. Every per-request
  path is wrapped: if the router throws, the host's own proposal passes through
  untouched and the reason is logged once. A router bug can no longer fail a
  user request.
- **`agent/request-error` calls `next()` at most once**, including on error.
- **Host version is reported when available.** `classifyHostVersion()` compares
  the host line with the exercised range (`>=0.1.0-0 <0.4.0`); an untested host
  mounts with a single warning naming both versions. The version is read
  best-effort (app service, environment, resolvable `@deepseek-ai/dsh`
  manifest), so a host that hides it still reports its capabilities.
  `GET /api/mydsh-auto-model-router/status` now returns `host.compat` (live
  capability probe), `host.mount` (the mount-time snapshot) and the plugin
  `version`.
- **Manifest.** Peer ranges widened to `>=0.1.0-0 <1.0.0`, `engines.dsh` added,
  `compat.mjs` shipped. Release version stays in sync with `PLUGIN_VERSION`
  (covered by a test).
- **Tests.** New `compat.test.mjs` covers the future-host shapes: no token
  meter, no `registerAdapter`, renamed route method, malformed payloads,
  adapter isolation, unwired adapter, untested host warning, status payload and
  manifest/version agreement. 62 tests pass.

## 0.2.0

- Catalog freshness guard (`modelsGuard`), valid factory defaults, host-adaptive
  peer ranges.
- `prepareCall` added to the virtual auto adapter (host 0.2.x contract).
- HTTP route claimed through a scoped `webServer` injection.
- Context-window guard (`contextGuard`), free-quota preference and demotion.

## 0.1.0

- Initial release: L0–L3 routing, heuristic lock / fixed level / fully-auto
  modes, cost control, fallback chain.
