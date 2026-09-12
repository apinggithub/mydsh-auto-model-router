// Rule layer (tier 1): zero-cost deterministic routing.
// Rules are tried in order; the first rule whose pattern matches the
// classification text wins and returns a LEVEL id (L0…L3), which the router
// maps to the user-configured model for that level.

/**
 * Match the classification text against every rule.
 * @param {object[]} rules - normalized rules from resolveConfig.
 * @param {string} text - the text to classify against.
 * @returns {string | null} the first matching rule's level, or null.
 */
export function matchRules(rules, text) {
  if (!rules || rules.length === 0) return null
  const haystack = String(text ?? '')
  if (haystack.trim() === '') return null
  for (const rule of rules) {
    if (rule.regex) {
      rule.regex.lastIndex = 0
      if (rule.regex.test(haystack)) return rule.level
    } else if (haystack.toLowerCase().includes(rule.match.toLowerCase())) {
      return rule.level
    }
  }
  return null
}

/**
 * Build the text the router classifies on for one step.
 * Concatenates the latest user message content plus the session's cwd so
 * rules can match paths ("src/api", "migrations").
 * @param {object} options - { messages, cwd }.
 * @returns {string} classification haystack.
 */
export function classificationText({ messages = [], cwd = '' } = {}) {
  const parts = []
  for (let i = messages.length - 1; i >= 0 && parts.length < 3; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = extractText(message)
    if (text) {
      parts.unshift(text)
      break
    }
  }
  if (cwd) parts.push(` cwd:${cwd}`)
  return parts.join('\n')
}

function extractText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n')
      .trim()
  }
  return ''
}
