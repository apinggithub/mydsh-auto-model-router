// Fallback layer (tier 4): on agent/request-error, walk the fallback chain
// and retry with the next route. The chain is appended with the router's
// default route (the cost default level's model) when the user does not list
// it explicitly, so a fully custom chain still ends at a sane terminal route.

import { routesEqual } from './router.mjs'

export class FallbackChain {
  /**
   * @param {object[]} fallbackChain - normalized fallbackChain from resolveConfig.
   * @param {object} defaultRoute - the router's default route to append.
   * @param {number} maxRetries - per-route retry budget on request-error.
   */
  constructor(fallbackChain, defaultRoute, maxRetries = 1) {
    this.config = { maxRetries }
    this.chain = buildChain(fallbackChain ?? [], defaultRoute)
  }

  /**
   * Find the next route after `current` in the chain, wrapping around to the
   * head after the tail. Returns null when the chain has < 2 distinct routes
   * (nothing to fall back to).
   * @param {object} current - { provider, model }.
   * @returns {object | null}
   */
  nextAfter(current) {
    if (this.chain.length < 2) return null
    const index = this.chain.findIndex((route) => routesEqual(route, current))
    if (index === -1) return this.chain[0]
    return this.chain[(index + 1) % this.chain.length]
  }

  /**
   * Whether retrying makes sense after a failure on `current` given how many
   * retries this session already burned on this route.
   * @param {object} current
   * @param {number} retriesOnRoute
   * @returns {boolean}
   */
  canRetry(current, retriesOnRoute) {
    if (retriesOnRoute >= this.config?.maxRetries ?? 1) return false
    const next = this.nextAfter(current)
    return next !== null && !routesEqual(next, current)
  }
}

function buildChain(fallbackChain, defaultRoute) {
  const chain = [...fallbackChain]
  // Ensure a terminal member so a custom chain that omits the default still
  // ends at the router's default route.
  if (!chain.some((route) => routesEqual(route, defaultRoute))) {
    chain.push(defaultRoute)
  }
  // De-duplicate consecutive identical routes (harmless but noisy).
  const unique = []
  for (const route of chain) {
    if (route && (unique.length === 0 || !routesEqual(unique[unique.length - 1], route))) {
      unique.push(route)
    }
  }
  return unique
}
