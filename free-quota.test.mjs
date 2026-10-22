// Free-quota layer tests: declaration, preference, session demotion and the
// fallback walk that never retries a burned free route.
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig, LEVEL_IDS } from './config.mjs'
import { ModelRouter } from './router.mjs'

const GLM = { provider: 'glm', model: 'glm-4.7-flash' }
const DS = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * Routes carry their normalized reasoning effort (and, for free routes, the
 * declaration flag / level ceiling), so compare the identity fields only.
 *
 * Pass `null` as the third argument to assert that the route states **no**
 * effort at all — the shape a free route has when the user did not ask for one.
 */
function assertRoute(route, expected, effort) {
  assert.equal(route.provider, expected.provider)
  assert.equal(route.model, expected.model)
  if (effort === null) assert.equal('reasoningEffort' in route, false)
  else if (effort !== undefined) assert.equal(route.reasoningEffort, effort)
}

/** Levels with the two cheap tiers free, the expensive tiers paid. */
function freeLevelsConfig(extra = {}) {
  return resolveConfig({
    levels: {
      L0: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off', freeQuota: true },
      L1: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'low', freeQuota: true },
      L2: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
      L3: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    },
    heuristic: {
      windowSize: 3,
      counting: 'cjk2',
      thresholds: [
        { maxChars: 10, level: 'L0' },
        { maxChars: 100, level: 'L1' },
        { maxChars: 1000, level: 'L2' },
        { maxChars: 100000, level: 'L3' },
      ],
    },
    llmClassifier: { enabled: false },
    fallbackChain: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
    ...extra,
  })
}

/** Every level paid, one extra route declared free up to L1. */
function freeRouteConfig() {
  return resolveConfig({
    levels: {
      L0: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' },
      L1: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
      L2: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
      L3: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    },
    heuristic: {
      windowSize: 3,
      counting: 'cjk2',
      thresholds: [
        { maxChars: 10, level: 'L0' },
        { maxChars: 100, level: 'L1' },
        { maxChars: 1000, level: 'L2' },
        { maxChars: 100000, level: 'L3' },
      ],
    },
    llmClassifier: { enabled: false },
    freeQuota: { routes: [{ provider: 'glm', model: 'glm-4.7-flash', maxLevel: 'L1' }] },
  })
}

// 鈹€鈹€ configuration 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

test('a freeQuota level flag survives normalization', () => {
  const config = freeLevelsConfig()
  assert.equal(config.levels.L0.freeQuota, true)
  assert.equal(config.levels.L2.freeQuota, undefined)
  assert.equal(config.freeQuota.enabled, true)
  // The level route keeps its explicit effort.
  assert.equal(config.levels.L0.reasoningEffort, 'off')
  assert.equal(config.levels.L1.reasoningEffort, 'low')
})

test('an undeclared free layer stays inert (no behaviour change)', () => {
  const config = resolveConfig({ levels: { L0: DS, L1: DS, L2: DS, L3: DS } })
  assert.equal(config.freeQuota.enabled, false)
  assert.deepEqual(config.freeQuota.routes, [])
})

test('freeQuota.routes defaults maxLevel to L1 and rejects unknown levels', () => {
  const config = resolveConfig({ freeQuota: { routes: [{ ...GLM }] } })
  assert.equal(config.freeQuota.routes[0].maxLevel, 'L1')
  assert.equal(config.freeQuota.enabled, true)
  assert.throws(
    () => resolveConfig({ freeQuota: { routes: [{ ...GLM, maxLevel: 'L9' }] } }),
    /maxLevel must be one of/,
  )
  assert.throws(() => resolveConfig({ freeQuota: { routes: [{ provider: 'glm' }] } }), /needs both provider and model/)
})

// 鈹€鈹€ preference 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

test('a free route declared for L0鈥揕1 serves those levels only', async () => {
  const router = new ModelRouter(freeRouteConfig())
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), GLM, null)
  assertRoute(await router.decideOnInput('s1', { inputText: 'x'.repeat(50) }), GLM, null)
  assertRoute(await router.decideOnInput('s1', { inputText: 'x'.repeat(500) }), DS, 'high')
  assertRoute(await router.decideOnInput('s1', { inputText: 'x'.repeat(5000) }), DS, 'max')
})

test('levels already pointing at the free route keep it', async () => {
  const router = new ModelRouter(freeLevelsConfig())
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), GLM, 'off')
  assertRoute(await router.decideOnInput('s1', { inputText: 'x'.repeat(500) }), DS, 'high')
})

