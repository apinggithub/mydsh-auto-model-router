// Config resolution and validation for dsh-auto-model-router (level-based design).
//
// The router works over four capability levels (L0…L3); each level is a
// provider/model route the user assigns. Three routing modes live on top:
//
//   MODE A heuristic lock (default): counts the last N user inputs' text
//     width and maps ranges to levels (a cheap L0/L1 lock). Crossing the top
//     threshold asks the user once how to proceed.
//   MODE B fixed model: user picked an explicit level; re-asks every
//     askEveryInputs user inputs.
//   MODE C fully-auto: keyword-scored rules (rules + scoring) decide first;
//     zero score falls through to the LLM classifier (llmClassifier), which
//     judges on the window of 本次输入 + 上次输入 + 上次回复.
//
//   levels:         { L0: route, L1: route, L2: route, L3: route }
//   heuristic:      { windowSize, counting, thresholds }
//   rules:          [{ match, level }]  (scored per hit)
//   scoring:        { weights, bands }
//   costControl:    { enabled, mode, defaultLevel, tokenBudgetPerSession }
//   llmClassifier:  { enabled, model, requestTimeoutMs }
//   askEveryInputs: fixed-model re-ask cadence
//   fallbackChain:  [route, ...]  (model-level, appended with the default)
//   maxRetries:     per-route retry budget on request-error

export const PLUGIN_VERSION = '0.1.0'

export const LEVEL_IDS = Object.freeze(['L0', 'L1', 'L2', 'L3'])
export const COST_MODES = Object.freeze(['cost-first', 'quality-first', 'balanced'])
export const DOWNGRADE_BEHAVIORS = Object.freeze(['silent', 'notify', 'ask'])
export const DEFAULT_LEVEL = 'L1'
export const COUNTING_MODES = Object.freeze(['cjk2', 'tokens'])

const DEFAULT_CONFIG = Object.freeze({
  levels: {
    L0: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' },
    L1: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' },
    L2: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    L3: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
  },
  // Keyword rules only take part in MODE C (fully-auto). Default empty.
  rules: [],
  heuristic: {
    windowSize: 3,
    counting: 'cjk2',
    thresholds: [
      { maxChars: 10, level: 'L0' },
      { maxChars: 100, level: 'L1' },
    ],
  },
  scoring: {
    weights: { L1: 1, L2: 2, L3: 3 },
    bands: [
      { maxScore: 0, level: 'L0' },
      { maxScore: 5, level: 'L1' },
      { maxScore: 15, level: 'L2' },
      { maxScore: null, level: 'L3' },
    ],
  },
  costControl: {
    enabled: true,
    mode: 'balanced',
    defaultLevel: DEFAULT_LEVEL,
    // 0 = no budget limit: the cost layer never downgrades from budget
    // exhaustion (downgradeBehavior is then inert). Set a positive value
    // to cap per-session spend.
    tokenBudgetPerSession: 0,
    downgradeBehavior: 'notify',
  },
  llmClassifier: {
    enabled: true,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    requestTimeoutMs: 10_000,
  },
  askEveryInputs: 3,
  fallbackChain: [],
  maxRetries: 1,
})

/**
 * Resolve and validate the effective router configuration.
 * @param {object} input - the `config:` block from the cordis patch.
 * @returns {object} validated, defaults-filled config.
 * @throws {Error} naming the offending field on invalid input.
 */
export function resolveConfig(input = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...input,
  }
  cfg.levels = normalizeLevels(cfg.levels)
  cfg.rules = normalizeRules(cfg.rules)
  cfg.heuristic = normalizeHeuristic(cfg.heuristic)
  cfg.scoring = normalizeScoring(cfg.scoring)
  cfg.costControl = normalizeCostControl(cfg.costControl)
  cfg.llmClassifier = normalizeClassifier(cfg.llmClassifier)
  cfg.askEveryInputs = clampInt(cfg.askEveryInputs, 1, 100, DEFAULT_CONFIG.askEveryInputs)
  cfg.fallbackChain = normalizeChain(cfg.fallbackChain)
  cfg.maxRetries = clampInt(cfg.maxRetries, 0, 5, DEFAULT_CONFIG.maxRetries)
  return cfg
}

