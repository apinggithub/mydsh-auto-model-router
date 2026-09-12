// Text-width counting for the heuristic lock.
//
// counting modes:
//   cjk2   — CJK codepoints (>= U+3000) count 2, everything else 1.
//            A Chinese char is ~1.5 tokens vs an ASCII char ~0.25 tokens;
//            doubling the CJK width keeps "10 chars" intuitive for Chinese.
//   tokens — token estimation: CJK at 1.5/char, other at 0.25/char (chars/4).

const CJK_MIN = 0x3000

/**
 * Width of one string under the configured counting mode.
 * @param {string} text
 * @param {'cjk2'|'tokens'} [mode]
 * @returns {number}
 */
export function textWidth(text, mode = 'cjk2') {
  const s = String(text ?? '')
  let cjk = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= CJK_MIN) cjk++
  }
  const other = s.length - cjk
  if (mode === 'tokens') {
    return Math.ceil(cjk * 1.5 + other / 4)
  }
  return cjk * 2 + other
}

/**
 * Sum the widths of the last `windowSize` texts in order.
 * @param {string[]} texts - newest-last.
 * @param {number} windowSize
 * @param {'cjk2'|'tokens'} [mode]
 * @returns {number}
 */
export function windowWidth(texts, windowSize, mode = 'cjk2') {
  const tail = texts.slice(-windowSize)
  return tail.reduce((sum, text) => sum + textWidth(text, mode), 0)
}

/**
 * Resolve a level from the heuristic thresholds for a width.
 * Thresholds are ordered ascending; the FIRST threshold with
 * `width <= maxChars` wins. A threshold with `maxChars: null` is a catch-all.
 * Widths above every finite threshold resolve to the LAST threshold's level
 * (the top of the lock); callers that need to distinguish "above the lock"
 * check the top finite threshold themselves.
 * @param {object[]} thresholds - [{ maxChars, level }]
 * @param {number} width
 * @returns {string} LEVEL_IDS entry
 */
export function levelForWidth(thresholds, width) {
  for (const t of thresholds) {
    if (t.maxChars === null || width <= t.maxChars) return t.level
  }
  return thresholds[thresholds.length - 1]?.level ?? 'L1'
}

/**
 * The top finite threshold's maxChars, or null when every threshold is
 * unbounded. Used by the router to detect "above the heuristic lock".
 * @param {object[]} thresholds
 * @returns {number | null}
 */
export function lockCeiling(thresholds) {
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (thresholds[i]?.maxChars !== null && thresholds[i]?.maxChars !== undefined) {
      return thresholds[i].maxChars
    }
  }
  return null
}
