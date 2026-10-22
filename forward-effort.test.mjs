// What the virtual `auto` provider forwards to the routed model.
//
// The host's model-selection listener re-applies the session's own
// `reasoningEffort` after every waterfall rewrite, so a request for
// `auto/auto` arrives here still carrying the effort the user picked in the
// selector. Forwarding that value unchanged sends a thinking parameter to a
// model without a thinking mode, which the provider rejects:
// `provider "zhipu" model "glm-4.7-flash" does not support reasoning effort "low"`.
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTO_MODEL, AUTO_PROVIDER, createAutoAdapter } from './auto-adapter.mjs'

function adapterWith(route, info) {
  let captured
  const llm = {
    async resolveModelInfo() {
      return info
    },
    async *stream(options) {
      captured = options
      yield { type: 'text-delta', text: 'ok' }
    },
  }
  const router = { current: () => route }
  const adapter = createAutoAdapter({ router: () => router, llm: () => llm })
  const forward = async (options) => {
    for await (const chunk of adapter.stream(options)) void chunk
    return captured
  }
  return { forward }
}

const NO_REASONING = { provider: 'zhipu', id: 'glm-4.7-flash', name: 'GLM', context: { contextWindow: 262144 } }
const WITH_REASONING = {
  provider: 'deepseek-account',
  id: 'deepseek-flash',
  name: 'DeepSeek Flash',
  context: { contextWindow: 1048576 },
  reasoning: {
    efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'high',
  },
}

test('an effort the routed model does not support is dropped before forwarding', async () => {
  const { forward } = adapterWith({ provider: 'zhipu', model: 'glm-4.7-flash' }, NO_REASONING)
  const sent = await forward({ provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: 'low', sessionId: 's' })
  assert.equal(sent.provider, 'zhipu')
  assert.equal(sent.model, 'glm-4.7-flash')
  assert.equal('reasoningEffort' in sent, false)
})

test('the level effort wins when the routed model supports it', async () => {
  const { forward } = adapterWith(
    { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    WITH_REASONING,
  )
  const sent = await forward({ provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: 'low' })
  assert.equal(sent.reasoningEffort, 'max')
})

test('the caller effort is kept when the level states none', async () => {
  const { forward } = adapterWith({ provider: 'deepseek-account', model: 'deepseek-flash' }, WITH_REASONING)
  const sent = await forward({ provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: 'low' })
  assert.equal(sent.reasoningEffort, 'low')
})

test('an unsupported level effort falls back to the model default', async () => {
  const { forward } = adapterWith(
    { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'medium' },
    WITH_REASONING,
  )
  const sent = await forward({ provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: 'nonsense' })
  assert.equal(sent.reasoningEffort, 'high')
})

test('forwarding never mutates the options the runtime handed in', async () => {
  const { forward } = adapterWith({ provider: 'zhipu', model: 'glm-4.7-flash' }, NO_REASONING)
  const original = { provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: 'low' }
  await forward(original)
  assert.equal(original.reasoningEffort, 'low')
  assert.equal(original.provider, AUTO_PROVIDER)
})

test('a host without model info still forwards, without the effort', async () => {
  const { forward } = adapterWith({ provider: 'zhipu', model: 'glm-4.7-flash' }, undefined)
  const sent = await forward({ provider: AUTO_PROVIDER, model: AUTO_MODEL, reasoningEffort: 'high' })
  assert.equal('reasoningEffort' in sent, false)
})
