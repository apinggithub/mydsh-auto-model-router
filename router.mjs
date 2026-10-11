// Core router: per-session decision state and the three-mode routing pipeline.
// Pure logic — no cordis imports here so it can be unit-tested standalone.
//
// Modes (per session, per USER INPUT — the caller guarantees one decision per
// user input, subsequent agent/request steps reuse state.current):
//
//   MODE A heuristic lock (default): the last N user inputs' text width maps
//     through heuristic.thresholds to a level. Widths above the lock ceiling
//     return { needsAsk: true } so the caller can ask the user how to proceed.
//   MODE B fixed model: the user picked an explicit level; after
//     askEveryInputs inputs the caller re-asks (returns needsAsk again).
//   MODE C fully-auto: keyword scoring (rules + scoring) decides; a zero
//     score falls through to the LLM classifier on the window text.
//
// The window text for scoring/classification is 本次输入 + 上次输入 + 上次回复
// (current + previous user input + assistant's last reply).
//
// Budget exhaustion (costControl) pins to the cheap level in every mode;
// fallback chain retries on request-error remain model-level.

import { CostControl, estimateMessageTokens } from './cost-control.mjs'
import { FallbackChain } from './fallback.mjs'
import { LlmClassifier } from './classifier.mjs'
import { LEVEL_IDS, levelIndex } from './config.mjs'
import { windowWidth, levelForWidth, lockCeiling } from './text-width.mjs'
import { scoreRules } from './scoring.mjs'

export const MODE_HEURISTIC = 'heuristic'
export const MODE_FIXED = 'fixed'
export const MODE_AUTO = 'auto'