function normalizeHeuristic(heuristic) {
  const h = {
    ...DEFAULT_CONFIG.heuristic,
    ...(heuristic ?? {}),
  }
  h.windowSize = clampInt(h.windowSize, 1, 20, DEFAULT_CONFIG.heuristic.windowSize)
  if (!COUNTING_MODES.includes(h.counting)) {
    throw new Error(
      `dsh-auto-model-router: heuristic.counting must be one of ${COUNTING_MODES.join(', ')}, got "${h.counting}"`,
    )
  }
  if (!Array.isArray(h.thresholds) || h.thresholds.length === 0) {
    throw new Error('dsh-auto-model-router: heuristic.thresholds must be a non-empty array')
  }
  h.thresholds = h.thresholds.map((t, index) => {
    if (!LEVEL_IDS.includes(t.level)) {
      throw new Error(`dsh-auto-model-router: heuristic.thresholds[${index}].level must be one of ${LEVEL_IDS.join(', ')}`)
    }
    const maxChars = t.maxChars === null || t.maxChars === undefined
      ? null
      : clampInt(t.maxChars, 0, 1_000_000, 0)
    return { maxChars, level: t.level }
  })
  return h
}

function normalizeScoring(scoring) {
  const s = {
    ...DEFAULT_CONFIG.scoring,
    ...(scoring ?? {}),
  }
  const weights = {}
  for (const id of LEVEL_IDS) {
    const value = Number(s.weights?.[id])
    weights[id] = Number.isFinite(value) && value > 0 ? value : (id === 'L0' ? 0 : 1)
  }
  s.weights = weights
  if (!Array.isArray(s.bands) || s.bands.length === 0) {
    throw new Error('dsh-auto-model-router: scoring.bands must be a non-empty array')
  }
  s.bands = s.bands.map((b, index) => {
    if (!LEVEL_IDS.includes(b.level)) {
      throw new Error(`dsh-auto-model-router: scoring.bands[${index}].level must be one of ${LEVEL_IDS.join(', ')}`)
    }
    return {
      maxScore: b.maxScore === null || b.maxScore === undefined
        ? null
        : clampInt(b.maxScore, 0, 1_000_000, 0),
      level: b.level,
    }
  })
  return s
}

/**
 * Every level may be omitted except the cost-control default level, which must
 * exist. Returns a level map keyed by LEVEL_IDS with undefined holes. Each
 * configured level carries an explicit reasoningEffort (default 'off').
 */
function normalizeLevels(levels) {
  const source = levels ?? {}
  const out = {}
  for (const id of LEVEL_IDS) {
    const route = source[id]
    out[id] = route === undefined || route === null
      ? undefined
      : normalizeLevelRoute(route, `levels.${id}`)
  }
  return out
}

function normalizeLevelRoute(route, where) {
  const normalized = normalizeRoute(route, where)
  // Levels always carry an explicit reasoning effort; absent → 'off' (no
  // thinking mode) so every level spells out its thinking intensity.
  return {
    ...normalized,
    reasoningEffort: normalized.reasoningEffort ?? 'off',
  }
}

function normalizeRoute(route, where) {
  if (route === undefined || route === null) {
    throw new Error(`dsh-auto-model-router: "${where}" requires a provider/model route`)
  }
  const provider = String(route.provider ?? '').trim()
  const model = String(route.model ?? '').trim()
  if (!provider || !model) {
    throw new Error(
      `dsh-auto-model-router: "${where}" needs both provider and model, got ${JSON.stringify(route)}`,
    )
  }
  const reasoningEffort = route.reasoningEffort === undefined
    ? undefined
    : String(route.reasoningEffort).trim() || undefined
  return {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('dsh-auto-model-router: "rules" must be an array')
  }
  return rules.map((rule, index) => {
    if (typeof rule.match !== 'string' || rule.match.trim() === '') {
      throw new Error(`dsh-auto-model-router: rules[${index}] needs a non-empty "match" pattern`)
    }
    if (!LEVEL_IDS.includes(rule.level)) {
      throw new Error(
        `dsh-auto-model-router: rules[${index}].level must be one of ${LEVEL_IDS.join(', ')}, got "${rule.level}"`,
      )
    }
    return {
      match: rule.match.trim(),
      regex: compilePattern(rule.match.trim(), index),
      level: rule.level,
    }
  })
}

