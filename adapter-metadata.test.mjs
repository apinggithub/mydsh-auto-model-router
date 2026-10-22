// The virtual `auto` model must look like the model it routes to.
//
// Regression cover for the "The `content[].thinking` in the thinking mode must
// be passed back to the API" failure: the host validates and assembles a
// request against the exact model *before* dispatch, so an `auto` model that
// reports no context window and no reasoning efforts is treated as a
// non-thinking route and the conversation loses the thinking blocks DeepSeek
// requires. These tests pin the metadata contract of `resolveModel`.
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTO_MODEL, AUTO_PROVIDER, createAutoAdapter } from './auto-adapter.mjs'

const ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }

function mockRouter(route = ROUTE) {
  return {
    config: { costControl: { defaultLevel: 'L1' } },
    routeForLevel(level) {
      return level === 'L1' ? route : null
    },
    firstConfiguredRoute() {
      return route
    },
  }
}

function mockLlm(info) {
  return {
    async resolveModelInfo() {
      return info
    },
  }
}

const INFO = {
  provider: ROUTE.provider,
  id: ROUTE.model,
  name: 'DeepSeek Flash',
  context: { contextWindow: 1_048_576 },
  defaultMaxTokens: 256_000,
  systemPromptUpdate: 'in-history',
  reasoning: {
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'high',
  },
}

function adapterFor(router, llm) {
  return createAutoAdapter({
    router: () => router,
    llm: () => llm,
  })
}

test('the virtual model borrows the routed model context window', async () => {
  const adapter = adapterFor(mockRouter(), mockLlm(INFO))
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  assert.equal(model.provider, AUTO_PROVIDER)
  assert.equal(model.id, AUTO_MODEL)
  assert.equal(model.context.contextWindow, 1_048_576)
  assert.equal(model.defaultMaxTokens, 256_000)
  assert.equal(model.systemPromptUpdate, 'in-history')
})

test('the virtual model advertises reasoning so thinking blocks survive', async () => {
  const adapter = adapterFor(mockRouter(), mockLlm(INFO))
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  const ids = model.reasoning.efforts.map((effort) => effort.id)
  assert.deepEqual(ids, ['off', 'low', 'high', 'max'])
  assert.ok(ids.includes(model.reasoning.defaultEffort))
})

test('the routed level effort becomes the default effort', async () => {
  const adapter = adapterFor(mockRouter(), mockLlm(INFO))
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  assert.equal(model.reasoning.defaultEffort, 'low')
})

test('an effort the routed model does not accept falls back to its default', async () => {
  const router = mockRouter({ provider: 'zhipu', model: 'glm-4-flash', reasoningEffort: 'max' })
  const llm = mockLlm({
    ...INFO,
    provider: 'zhipu',
    id: 'glm-4-flash',
    reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'off' },
  })
  const adapter = adapterFor(router, llm)
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  assert.deepEqual(model.reasoning.efforts.map((effort) => effort.id), ['off', 'high'])
  assert.equal(model.reasoning.defaultEffort, 'off')
})

test('a host without resolveModelInfo still yields a usable model', async () => {
  const adapter = adapterFor(mockRouter(), undefined)
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  assert.ok(model.context.contextWindow > 0)
  assert.equal(model.reasoning.defaultEffort, 'low')
  assert.equal(model.reasoning.efforts.length, 4)
})

test('a failing resolveModelInfo degrades instead of throwing', async () => {
  const llm = {
    async resolveModelInfo() {
      throw new Error('catalog unavailable')
    },
  }
  const adapter = adapterFor(mockRouter(), llm)
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  assert.equal(model.context.contextWindow, 1_000_000)
  assert.equal(model.reasoning.efforts.length, 4)
})

test('an empty router still advertises the DeepSeek defaults', async () => {
  const adapter = adapterFor(undefined, undefined)
  const model = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
  assert.equal(model.reasoning.efforts.length, 4)
  assert.ok(model.reasoning.efforts.some((effort) => effort.id === model.reasoning.defaultEffort))
})

test('prepareCall exposes the same capability metadata it resolves', async () => {
  const adapter = adapterFor(mockRouter(), mockLlm(INFO))
  const call = await adapter.prepareCall(AUTO_PROVIDER, AUTO_MODEL)
  assert.equal(call.model.context.contextWindow, 1_048_576)
  assert.equal(call.model.reasoning.defaultEffort, 'low')
  assert.equal(typeof call.stream, 'function')
})