/**
 * Test two routes for equality.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function routesEqual(a, b) {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model)
}

export class ModelRouter {
  /**
   * @param {object} config - resolved plugin config from resolveConfig.
   * @param {object} deps - { llm?: ctx.llm, tokenMeter?: ctx.tokenMeter }.
   */
  constructor(config, deps = {}) {
    this.config = config
    this.levels = config.levels
    this.cost = new CostControl(config.costControl, config.levels)
    this.fallback = new FallbackChain(
      config.fallbackChain,
      this.routeForLevel(config.costControl.defaultLevel) ?? this.firstConfiguredRoute(),
      config.maxRetries,
    )
    this.classifier = new LlmClassifier(config.llmClassifier, deps.llm)
    this.tokenMeter = deps.tokenMeter
    /** @type {Map<string, object>} */
    this.states = new Map()
  }

  /**
   * Resolve the model route for a level id.
   * @param {string} level - LEVEL_IDS entry.
   * @returns {object | null} route or null when the level has no model.
   */
  routeForLevel(level) {
    return this.levels[level] ?? null
  }

  /**
   * One decision per USER INPUT. Returns either a route or an ask request:
   *   { needsAsk: 'above-lock' }     — width crossed the heuristic ceiling.
   *   { needsAsk: 'fixed-reelect' }  — fixed-mode re-election due (askEveryInputs).
   * @param {string} sessionId
   * @param {object} options - { inputText, prevInputText, lastReplyText }.
   * @returns {Promise<object>} route or ask request.
   */
  async decideOnInput(sessionId, { inputText = '', prevInputText = '', lastReplyText = '' } = {}) {
    const state = this.stateFor(sessionId)

    // Same input as the last decision (agent step replay, tool-call loop):
    // reuse the existing decision — NO re-judging, NO re-classification.
    if (state.lastInputText === String(inputText ?? '')) {
      return state.current
    }
    state.lastInputText = String(inputText ?? '')
    state.inputs.push(String(inputText ?? ''))
    if (state.inputs.length > 20) state.inputs.shift()

    // Budget exhaustion pins to the cheap level in every mode.
    if (!state.budgetWaived && this.cost.isOverBudget(sessionId)) {
      const cheap = this.cost.cheapLevel()
      const route = this.effectiveRoute(state, sessionId, cheap)
      state.level = cheap
      state.mode = 'budget'
      state.current = route
      state.downgradePending = true
      return route
    }

    const windowText = [String(inputText ?? ''), String(prevInputText ?? ''), String(lastReplyText ?? '')]
      .filter(Boolean).join('\n')

    if (state.mode === MODE_FIXED) {
      state.fixedInputs = (state.fixedInputs ?? 0) + 1
      if (state.fixedInputs > this.config.askEveryInputs) {
        state.fixedInputs = 0
        return { needsAsk: 'fixed-reelect' }
      }
      return this.routeFor(state, sessionId, state.fixedLevel)
    }

    if (state.mode === MODE_AUTO) {
      return this.decideAuto(state, sessionId, windowText)
    }

    // MODE A heuristic.
    const width = windowWidth(state.inputs, this.config.heuristic.windowSize, this.config.heuristic.counting)
    const ceiling = lockCeiling(this.config.heuristic.thresholds)
    if (ceiling !== null && width > ceiling) {
      return { needsAsk: 'above-lock', width }
    }
    const level = levelForWidth(this.config.heuristic.thresholds, width)
    return this.routeFor(state, sessionId, level)
  }

  /**
   * MODE C: keyword scoring first, LLM classifier on zero score.
   */
  async decideAuto(state, sessionId, windowText) {
    const { level: scoredLevel, score } = scoreRules(this.config.rules, this.config.scoring, windowText)
    if (scoredLevel) {
      return this.routeFor(state, sessionId, scoredLevel)
    }
    if (this.classifier.enabled()) {
      const classified = await this.classifier.classify(windowText)
      if (classified) {
        const level = this.resolveClassifiedLevelId(classified)
        const route = this.routeFor(state, sessionId, level)
        state.score = score
        return route
      }
    }
    // No rules hit and no classifier → cost default.
    const defaultLevel = this.cost.defaultLevel()
    return this.routeFor(state, sessionId, defaultLevel)
  }

  /**
   * Resolve the level actually used for a decision: the preferred free route
   * when one covers this level, the level's own route otherwise, and the paid
   * replacement when the level's own free route is already exhausted.
   * @param {object} state - per-session state.
   * @param {string} sessionId
   * @param {string} level
   * @returns {object} route
   */
  effectiveRoute(state, sessionId, level) {
    // 1. Preference: a declared free route covering this level wins.
    const free = this.freeCandidateFor(sessionId, level)
    if (free) return free

    const own = this.levels[level] ?? null
    if (own === null) return this.firstConfiguredRoute()

    // 2. A free level whose quota is gone falls back to its paid replacement
    //    for the rest of the session instead of failing the turn. Each
    //    (level, route) demotion is queued for reporting only once.
    if (this.isFreeLevel(level) && this.isExhausted(sessionId, own)) {
      const paid = this.paidReplacement(level)
      if (paid && !routesEqual(paid, own)) {
        const demoteKey = `${level}:${this.routeKey(own)}`
        if (!state.freeDemotionReported.has(demoteKey)) {
          state.freeDemotionReported.add(demoteKey)
          state.freeDemotionPending = { level, from: own, to: paid }
        }
        return paid
      }
    }
    return own
  }

  routeFor(state, sessionId, level) {
    const route = this.effectiveRoute(state, sessionId, level)
    state.level = level
    state.current = route
    return route
  }

  /**
   * Set the session mode (called by the index layer after a user answer).
   * @param {string} sessionId
   * @param {'heuristic'|'fixed'|'auto'} mode
   * @param {object} [options] - { fixedLevel } for MODE_FIXED.
   */
  setMode(sessionId, mode, options = {}) {
    const state = this.stateFor(sessionId)
    state.mode = mode
    if (mode === MODE_FIXED) {
      state.fixedLevel = options.fixedLevel ?? this.config.costControl.defaultLevel
      state.fixedInputs = 0
    }
    return state
  }

  /**
   * Map a classifier level to a LEVEL_IDS entry. If the level has no model,
   * drift by the mode's direction toward the nearest configured level.
   * @param {string} classifiedLevel
   * @returns {string} level id
   */
  resolveClassifiedLevelId(classifiedLevel) {
    if (this.routeForLevel(classifiedLevel)) return classifiedLevel
    if (this.config.costControl.mode === 'quality-first') {
      return this.driftLevelId(classifiedLevel, 'up')
    }
    return this.driftLevelId(classifiedLevel, 'down')
  }

  driftLevelId(level, direction) {
    const index = levelIndex(level)
    if (index === -1) return LEVEL_IDS[0]
    const step = direction === 'down' ? -1 : 1
    for (let i = index + step; i >= 0 && i < LEVEL_IDS.length; i += step) {
      if (this.routeForLevel(LEVEL_IDS[i])) return LEVEL_IDS[i]
    }
    return LEVEL_IDS[index]
  }

  /** The same drift, expressed as a route (kept for callers that want one). */
  driftToConfigured(level, direction) {
    return this.routeForLevel(this.driftLevelId(level, direction)) ?? this.firstConfiguredRoute()
  }

  firstConfiguredRoute() {
    for (const id of LEVEL_IDS) {
      const route = this.routeForLevel(id)
      if (route) return route
    }
    return { provider: '', model: '' }
  }

  // ── free-quota layer ────────────────────────────────────────────────────
  // Routes declared free (a level flag `freeQuota: true`, or an entry in
  // `freeQuota.routes`) are preferred for the levels they cover. A free route
  // that fails is demoted for the rest of the session, and the level it served
  // falls back to a paid route — a free route never fails the turn by itself.

  /** Whether the free-quota layer is active for this profile. */
  freeQuotaEnabled() {
    return this.config.freeQuota?.enabled === true
  }

  /** Declared free routes that are not levels themselves. */
  freeQuotaRoutes() {
    return this.config.freeQuota?.routes ?? []
  }

  /** Whether a level's own route is declared free. */
  isFreeLevel(level) {
    return this.levels[level]?.freeQuota === true
  }

  /** Whether a route is declared free anywhere in the configuration. */
  isFreeRoute(route) {
    if (!route || route.provider === '') return false
    for (const id of LEVEL_IDS) {
      if (this.isFreeLevel(id) && routesEqual(this.levels[id], route)) return true
    }
    return this.freeQuotaRoutes().some((entry) => routesEqual(entry, route))
  }

  /** Session key for a route. */
  routeKey(route) {
    return route ? `${route.provider}/${route.model}` : ''
  }

  /** Whether this session already burned a route's free quota. */
  isExhausted(sessionId, route) {
    const state = this.states.get(sessionId)
    return state ? state.exhaustedFree.has(this.routeKey(route)) : false
  }

  /**
   * Mark a free route as exhausted for this session (called from
   * agent/request-error). Returns true when this call changed the state, so the
   * caller can notify exactly once.
   */
  markFreeExhausted(sessionId, route) {
    if (!this.freeQuotaEnabled()) return false
    if (!this.isFreeRoute(route)) return false
    const state = this.stateFor(sessionId)
    const key = this.routeKey(route)
    if (state.exhaustedFree.has(key)) return false
    state.exhaustedFree.add(key)
    return true
  }

  /**
   * A declared free route that covers `level` and still has quota, or null.
   * This is the "prefer free" half of the layer.
   */
  freeCandidateFor(sessionId, level) {
    if (!this.freeQuotaEnabled()) return null
    const index = levelIndex(level)
    if (index === -1) return null
    for (const entry of this.freeQuotaRoutes()) {
      if (levelIndex(entry.maxLevel) < index) continue
      if (this.isExhausted(sessionId, entry)) continue
      return entry
    }
    return null
  }

  /**
   * The paid route a free level falls back to: the nearest configured non-free
   * level (upward first, so quality is not silently dropped), then the first
   * non-free entry of the fallback chain.
   * @param {string} level
   * @returns {object | null}
   */
  paidReplacement(level) {
    const index = levelIndex(level)
    const ladder = []
    for (let i = index + 1; i < LEVEL_IDS.length; i += 1) ladder.push(LEVEL_IDS[i])
    for (let i = index - 1; i >= 0; i -= 1) ladder.push(LEVEL_IDS[i])
    for (const id of ladder) {
      if (this.isFreeLevel(id)) continue
      const route = this.routeForLevel(id)
      if (route) return route
    }
    return (this.fallback?.chain ?? []).find((route) => !this.isFreeRoute(route)) ?? null
  }

  /**
   * The pending free-quota demotion of this session, or null. The caller
   * consumes it (clears it) so the notification fires exactly once.
   * @returns {{ level: string, from: object, to: object } | null}
   */
  consumeFreeDemotionFlag(sessionId) {
    const state = this.states.get(sessionId)
    if (!state?.freeDemotionPending) return null
    const info = state.freeDemotionPending
    state.freeDemotionPending = null
    return info
  }

  /**
   * Record a failure on the current route and return the fallback route, or
   * null when the chain is exhausted. Caller returns { kind: 'retry' }.
   * @param {string} sessionId
   * @param {object} failedRoute
   * @returns {object | null}
   */
  nextOnFailure(sessionId, failedRoute) {
    const state = this.stateFor(sessionId)
    const key = `${failedRoute.provider}/${failedRoute.model}`
    const retries = state.retries.get(key) ?? 0
    if (!this.fallback.canRetry(failedRoute, retries)) return null
    state.retries.set(key, retries + 1)
    const next = this.nextViableFallback(sessionId, failedRoute)
    if (next === null) return null
    state.current = next
    state.level = 'fallback'
    return next
  }

  /**
   * Walk the fallback chain from `failedRoute`, skipping routes whose free
   * quota this session already burned — retrying a rate-limited free route
   * would just fail again. Returns null when nothing viable is left.
   * @param {string} sessionId
   * @param {object} failedRoute
   * @returns {object | null}
   */
  nextViableFallback(sessionId, failedRoute) {
    const size = this.fallback?.chain?.length ?? 0
    const seen = new Set([this.routeKey(failedRoute)])
    let current = failedRoute
    for (let hop = 0; hop < size; hop += 1) {
      const next = this.fallback.nextAfter(current)
      if (next === null || routesEqual(next, current)) return null
      const key = this.routeKey(next)
      if (seen.has(key)) return null
      seen.add(key)
      if (!this.isExhausted(sessionId, next)) return next
      current = next
    }
    return null
  }

  /** Account one message's tokens toward the session budget. */
  recordTokens(sessionId, message) {
    if (this.tokenMeter?.estimateMessage) {
      this.cost.addSpend(sessionId, this.tokenMeter.estimateMessage(message))
    } else {
      this.cost.addSpend(sessionId, estimateMessageTokens(message))
    }
  }

  /**
   * The previous user input's text (the input BEFORE the current one), used
   * to build the classification window. Falls back to the last remembered
   * input when the current input is the first of the session.
   * @param {string} sessionId
   * @returns {string | null}
   */
  lastInputText(sessionId) {
    const state = this.states.get(sessionId)
    if (!state) return null
    if (state.inputs.length >= 2) return state.inputs[state.inputs.length - 2]
    return null
  }

  /**
   * The assistant's last reply text, remembered from session/event.
   * @param {string} sessionId
   * @returns {string | null}
   */
  lastReplyText(sessionId) {
    return this.states.get(sessionId)?.lastReply ?? null
  }

  /** Remember the assistant's latest reply text (session/event). */
  rememberReply(sessionId, text) {
    this.stateFor(sessionId).lastReply = String(text ?? '')
  }

  /**
   * The cached latest user input text (set in agent/pre-step). The current
   * input is whatever the last user message was — the router decision for
   * this session should key off it until the next user message arrives.
   * @param {string} sessionId
   * @returns {string | null}
   */
  currentInput(sessionId) {
    return this.states.get(sessionId)?.currentInput ?? null
  }

  /** Cache the latest user input text (agent/pre-step). */
  rememberInput(sessionId, text) {
    this.stateFor(sessionId).currentInput = String(text ?? '')
  }

  /** Current route for a session (for status tools / debugging). */
  current(sessionId) {
    return this.states.get(sessionId)?.current ?? this.firstConfiguredRoute()
  }

  /** Whether the session runs in Auto mode (user picked the virtual auto provider). */
  isAutoActive(sessionId) {
    return this.states.get(sessionId)?.autoActive === true
  }

  /** Mark the session as Auto-mode (the router takes over routing). */
  markAutoActive(sessionId) {
    this.stateFor(sessionId).autoActive = true
  }

  /** Mark the session as NOT Auto-mode (user picked a real model; pass through). */
  markAutoInactive(sessionId) {
    this.stateFor(sessionId).autoActive = false
  }

  /** The level label that produced the current route. */
  level(sessionId) {
    return this.stateFor(sessionId).level
  }

  /** The mode that produced the current route. */
  mode(sessionId) {
    return this.stateFor(sessionId).mode
  }

  /**
   * Whether this session's last decision tripped the budget downgrade and the
   * downgrade has not yet been reported/asked about. The caller consumes the
   * flag (clears it) so the notification fires exactly once.
   * @param {string} sessionId
   * @returns {boolean}
   */
  consumeDowngradeFlag(sessionId) {
    const state = this.states.get(sessionId)
    if (!state?.downgradePending) return false
    state.downgradePending = false
    return true
  }

  /**
   * Waive the budget for this session (ask mode). Session-scoped.
   * @param {string} sessionId
   */
  waiveBudget(sessionId) {
    const state = this.stateFor(sessionId)
    state.budgetWaived = true
  }

  /** Reset per-session state (used on session-start). */
  resetSession(sessionId) {
    this.states.delete(sessionId)
    this.cost.resetSession(sessionId)
  }

  measureTokens(sessionId) {
    return this.cost.spentTokens(sessionId)
  }

  stateFor(sessionId) {
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        level: 'unset',
        current: this.firstConfiguredRoute(),
        mode: MODE_HEURISTIC,
        inputs: [],
        lastInputText: '',
        currentInput: '',
        fixedLevel: this.config.costControl.defaultLevel,
        fixedInputs: 0,
        score: 0,
        lastReply: '',
        retries: new Map(),
        downgradePending: false,
        budgetWaived: false,
        autoActive: false,
        // Free routes whose quota this session already burned.
        exhaustedFree: new Set(),
        // A free route demoted during routing, waiting to be reported.
        freeDemotionPending: null,
        // Demotions already reported, so a session is told exactly once.
        freeDemotionReported: new Set(),
      }
      this.states.set(sessionId, state)
    }
    return state
  }
}
