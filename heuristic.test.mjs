// Heuristic ladder: when does the router interrupt with a question?
//
// Crossing the top threshold used to always open the "pin a fixed level or
// enable fully-auto" dialog — acceptable once, annoying on every long input.
// `heuristic.askAboveLock: false` (or an unbounded top threshold) routes
// silently instead.
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'

const LEVELS = {
  L0: { provider: 'p', model: 'm0', reasoningEffort: null },
  L1: { provider: 'p', model: 'm1', reasoningEffort: null },
  L2: { provider: 'p', model: 'm2', reasoningEffort: null },
  L3: { provider: 'p', model: 'm3', reasoningEffort: null },
}

function router(heuristic) {
  return new ModelRouter(resolveConfig({ levels: LEVELS, heuristic }))
}

const FINITE = [
  { maxChars: 10, level: 'L0' },
  { maxChars: 100, level: 'L1' },
]

test('by default an over-ceiling input asks how to proceed', async () => {
  const r = router({ thresholds: FINITE })
  const decision = await r.decideOnInput('s1', { inputText: 'x'.repeat(500) })
  assert.equal(decision.needsAsk, 'above-lock')
})

test('askAboveLock: false routes silently on the last threshold', async () => {
  const r = router({ thresholds: FINITE, askAboveLock: false })
  const decision = await r.decideOnInput('s1', { inputText: 'x'.repeat(500) })
  assert.equal(decision.needsAsk, undefined)
  assert.equal(decision.model, 'm1')
})

test('an unbounded top threshold never asks', async () => {
  const r = router({
    thresholds: [
      { maxChars: 10, level: 'L0' },
      { maxChars: null, level: 'L2' },
    ],
  })
  const decision = await r.decideOnInput('s1', { inputText: 'x'.repeat(5000) })
  assert.equal(decision.needsAsk, undefined)
  assert.equal(decision.model, 'm2')
})

test('askAboveLock is normalised to a boolean', () => {
  assert.equal(resolveConfig({ heuristic: { thresholds: FINITE } }).heuristic.askAboveLock, true)
  assert.equal(resolveConfig({ heuristic: { thresholds: FINITE, askAboveLock: false } }).heuristic.askAboveLock, false)
})
