// Keyword scoring for fully-auto mode (MODE C).
//
// Each rule carries a level; every keyword HIT in the window text (本次输入 +
// 上次输入 + 上次回复) adds the level's weight once per occurrence (counted
// per match, so a message mentioning "refactor" three times scores 3×).
// The accumulated score maps to a level through the configured bands.
// A score of 0 means no rule hit → the router falls through to the LLM
// classifier.

/**
 * Score one window text against the rules and return the level band.
 * @param {object[]} rules - [{ match, regex, level }]
 * @param {object} scoring - { weights, bands }
 * @param {string} text - the scoring window text.
 * @returns {{ level: string|null, score: number, hits: number }}
 *   level null when the score resolves to the 0 band (caller → classifier).
 */
export function scoreRules(rules, scoring, text) {
  const haystack = String(text ?? '')
  let score = 0
  let hits = 0
  if (haystack.trim() !== '') {
    for (const rule of rules) {
      const weight = scoring.weights[rule.level] ?? 1
      let count = 0
      if (rule.regex) {
        rule.regex.lastIndex = 0
        const copy = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`)
        let m
        while ((m = copy.exec(haystack)) !== null) {
          count++
          if (m[0] === '') copy.lastIndex++
        }
      } else {
        // Count non-overlapping substring occurrences case-insensitively.
        const needle = rule.match.toLowerCase()
        const lower = haystack.toLowerCase()
        let idx = lower.indexOf(needle)
        while (idx !== -1) {
          count++
          idx = lower.indexOf(needle, idx + needle.length)
        }
      }
      if (count > 0) {
        hits += count
        score += count * weight
      }
    }
  }
  const level = bandLevel(scoring.bands, score)
  return { level, score, hits }
}

/**
 * Map a score to a level through the bands (first band whose maxScore
 * contains the score wins; null maxScore is a catch-all).
 * A score of 0 resolves to null — the router falls through to the LLM
 * classifier instead of pinning to the lowest level directly.
 * @param {object[]} bands - [{ maxScore, level }]
 * @param {number} score
 * @returns {string | null} level id, or null when score is 0.
 */
export function bandLevel(bands, score) {
  if (score <= 0) return null
  for (const band of bands) {
    if (band.maxScore === null || score <= band.maxScore) return band.level
  }
  return bands[bands.length - 1]?.level ?? null
}