function compilePattern(pattern, index) {
  // A pattern surrounded by slashes is treated as a RegExp literal,
  // anything else as a plain substring (case-insensitive).
  const trimmed = pattern.trim()
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/')
    const body = trimmed.slice(1, lastSlash)
    const flags = trimmed.slice(lastSlash + 1)
    try {
      return new RegExp(body, flags.includes('i') ? flags : `${flags}i`)
    } catch (error) {
      throw new Error(
        `dsh-auto-model-router: rules[${index}] has an invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return null
}

function normalizeCostControl(costControl) {
  const cc = {
    ...DEFAULT_CONFIG.costControl,
    ...(costControl ?? {}),
  }
  cc.enabled = cc.enabled !== false
  if (!COST_MODES.includes(cc.mode)) {
    throw new Error(
      `dsh-auto-model-router: costControl.mode must be one of ${COST_MODES.join(', ')}, got "${cc.mode}"`,
    )
  }
  if (!LEVEL_IDS.includes(cc.defaultLevel)) {
    throw new Error(
      `dsh-auto-model-router: costControl.defaultLevel must be one of ${LEVEL_IDS.join(', ')}, got "${cc.defaultLevel}"`,
    )
  }
  cc.tokenBudgetPerSession = clampInt(
    cc.tokenBudgetPerSession,
    0, // 0 = no budget limit
    100_000_000,
    DEFAULT_CONFIG.costControl.tokenBudgetPerSession,
  )
  if (!DOWNGRADE_BEHAVIORS.includes(cc.downgradeBehavior)) {
    throw new Error(
      `dsh-auto-model-router: costControl.downgradeBehavior must be one of ${DOWNGRADE_BEHAVIORS.join(', ')}, got "${cc.downgradeBehavior}"`,
    )
  }
  return cc
}

function normalizeClassifier(classifier) {
  const cl = {
    ...DEFAULT_CONFIG.llmClassifier,
    ...(classifier ?? {}),
  }
  cl.enabled = cl.enabled === true
  if (cl.enabled) {
    cl.model = cl.model === undefined
      ? undefined
      : normalizeRoute(cl.model, 'llmClassifier.model')
  }
  cl.requestTimeoutMs = clampInt(cl.requestTimeoutMs, 1_000, 120_000, 10_000)
  return cl
}

function normalizeChain(chain) {
  if (chain === undefined || chain === null) return []
  if (!Array.isArray(chain)) {
    throw new Error('dsh-auto-model-router: "fallbackChain" must be an array of provider/model routes')
  }
  return chain.map((route, index) => normalizeRoute(route, `fallbackChain[${index}]`))
}

/**
 * Level helper: the level index 0…3 for a LEVEL_IDS entry.
 * @param {string} level
 * @returns {number} 0-based index.
 */
export function levelIndex(level) {
  return LEVEL_IDS.indexOf(level)
}

/**
 * Clamp a level id by at most one step in a direction, staying inside L0…L3.
 * @param {string} level - starting level.
 * @param {'up'|'down'|0} direction - drift direction.
 * @returns {string}
 */
export function driftLevel(level, direction) {
  const index = levelIndex(level)
  if (index === -1) return level
  if (direction === 'up') return LEVEL_IDS[Math.min(3, index + 1)]
  if (direction === 'down') return LEVEL_IDS[Math.max(0, index - 1)]
  return level
}

function clampInt(value, minimum, maximum, fallback) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}
