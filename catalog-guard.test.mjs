// Catalog freshness guard tests: a level whose model id the provider no
// longer advertises drifts to the nearest fresh level and is reported with
// same-family candidates; anything unreadable fails open.
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'

/** Fake llm whose listModels answers from a per-provider id list. */
function fakeLlm(catalogByProvider) {
  const calls = []
  return {
    calls,
    registerAdapter: () => () => {},
    async listModels(provider) {
      calls.push(provider)
      const ids = catalogByProvider[provider]
      if (ids === 'throw') throw new Error('provider not registered')
      return ids.map((id) => ({ id }))
    },
  }
}

function baseConfig(extra = {}) {
  return resolveConfig({
    levels: {
      L0: { provider: 'p', model: 'qwen3.8-flash', reasoningEffort: 'off' },
      L1: { provider: 'p', model: 'ok-model', reasoningEffort: 'low' },
      L2: { provider: 'p', model: 'paid-x', reasoningEffort: 'high' },
      L3: { provider: 'p', model: 'paid-x', reasoningEffort: 'max' },
    },
    llmClassifier: { enabled: false },
    ...extra,
  })
}

test('a stale level drifts to the nearest fresh level and names candidates', async () => {
  const llm = fakeLlm({ p: ['ok-model', 'qwen3.9-flash', 'paid-x'] })
  const router = new ModelRouter(baseConfig(), { llm })
  await router.refreshCatalogs()

  const stale = router.staleLevels()
  assert.equal(stale.L0.model, 'qwen3.8-flash')
  assert.deepEqual(stale.L0.candidates, ['qwen3.9-flash'])

  // Short input → L0 band, but the route must land on L1's fresh model.
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  assert.equal(route.model, 'ok-model')
  // A fresh provider read happened exactly once per provider.
  assert.equal(llm.calls.filter((c) => c === 'p').length, 1)
})

test('an empty or unreadable catalog fails open (no skipping, no staleness)', async () => {
  for (const catalog of [[], 'throw']) {
    const llm = fakeLlm({ p: catalog })
    const router = new ModelRouter(baseConfig(), { llm })
    await router.refreshCatalogs()
    assert.deepEqual(router.staleLevels(), {})
    const route = await router.decideOnInput('s1', { inputText: 'hi' })
    assert.equal(route.model, 'qwen3.8-flash')
  }
})

test('the guard is inert without a catalog reader or when disabled', async () => {
  const llm = fakeLlm({ p: ['ok-model'] })
  const router = new ModelRouter(baseConfig({ modelsGuard: { enabled: false } }), { llm })
  await router.refreshCatalogs()
  assert.equal(llm.calls.length, 0, 'no catalog read while disabled')
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  assert.equal(route.model, 'qwen3.8-flash', 'stale route kept while disabled')

  const noReader = new ModelRouter(baseConfig(), {})
  await noReader.refreshCatalogs()
  assert.deepEqual(noReader.staleLevels(), {})
})

test('a stale free-quota route is not preferred', async () => {
  const llm = fakeLlm({ p: ['paid-x', 'ok-model'] })
  const config = resolveConfig({
    levels: {
      L0: { provider: 'p', model: 'paid-x', reasoningEffort: 'off' },
      L1: { provider: 'p', model: 'paid-x', reasoningEffort: 'low' },
    },
    heuristic: { windowSize: 3, counting: 'cjk2', thresholds: [{ maxChars: 10, level: 'L0' }] },
    llmClassifier: { enabled: false },
    freeQuota: { routes: [{ provider: 'p', model: 'gone-free-model', maxLevel: 'L0' }] },
  })
  const router = new ModelRouter(config, { llm })
  await router.refreshCatalogs()
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  assert.equal(route.model, 'paid-x', 'the dead free route was skipped')
})

test('factory default levels are valid ids and efforts on 0.2.x hosts', () => {
  const config = resolveConfig({ llmClassifier: { enabled: false } })
  const efforts = config.levels.L0 ? ['L0', 'L1', 'L2', 'L3'].map((id) => config.levels[id].reasoningEffort) : []
  assert.deepEqual(efforts, ['off', 'low', 'high', 'max'])
  for (const id of ['L0', 'L1', 'L2', 'L3']) {
    assert.equal(config.levels[id].model, 'deepseek-flash')
  }
  assert.equal(config.llmClassifier.model.model, 'deepseek-flash')
})