test('isFreeRoute sees both declaration forms', () => {
  const byLevel = new ModelRouter(freeLevelsConfig())
  assert.equal(byLevel.isFreeRoute(GLM), true)
  assert.equal(byLevel.isFreeRoute(DS), false)
  const byRoute = new ModelRouter(freeRouteConfig())
  assert.equal(byRoute.isFreeRoute(GLM), true)
  assert.equal(byRoute.isFreeRoute({ provider: 'glm', model: 'glm-4.5-flash' }), false)
})

// 鈹€鈹€ demotion 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

test('a failed free route is demoted for the session and replaced by a paid level', async () => {
  const router = new ModelRouter(freeLevelsConfig())
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), GLM, 'off')

  assert.equal(router.markFreeExhausted('s1', GLM), true)
  // Idempotent: a second failure does not re-report.
  assert.equal(router.markFreeExhausted('s1', GLM), false)
  // Non-free routes are never marked.
  assert.equal(router.markFreeExhausted('s1', DS), false)

  assertRoute(await router.decideOnInput('s1', { inputText: 'yo' }), DS, 'high')
  const demotion = router.consumeFreeDemotionFlag('s1')
  assert.equal(demotion.level, 'L0')
  // `from` is the level's normalized route (effort + flag included).
  assert.equal(demotion.from.provider, 'glm')
  assert.equal(demotion.from.model, 'glm-4.7-flash')
  assert.equal(demotion.from.reasoningEffort, 'off')
  assert.equal(demotion.from.freeQuota, true)
  assertRoute(demotion.to, DS, 'high')
  // Consumed exactly once.
  assert.equal(router.consumeFreeDemotionFlag('s1'), null)
})

test('demotion is session-scoped and does not leak', async () => {
  const router = new ModelRouter(freeLevelsConfig())
  router.markFreeExhausted('s1', GLM)
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), DS, 'high')
  assertRoute(await router.decideOnInput('s2', { inputText: 'hi' }), GLM, 'off')
})

test('a demoted freeQuota.routes entry stops being preferred', async () => {
  const router = new ModelRouter(freeRouteConfig())
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), GLM, null)
  router.markFreeExhausted('s1', GLM)
  // The level's own (paid) route takes over, and no demotion is pending
  // because this level was never free itself.
  assertRoute(await router.decideOnInput('s1', { inputText: 'yo' }), DS, 'off')
  assert.equal(router.consumeFreeDemotionFlag('s1'), null)
})

test('resetSession clears the burned-quota state', async () => {
  const router = new ModelRouter(freeLevelsConfig())
  router.markFreeExhausted('s1', GLM)
  router.resetSession('s1')
  assertRoute(await router.decideOnInput('s1', { inputText: 'hi' }), GLM, 'off')
})

// 鈹€鈹€ fallback walk 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

test('failover from a burned free route lands on the paid chain entry', () => {
  const router = new ModelRouter(freeLevelsConfig())
  router.markFreeExhausted('s1', GLM)
  const next = router.nextOnFailure('s1', GLM)
  assert.deepEqual(next, DS)
})

test('failover skips a free route that is already burned', () => {
  const config = resolveConfig({
    levels: { L0: { ...GLM, freeQuota: true }, L1: DS, L2: DS, L3: DS },
    llmClassifier: { enabled: false },
    // The chain leads with the free route: a failure elsewhere must not be
    // retried onto a route whose quota this session already burned.
    fallbackChain: [{ ...GLM }, { ...DS }],
  })
  const router = new ModelRouter(config)
  router.markFreeExhausted('s1', GLM)
  // A route that is not in the chain starts at the head 鈥?the burned free
  // entry is skipped, so the paid entry is chosen.
  assert.deepEqual(
    router.nextOnFailure('s1', { provider: 'other', model: 'unlisted' }),
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  )
})

test('failover gives up when the only alternatives are burned or just failed', () => {
  const config = resolveConfig({
    levels: { L0: { ...GLM, freeQuota: true }, L1: DS, L2: DS, L3: DS },
    llmClassifier: { enabled: false },
    fallbackChain: [{ ...GLM }, { ...DS }],
  })
  const router = new ModelRouter(config)
  router.markFreeExhausted('s1', GLM)
  // DS just failed and GLM's quota is gone: nothing viable is left.
  assert.equal(router.nextOnFailure('s1', DS), null)
})

test('every level id resolves to a route even when only free routes exist', () => {
  const config = resolveConfig({
    levels: { L1: { ...GLM, freeQuota: true } },
    llmClassifier: { enabled: false },
  })
  const router = new ModelRouter(config)
  for (const id of LEVEL_IDS) {
    const route = router.effectiveRoute(router.stateFor('s1'), 's1', id)
    assert.ok(route.provider && route.model, `level ${id} resolved to a route`)
  }
})
