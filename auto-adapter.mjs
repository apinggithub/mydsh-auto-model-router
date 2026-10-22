// Virtual "auto" provider adapter. Registers a provider route named `auto`
// so the model selector shows an "Auto Router" group with one model:
//
//   Auto Router
//     └─ Auto (auto routing)
//
// Selecting it marks the session's provider as `auto`; the router plugin then
// takes over in `agent/request` and routes through the configured L0–L3
// levels. Selecting any real provider/model leaves the user's choice
// untouched (the plugin passes through).
//
// If a request still reaches provider `auto` (e.g. the router did not
// intercept this particular call — a titled step, compaction, or a listener
// ordering gap), `stream()` forwards to the router's current per-session
// decision instead of throwing, so routing is never a hard failure.
//
// The adapter is created per mount through `createAutoAdapter()` and closes
// over the router and the llm service of *that* context. Earlier revisions
// published them through `globalThis.__dshAutoModelRouter` / `__dshLl`, which
// breaks as soon as one process hosts more than one profile (the second mount
// overwrites the first adapter's dependencies) and leaks a plugin-private API
// onto the global object.

import { routesEqual } from './router.mjs'

export const AUTO_PROVIDER = 'auto'
export const AUTO_MODEL = 'auto'

/** Provider route metadata shown in the selector. */
export function autoProviderInfo(provider) {
  return { id: provider, name: 'Auto Router' }
}

/** One advertised model: the single "Auto" choice. */
export function autoListModels() {
  return [{ provider: AUTO_PROVIDER, id: AUTO_MODEL, name: 'Auto' }]
}

/** Exact-model metadata for the advertised model. */
export function autoResolveModel(provider, model) {
  return { provider, id: model, name: model }
}

/**
 * Build the virtual adapter for one plugin mount.
 *
 * Both dependencies are read lazily through getters so the adapter always sees
 * the live router / llm service (they are created before the adapter, but the
 * indirection keeps the object serializable and testable).
 *
 * @param {object} [resolve]
 * @param {() => object | undefined} [resolve.router] - returns the ModelRouter.
 * @param {() => object | undefined} [resolve.llm] - returns `ctx.llm`.
 * @returns {object} adapter understood by `ctx.llm.registerAdapter()`
 */
export function createAutoAdapter(resolve = {}) {
  const readRouter = typeof resolve.router === 'function' ? resolve.router : () => undefined
  const readLlm = typeof resolve.llm === 'function' ? resolve.llm : () => undefined

  /** @type {object} */
  const adapter = {
    providerInfo: autoProviderInfo,
    providerRetryPolicy() {
      return undefined
    },
    listModels: async () => autoListModels(),
    resolveModel: async (provider, model) => autoResolveModel(provider, model),
    /**
     * The 0.2.x adapter contract: the runtime validates a request against the
     * model's capabilities and binds it to one concrete adapter generation
     * through `prepareCall(provider, model, signal)`, then dispatches through
     * the returned `stream`. The virtual `auto` provider owns no generation of
     * its own, so it returns the metadata it already advertises and routes the
     * stream through the forwarding generator below.
     *
     * Hosts before 0.2.x call `stream()` directly; keeping both entry points is
     * what makes one package work on 0.1 and 0.2 alike.
     */
    async prepareCall(provider, model) {
      return {
        model: await adapter.resolveModel(provider, model),
        stream: (options) => adapter.stream(options),
      }
    },
    async *stream(options) {
      const router = readRouter()
      if (router !== undefined && router !== null) {
        const sessionId = options?.sessionId ?? ''
        const route = router.current?.(sessionId)
        if (route && !routesEqual(route, { provider: AUTO_PROVIDER, model: AUTO_MODEL })) {
          // Forward this request to the routed model through the same llm
          // runtime; the adapter contract requires we stream chunks back.
          const llm = readLlm()
          if (typeof llm?.stream === 'function') {
            // ctx.llm.stream returns the AsyncIterable directly (not { stream }).
            const stream = llm.stream({
              ...options,
              provider: route.provider,
              model: route.model,
              ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
            })
            for await (const chunk of stream) yield chunk
            return
          }
        }
      }
      throw new Error(
        'mydsh-auto-model-router: request reached the virtual "auto" provider with no router '
        + 'decision available. Check that the plugin is mounted.',
      )
    },
  }
  return adapter
}

/**
 * Unwired singleton kept for import compatibility with earlier revisions.
 *
 * It advertises the model metadata but cannot forward a stream (it has no
 * router), so `stream()` reports the missing mount instead of silently
 * producing an empty answer.
 */
export const AutoAdapter = createAutoAdapter()

/**
 * Whether a proposed request config selects the Auto provider.
 * @param {object} proposed - { provider, model } from the agent/request waterfall.
 * @returns {boolean}
 */
export function isAutoSelection(proposed) {
  return proposed?.provider === AUTO_PROVIDER
}
