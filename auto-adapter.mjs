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
 * The virtual adapter object. `stream()` forwards to the router's decision
 * when it is reachable, so the auto provider never hard-fails routing.
 */
export const AutoAdapter = {
  providerInfo: autoProviderInfo,
  providerRetryPolicy() {
    return undefined
  },
  listModels: async () => autoListModels(),
  resolveModel: async (provider, model) => autoResolveModel(provider, model),
  async *stream(options) {
    const router = globalThis.__dshAutoModelRouter
    if (router !== undefined) {
      const sessionId = options?.sessionId ?? ''
      const route = router.current(sessionId)
      if (route && !routesEqual(route, { provider: AUTO_PROVIDER, model: AUTO_MODEL })) {
        // Forward this request to the routed model through the same llm
        // runtime; the adapter contract requires we stream chunks back.
        const llm = globalThis.__dshLl
        if (llm?.stream !== undefined) {
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

/**
 * Whether a proposed request config selects the Auto provider.
 * @param {object} proposed - { provider, model } from the agent/request waterfall.
 * @returns {boolean}
 */
export function isAutoSelection(proposed) {
  return proposed?.provider === AUTO_PROVIDER
}
