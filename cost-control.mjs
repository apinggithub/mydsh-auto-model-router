// Cost-control layer (tier 2): the user picks a mode, and that mode decides
// (a) the default level for unmatched tasks and (b) the drift direction when
// the router must break a tie (ambiguous classification, budget pressure).
//
//   cost-first:    default to the LOWEST configured level; ambiguity drifts DOWN.
//   quality-first: default to the HIGHEST configured level; ambiguity drifts UP.
//   balanced:      default to costControl.defaultLevel; ambiguity stays put.
//
// The session token budget forces a pin to the cheap level when exhausted.

import { LEVEL_IDS, levelIndex, driftLevel } from './config.mjs'

export class CostControl {
  /**
   * @param {object} config - normalized costControl config from resolveConfig.
   * @param {object} levels - normalized levels map from resolveConfig.
   */
  constructor(config, levels) {
    this.config = config
    this.levels = levels
    /** @type {Map<string, {spentTokens: number}>} */
    this.states = new Map()
  }

  enabled() {
    return this.config.enabled
  }

  /**
   * The default level for a task that matched no rule.
   * @returns {string} a LEVEL_IDS entry.
   */
  defaultLevel() {
    const mode = this.config.mode
    if (mode === 'cost-first') return this.lowestConfiguredLevel()
    if (mode === 'quality-first') return this.highestConfiguredLevel()
    return this.config.defaultLevel
  }

  /**
   * Drift a level by one step in the mode's preferred direction when the
   * router faces ambiguity (classifier returned a level but with low
   * confidence, or a level with no configured model).
   * @param {string} level
   * @param {boolean} [ambiguous=true]
   * @returns {string}
   */
  resolveAmbiguous(level, ambiguous = true) {
    if (!ambiguous) return level
    const mode = this.config.mode
    if (mode === 'cost-first') return driftLevel(level, 'down')
    if (mode === 'quality-first') return driftLevel(level, 'up')
    return level
  }

  /**
   * Whether a session has exhausted its budget and should be pinned to the
   * cheap level for the rest of the session.
   * @param {string} sessionId
   * @param {number} [measuredTokens]
   * @returns {boolean}
   */
  isOverBudget(sessionId, measuredTokens) {
    if (!this.config.enabled) return false
    // 0 = no budget limit.
    if (this.config.tokenBudgetPerSession <= 0) return false
    const state = this.states.get(sessionId)
    if (!state) return false
    const spent = measuredTokens ?? state.spentTokens
    return spent >= this.config.tokenBudgetPerSession
  }

  /**
   * Record token spend for one session.
   * @param {string} sessionId
   * @param {number} tokens
   */
  addSpend(sessionId, tokens) {
    if (!this.config.enabled || !Number.isFinite(tokens) || tokens <= 0) return
    const state = this.stateFor(sessionId)
    state.spentTokens += Math.round(tokens)
  }

  /**
   * Read the current spend for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  spentTokens(sessionId) {
    return this.states.get(sessionId)?.spentTokens ?? 0
  }

  /** Forget all per-session state (e.g. between runs in tests). */
  reset() {
    this.states.clear()
  }

  /** Delete one session's state (on session-start). */
  resetSession(sessionId) {
    this.states.delete(sessionId)
  }

  lowestConfiguredLevel() {
    for (const id of LEVEL_IDS) {
      if (this.levels[id]) return id
    }
    return this.config.defaultLevel
  }

  highestConfiguredLevel() {
    for (let i = LEVEL_IDS.length - 1; i >= 0; i--) {
      if (this.levels[LEVEL_IDS[i]]) return LEVEL_IDS[i]
    }
    return this.config.defaultLevel
  }

  /**
   * The cheap level the budget pin uses: the lowest level with a model.
   * @returns {string}
   */
  cheapLevel() {
    return this.lowestConfiguredLevel()
  }

  stateFor(sessionId) {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { spentTokens: 0 }
      this.states.set(sessionId, state)
    }
    return state
  }
}

/**
 * Estimate tokens for a message the cheap way (chars/4, CJK at 1.5/char)
 * used only when ctx.tokenMeter is absent.
 * @param {object} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  const text = textOf(message)
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x3000) cjk++
  }
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4)
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n')
  }
  return ''
}
