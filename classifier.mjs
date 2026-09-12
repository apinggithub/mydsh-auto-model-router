// Optional LLM classifier (MODE C fallback): when keyword scoring yields no
// hits, ask a cheap model to classify the task into a level (L0…L3). Off by
// default (latency); enable via llmClassifier.enabled + llmClassifier.model
// in the patch config.
//
// The classifier judges the WINDOW text — 本次输入 + 上次输入 + 上次回复 —
// through ctx.llm.stream with a tiny standalone prompt, and is called once
// per user input (never cached; each new input re-judges).

import { LEVEL_IDS } from './config.mjs'

const CLASSIFIER_SYSTEM = `You are a task classifier for a coding agent's model router.
Given the recent conversation window (the user's latest input, their previous
input, and the assistant's last reply), decide which capability level should
handle the LATEST user input.
Reply with ONLY a JSON object: {"level": "L0" | "L1" | "L2" | "L3"}.

Level definitions:
- L0: everyday chat, quick factual answers, trivial questions. Cheapest model.
- L1: small code edits, simple tests, basic explanations. Regular model.
- L2: writing code, reviewing code, refactoring, debugging sessions. Strong model.
- L3: fixing complex bugs, multi-step composite tasks, test suites, reporting
  on large changes, architecture decisions. Most powerful model.

When unsure between two levels, pick the LOWER level (the router's cost policy
will adjust it). Never reply with anything besides that JSON object.`

export class LlmClassifier {
  /**
   * @param {object} config - normalized llmClassifier config.
   * @param {object} llm - ctx.llm service (used only when enabled).
   */
  constructor(config, llm) {
    this.config = config
    this.llm = llm
  }

  enabled() {
    return this.config.enabled
  }

  /**
   * Classify the WINDOW text into a level id.
   * @param {string} windowText - 本次输入 + 上次输入 + 上次回复.
   * @returns {Promise<string | null>} a LEVEL_IDS entry or null.
   */
  async classify(windowText) {
    if (!this.enabled() || !this.llm || !this.config.model) return null
    const trimmed = String(windowText ?? '').trim()
    if (trimmed.length === 0) return null

    const model = this.config.model
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs)
    try {
      // ctx.llm.stream returns the AsyncIterable directly (not { stream }).
      const stream = this.llm.stream({
        provider: model.provider,
        model: model.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: CLASSIFIER_SYSTEM }] },
          { role: 'user', content: [{ type: 'text', text: trimmed }] },
        ],
        signal: controller.signal,
      })
      let buffer = ''
      for await (const chunk of stream) {
        const delta = chunk?.delta
        if (typeof delta === 'string') buffer += delta
      }
      return parseLevel(buffer)
    } catch {
      // Classifier failure is never fatal — the router falls through.
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export function parseLevel(text) {
  const match = String(text ?? '').match(/"level"\s*:\s*"(L[0-3])"/)
  if (!match) return null
  const level = match[1]
  return LEVEL_IDS.includes(level) ? level : null
}
