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

/**
 * Reasoning efforts advertised when the routed model's own metadata cannot be
 * read: the four values the DeepSeek catalog accepts.
 */
const FALLBACK_EFFORTS = Object.freeze([
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
])

/**
 * Context window advertised when the routed model does not report one.
 * DeepSeek's 0.2.x catalog tops out at 1M tokens; assuming the largest window
 * merely keeps compaction from firing early — the routed provider still
 * rejects an oversized request and the fallback chain takes over.
 */
const FALLBACK_CONTEXT_WINDOW = 1_000_000

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
 * The route the virtual model should borrow its capabilities from.
 *
 * The host asks `resolveModel("auto", "auto")` before it assembles a request,
 * long before any session decision exists, so this picks the configured
 * default level (falling back to the first configured one).
 *
 * @param {object | undefined} router
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
function representativeRoute(router) {
  try {
    const level = router?.config?.costControl?.defaultLevel
    const route = (level === undefined ? undefined : router?.routeForLevel?.(level))
      ?? router?.firstConfiguredRoute?.()
    if (route === undefined || route === null) return undefined
    if (typeof route.provider !== 'string' || route.provider === '') return undefined
    if (typeof route.model !== 'string' || route.model === '') return undefined
    return route
  } catch {
    return undefined
  }
}

/** Read the routed model's own metadata, tolerating a host without it. */
async function underlyingInfo(llm, route) {
  if (route === undefined || typeof llm?.resolveModelInfo !== 'function') return undefined
  try {
    return await llm.resolveModelInfo(route.provider, route.model)
  } catch {
    return undefined
  }
}

/** Copy the routed model's efforts, or the DeepSeek defaults. */
function reasoningEfforts(info) {
  const efforts = info?.reasoning?.efforts
  if (Array.isArray(efforts) && efforts.length > 0) {
    return efforts.map((effort) => ({
      id: effort.id,
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    }))
  }
  return FALLBACK_EFFORTS.map((effort) => ({ ...effort }))
}

/**
 * Pick the reasoning effort to send to the routed model.
 *
 * The session's model selection keeps its own `reasoningEffort` and the host's
 * selection listener re-applies it after every waterfall rewrite, so the value
 * that reaches this adapter belongs to the *virtual* model, not to the model it
 * forwards to. Passing it through unchanged sends a thinking parameter to a
 * model with no thinking mode, which the provider rejects outright
 * (`does not support reasoning effort "low"`).
 *
 * @param {object} llm - ctx.llm
 * @param {object} route - the routed provider/model
 * @param {unknown} requested - effort the caller asked for (usually the UI choice)
 * @returns {Promise<string | undefined>} an effort the target advertises, or undefined
 */
async function supportedEffort(llm, route, requested) {
  const info = await underlyingInfo(llm, route)
  const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
  if (efforts.length === 0) return undefined
  const ids = new Set(efforts.map((effort) => effort.id))
  if (typeof route.reasoningEffort === 'string' && ids.has(route.reasoningEffort)) return route.reasoningEffort
  if (typeof requested === 'string' && ids.has(requested)) return requested
  const fallback = info?.reasoning?.defaultEffort
  return typeof fallback === 'string' && ids.has(fallback) ? fallback : undefined
}

/**
 * Request options for the routed model: same call, different provider/model,
 * and only the reasoning effort that model actually supports.
 *
 * @param {object} llm - ctx.llm
 * @param {object} route - the routed provider/model
 * @param {object} options - options the runtime handed to `stream()`
 * @returns {Promise<object>}
 */
async function forwardOptions(llm, route, options) {
  const forwarded = { ...options, provider: route.provider, model: route.model }
  delete forwarded.reasoningEffort
  const effort = await supportedEffort(llm, route, options?.reasoningEffort)
  if (effort !== undefined) forwarded.reasoningEffort = effort
  return forwarded
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
    /**
     * Capability metadata for the virtual model.
     *
     * The host validates a request against the exact model *before* any
     * provider I/O and assembles the conversation with what it learns here:
     * without a context window it cannot budget compaction, and without
     * reasoning efforts it treats the route as non-thinking and stops echoing
     * the `thinking` blocks a thinking-mode provider requires on every turn.
     * Borrowing the routed model's own metadata keeps the virtual provider
     * indistinguishable from the model it forwards to.
     */
    async resolveModel(provider, model) {
      const router = readRouter()
      // Teach the router the real windows first: the guard and this metadata
      // must agree on what the candidates can hold.
      await router?.refreshContextWindows?.()
      const route = representativeRoute(router)
      const info = await underlyingInfo(readLlm(), route)
      const efforts = reasoningEfforts(info)
      const requested = route?.reasoningEffort
      const wanted = efforts.some((effort) => effort.id === requested)
        ? requested
        : info?.reasoning?.defaultEffort
      const defaultEffort = efforts.some((effort) => effort.id === wanted) ? wanted : efforts[0]?.id
      // Report the smallest window any candidate can hold: the host budgets
      // compaction from this value, so a conversation that fits the default
      // level but not a free route would otherwise be assembled for a model
      // that cannot take it.
      const own = info?.context?.contextWindow
      const pool = [
        ...(typeof router?.candidateContextWindows === 'function' ? router.candidateContextWindows() : []),
        ...(Number.isInteger(own) && own > 0 ? [own] : []),
      ].filter((value) => Number.isInteger(value) && value > 0)
      const contextWindow = pool.length > 0 ? Math.min(...pool) : FALLBACK_CONTEXT_WINDOW
      return {
        provider,
        id: model,
        name: 'Auto',
        context: { contextWindow },
        systemPromptUpdate: info?.systemPromptUpdate ?? 'in-history',
        ...info?.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens },
        ...info?.inputModalities === undefined ? {} : { inputModalities: info.inputModalities },
        reasoning: {
          efforts,
          ...defaultEffort === undefined ? {} : { defaultEffort },
        },
      }
    },
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
            const forwarded = await forwardOptions(llm, route, options)
            // ctx.llm.stream returns the AsyncIterable directly (not { stream }).
            const stream = llm.stream(forwarded)
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
