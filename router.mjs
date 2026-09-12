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
      const route = this.routeForLevel(cheap) ?? this.firstConfiguredRoute()
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
      return this.routeFor(state, state.fixedLevel)
    }

    if (state.mode === MODE_AUTO) {
      return this.decideAuto(state, windowText)
    }

    // MODE A heuristic.
    const width = windowWidth(state.inputs, this.config.heuristic.windowSize, this.config.heuristic.counting)
    const ceiling = lockCeiling(this.config.heuristic.thresholds)
    if (ceiling !== null && width > ceiling) {
      return { needsAsk: 'above-lock', width }
    }
    const level = levelForWidth(this.config.heuristic.thresholds, width)
    return this.routeFor(state, level)
  }

  /**
   * MODE C: keyword scoring first, LLM classifier on zero score.
   */
  async decideAuto(state, windowText) {
    const { level: scoredLevel, score } = scoreRules(this.config.rules, this.config.scoring, windowText)
    if (scoredLevel) {
      return this.routeFor(state, scoredLevel)
    }
    if (this.classifier.enabled()) {
      const classified = await this.classifier.classify(windowText)
      if (classified) {
        const route = this.resolveClassifiedLevel(classified)
        state.level = classified
        state.current = route
        state.score = score
        return route
      }
    }
    // No rules hit and no classifier → cost default.
    const defaultLevel = this.cost.defaultLevel()
    return this.routeFor(state, defaultLevel)
  }

  routeFor(state, level) {
    const route = this.routeForLevel(level) ?? this.firstConfiguredRoute()
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
   * Map a classifier level to a model route. If the level has no model,
   * drift by the mode's direction toward the nearest configured level.
   * @param {string} classifiedLevel
   * @returns {object}
   */
  resolveClassifiedLevel(classifiedLevel) {
    const direct = this.routeForLevel(classifiedLevel)
    if (direct) return direct
    if (this.config.costControl.mode === 'cost-first') {
      return this.driftToConfigured(classifiedLevel, 'down')
    }
    if (this.config.costControl.mode === 'quality-first') {
      return this.driftToConfigured(classifiedLevel, 'up')
    }
    return this.driftToConfigured(classifiedLevel, 'down')
  }

  driftToConfigured(level, direction) {
    const index = levelIndex(level)
    if (index === -1) return this.firstConfiguredRoute()
    const step = direction === 'down' ? -1 : 1
    for (let i = index + step; i >= 0 && i < LEVEL_IDS.length; i += step) {
      const route = this.routeForLevel(LEVEL_IDS[i])
      if (route) return route
    }
    return this.firstConfiguredRoute()
  }

  firstConfiguredRoute() {
    for (const id of LEVEL_IDS) {
      const route = this.routeForLevel(id)
      if (route) return route
    }
    return { provider: '', model: '' }
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
    const next = this.fallback.nextAfter(failedRoute)
    state.current = next
    state.level = 'fallback'
    return next
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
      }
      this.states.set(sessionId, state)
    }
    return state
  }
}
