// Context-window guard tests: a level whose declared window cannot hold the
// conversation is skipped in favour of the nearest level that fits.
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'

const GLM = { provider: 'glm', model: 'glm-4.7-flash' }
const DS = { provider: 'deepseek-account', model: 'deepseek-flash' }

/** L0 declares a small window; the others are large or undeclared. */
function guardConfig() {
  return resolveConfig({
    levels: {
      L0: { provider: 'glm', model: 'small-window-model', reasoningEffort: 'off', freeQuota: true, contextWindow: 32768 },
      L1: { ...DS, reasoningEffort: 'low' },
      L2: { ...DS, reasoningEffort: 'high', contextWindow: 1000000 },
      L3: { ...DS, reasoningEffort: 'max' },
    },
    heuristic: {
      windowSize: 3,
      counting: 'cjk2',
      thresholds: [
        { maxChars: 10, level: 'L0' },
        { maxChars: 100, level: 'L1' },
        { maxChars: 100000, level: 'L2' },
      ],
    },
    llmClassifier: { enabled: false },
  })
}

function assertRoute(route, expected) {
  assert.equal(route.provider, expected.provider)
  assert.equal(route.model, expected.model)
}

test('a declared contextWindow survives normalization; an invalid one throws', () => {
  const config = guardConfig()
  assert.equal(config.levels.L0.contextWindow, 32768)
  assert.equal(config.levels.L1.contextWindow, undefined)
  assert.equal(config.contextGuard.enabled, true)
  assert.equal(config.contextGuard.headroom, 0.85)
  assert.throws(
    () => resolveConfig({ levels: { L0: { ...GLM, contextWindow: -1 } } }),
    /contextWindow.*must be a positive integer/,
  )
  // No window declared anywhere → the guard is inert.
  const inert = resolveConfig({ levels: { L0: GLM, L1: DS } })
  assert.equal(inert.contextGuard.enabled, false)
})

test('a conversation larger than the level window drifts up to a level that fits', async () => {
  const router = new ModelRouter(guardConfig())
  // Small conversation → L0 as configured.
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), { provider: 'glm', model: 'small-window-model' })

  // The host reports a 500k-token request — L0 (32k) cannot hold it.
  router.recordUsage('s1', { inputTokens: 480000, cacheReadTokens: 20000 })
  // 'yo' is short enough to land on L0 again; the guard must skip it.
  assertRoute(await router.decideOnInput('s1', { inputText: 'yo' }), DS)

  // The skip is recorded once and visible for reporting.
  const skips = router.contextSkipsOf('s1')
  assert.equal(skips.L0.to, 'L1')
  assert.equal(skips.L0.contextTokens, 500000)
})

test('the guard is per-session and resets with the session', async () => {
  const router = new ModelRouter(guardConfig())
  router.recordUsage('s1', { inputTokens: 400000 })
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi again' }), DS)
  // A different session has no history: L0 is fine.
  assertRoute(await router.decideOnInput('s2', { inputText: 'hi' }), { provider: 'glm', model: 'small-window-model' })
  router.resetSession('s1')
  assertRoute(await router.decideOnInput('s1', { inputText: 'fresh' }), { provider: 'glm', model: 'small-window-model' })
})

test('when nothing fits, the guard fails open on the original level', async () => {
  const config = resolveConfig({
    levels: {
      L0: { ...GLM, contextWindow: 32768 },
      L1: { ...DS, contextWindow: 65536 },
      L2: { ...DS, contextWindow: 131072 },
      L3: { ...DS, contextWindow: 262144 },
    },
    llmClassifier: { enabled: false },
  })
  const router = new ModelRouter(config)
  router.recordUsage('s1', { inputTokens: 900000 })
  // Nothing declared fits a 900k conversation → keep L0 and let the provider
  // (or the fallback chain) answer with a real error instead of guessing.
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), GLM)
  assert.equal(router.contextSkipsOf('s1').L0.to, 'L0')
})

test('usage field aliases are all read', () => {
  const router = new ModelRouter(guardConfig())
  router.recordUsage('s1', { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 5 })
  assert.equal(router.contextTokens('s1'), 125)
  router.recordUsage('s1', {})
  assert.equal(router.contextTokens('s1'), 125)
  router.recordUsage('s2', null)
  assert.equal(router.contextTokens('s2'), 0)
})
