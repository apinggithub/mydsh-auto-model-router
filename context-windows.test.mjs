// Context windows: learned from the catalog, honoured when routing.
//
// Regression cover for a real failure: a 280k-token conversation was routed to
// a 262k-window free model, the provider truncated generation to the one token
// that still fit, and every retry surfaced as "reached the output token limit".
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAutoAdapter } from './auto-adapter.mjs'
import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'

const WINDOWS = {
  small: 32_000,
  mid: 262_144,
  free: 131_072,
  big: 1_048_576,
}

function makeConfig(extra = {}) {
  return resolveConfig({
    levels: {
      L0: { provider: 'p', model: 'small', reasoningEffort: null, contextWindow: WINDOWS.small },
      L1: { provider: 'p', model: 'mid', reasoningEffort: null, contextWindow: WINDOWS.mid },
      L2: { provider: 'p', model: 'mid', reasoningEffort: null, contextWindow: WINDOWS.mid },
      L3: { provider: 'p', model: 'big', reasoningEffort: 'max', contextWindow: WINDOWS.big },
    },
    heuristic: {
      windowSize: 3,
      counting: 'cjk2',
      thresholds: [
        { maxChars: 10, level: 'L0' },
        { maxChars: 100, level: 'L1' },
      ],
    },
    contextGuard: { enabled: true, headroom: 0.85 },
    freeQuota: { routes: [{ provider: 'p', model: 'free', maxLevel: 'L1' }] },
    ...extra,
  })
}

function mockLlm(windows = WINDOWS) {
  return {
    async resolveModelInfo(_provider, model) {
      const window = windows[model]
      if (window === undefined) throw new Error('unknown model')
      return { provider: 'p', id: model, name: model, context: { contextWindow: window } }
    },
  }
}

test('windows are learned from the catalog and cached', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  await router.refreshContextWindows()
  assert.equal(router.contextWindowOf({ provider: 'p', model: 'mid' }), WINDOWS.mid)
  // Second pass is a no-op inside the cache window.
  await router.refreshContextWindows()
  assert.equal(router.contextWindowOf({ provider: 'p', model: 'free' }), WINDOWS.free)
})

test('a declared window wins over the learned one', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  await router.refreshContextWindows()
  assert.equal(router.contextWindowOf({ provider: 'p', model: 'mid', contextWindow: 999 }), 999)
})

test('a long conversation drifts up to a level that fits', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  router.recordUsage('s1', { inputTokens: 300_000 })
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  assert.equal(route.model, 'big')
})

test('a free route that cannot hold the conversation is not preferred', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  router.recordUsage('s1', { inputTokens: 200_000 })
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  // L0 does not fit, L1 does; the 131k free route does not.
  assert.equal(route.model, 'mid')
})

test('a free route still wins while the conversation fits', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  router.recordUsage('s1', { inputTokens: 1_000 })
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  assert.equal(route.model, 'free')
})

test('candidateContextWindows lists the level and its free routes', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  await router.refreshContextWindows()
  assert.deepEqual(router.candidateContextWindows('L1').sort((a, b) => a - b), [WINDOWS.free, WINDOWS.mid])
  // L3 has no free route covering it.
  assert.deepEqual(router.candidateContextWindows('L3'), [WINDOWS.big])
})

test('the virtual auto model reports the smallest candidate window', async () => {
  const router = new ModelRouter(makeConfig(), { llm: mockLlm() })
  const adapter = createAutoAdapter({ router: () => router, llm: () => mockLlm() })
  const model = await adapter.resolveModel('auto', 'auto')
  assert.equal(model.context.contextWindow, WINDOWS.free)
})

test('an unreadable catalog leaves windows unknown and routing unchanged', async () => {
  const router = new ModelRouter(makeConfig(), {
    llm: {
      async resolveModelInfo() {
        throw new Error('catalog unavailable')
      },
    },
  })
  await router.refreshContextWindows()
  assert.equal(router.contextWindowOf({ provider: 'p', model: 'mid' }), undefined)
  router.recordUsage('s1', { inputTokens: 300_000 })
  const route = await router.decideOnInput('s1', { inputText: 'hi' })
  // Declared windows still drive the guard; only the catalog lookup failed.
  assert.equal(route.model, 'big')
})
