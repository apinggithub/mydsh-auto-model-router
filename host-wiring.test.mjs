// Host-wiring test: drives the plugin's real `apply()` against a mock cordis
// context, so the event wiring (not just the router logic) is exercised 鈥?// agent/request routing, the free-quota demotion on agent/request-error, the
// retry path, the status endpoint payload and the one-shot notice.
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from './index.mjs'
import { createAutoAdapter } from './auto-adapter.mjs'

const GLM = { provider: 'glm', model: 'glm-4.7-flash' }
const DS = { provider: 'deepseek-account', model: 'deepseek-flash' }

/** A cordis-shaped context that records what the plugin registers. */
function mockCtx() {
  const handlers = new Map()
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: { registerAdapter: () => () => {} },
    tokenMeter: { estimateMessage: () => ({ totalTokens: 0 }) },
    provide() {},
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    // At boot the webserver is not up yet: this lookup returns nothing, which
    // is exactly why the route must be claimed through `inject` below.
    get: () => undefined,
    inject: (deps, callback) => {
      if (!deps.includes('webServer')) return
      callback({
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {} } },
      })
    },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
  }
  return {
    ctx,
    routes,
    emit: (event) => handlers.get(event) ?? [],
  }
}

/** A context without scoped injection, for the `ctx.get` fallback path. */
function mockCtxWithoutInject() {
  const routes = []
  const handlers = new Map()
  return {
    routes,
    emit: (event) => handlers.get(event) ?? [],
    ctx: {
      logger: { info() {} },
      llm: { registerAdapter: () => () => {} },
      tokenMeter: { estimateMessage: () => ({ totalTokens: 0 }) },
      provide() {},
      effect: (fn) => fn(),
      get: (service) => (service === 'webServer'
        ? { register: (route) => { routes.push(route); return () => {} } }
        : undefined),
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(handler)
      },
    },
  }
}

/** The plugin config under test: L0/L1 free, L2/L3 paid. */
const CONFIG = {
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
      { maxChars: 100000, level: 'L2' },
    ],
  },
  llmClassifier: { enabled: false },
  freeQuota: { enabled: true, routes: [], demoteOnError: true, notify: true },
  fallbackChain: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
}

/** A fake live agent. */
function mockAgent({ status = 'idle' } = {}) {
  const injected = []
  return {
    session: { id: 'session-test' },
    status,
    inject: (message) => {
      injected.push(message)
      return true
    },
    injected,
  }
}

/** Run one agent/request through the waterfall with the given proposal. */
async function request(emit, agent, proposed = { provider: 'auto', model: 'auto' }) {
  const [handler] = emit('agent/request')
  const next = async () => proposed
  return handler({ agent }, next)
}

/** Feed one user input through agent/pre-step so the router caches it. */
async function input(emit, agent, text) {
  const [handler] = emit('agent/pre-step')
  const messages = [{ role: 'user', content: [{ type: 'text', text }] }]
  return handler({ agent, messages, signal: { aborted: false } }, async () => ({ kind: 'enter' }))
}

test('the plugin declares the services it depends on', () => {
  assert.equal(name, 'mydsh-auto-model-router')
  for (const service of ['agents', 'sessions', 'tools', 'llm']) {
    assert.ok(inject.includes(service), `injects ${service}`)
  }
  // tokenMeter is looked up softly: a future host that renames it must not
  // turn into a failed mount (DSH boot is all-or-nothing).
  assert.ok(!inject.includes('tokenMeter'), 'tokenMeter stays a soft dependency')
})

test('Auto requests are routed to the free level, and the status route is published', async () => {
  const { ctx, routes, emit } = mockCtx()
  apply(ctx, CONFIG)
  const agent = mockAgent()

  await emit('agent/session-start')[0]({ agent })
  await input(emit, agent, 'hi')
  const decision = await request(emit, agent)

  assert.equal(decision.provider, 'glm')
  assert.equal(decision.model, 'glm-4.7-flash')
  assert.equal(decision.reasoningEffort, 'off')

  const route = routes.find((r) => r.path === '/api/mydsh-auto-model-router/status')
  assert.ok(route, 'status route registered')
  let payload = null
  await route.handler({}, { writeHead() {}, end(body) { payload = JSON.parse(body) } })
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.freeQuota, { enabled: true, routes: [], demoteOnError: true, notify: true })
  assert.equal(payload.levels.L0.freeQuota, true)
})

test('a real model choice passes through untouched', async () => {
  const { ctx, emit } = mockCtx()
  apply(ctx, CONFIG)
  const agent = mockAgent()
  await emit('agent/session-start')[0]({ agent })
  await input(emit, agent, 'hi')
  const decision = await request(emit, agent, { provider: 'qianwen', model: 'qwen3.8-flash' })
  assert.deepEqual(decision, { provider: 'qianwen', model: 'qwen3.8-flash' })
})

test('the status route is still claimed on contexts without scoped injection', () => {
  const { ctx, routes } = mockCtxWithoutInject()
  apply(ctx, CONFIG)
  assert.ok(
    routes.find((route) => route.path === '/api/mydsh-auto-model-router/status'),
    'fallback registration claimed the status route',
  )
})

test('a failing free route is demoted, retried on the paid route and reported once', async () => {
  const { ctx, emit } = mockCtx()
  apply(ctx, CONFIG)
  const agent = mockAgent()

  await emit('agent/session-start')[0]({ agent })
  await input(emit, agent, 'hi')
  const first = await request(emit, agent)
  assert.equal(first.provider, 'glm')

  // The provider answers 429 on the free route.
  const [onError] = emit('agent/request-error')
  const retry = await onError({ agent, failure: { error: { code: 'RATE_LIMIT', message: '429' } } }, async () => ({ kind: 'pass' }))
  assert.deepEqual(retry, { kind: 'retry' })

  // The retry of the SAME input reuses the decision the error handler set.
  const second = await request(emit, agent)
  assert.equal(second.provider, 'deepseek-account')
  assert.equal(second.model, 'deepseek-flash')
  // Nothing is announced yet: the notice belongs to the routing path.
  assert.equal(agent.injected.filter((m) => JSON.stringify(m).includes('free-quota')).length, 0)

  // A brand-new input re-decides, finds the free level burned and falls back 鈥?  // that is when the demotion is announced, exactly once, naming both sides.
  await input(emit, agent, 'next question')
  const third = await request(emit, agent)
  assert.equal(third.provider, 'deepseek-account')
  const notices = agent.injected.filter((m) => JSON.stringify(m).includes('free-quota'))
  assert.equal(notices.length, 1)
  assert.match(JSON.stringify(notices[0]), /glm-4\.7-flash/)
  assert.match(JSON.stringify(notices[0]), /deepseek-flash/)

  // Further inputs stay on the paid route without repeating the notice.
  await input(emit, agent, 'third question')
  await request(emit, agent)
  assert.equal(agent.injected.filter((m) => JSON.stringify(m).includes('free-quota')).length, 1)
})

test('a failure on a paid route does not burn a free route', async () => {
  const { ctx, emit } = mockCtx()
  apply(ctx, CONFIG)
  const agent = mockAgent()
  await emit('agent/session-start')[0]({ agent })
  // Wider than the free levels' ceiling (100), so the decision lands on L2.
  await input(emit, agent, 'x'.repeat(150))
  const decision = await request(emit, agent)
  assert.equal(decision.provider, 'deepseek-account')
  assert.equal(decision.reasoningEffort, 'high')

  const [onError] = emit('agent/request-error')
  const result = await onError({ agent, failure: { error: { code: 'SERVER' } } }, async () => ({ kind: 'pass' }))
  // Pre-existing chain semantics: the default route (L1 = the free route) is
  // appended to a chain that only lists the paid one, so the retry lands there.
  assert.deepEqual(result, { kind: 'retry' })
  // No demotion was announced, and the free route is still usable this
  // session: three short inputs push the heuristic window back down.
  assert.equal(agent.injected.filter((m) => JSON.stringify(m).includes('free-quota')).length, 0)
  for (const text of ['a', 'b', 'c']) {
    await input(emit, agent, text)
    await request(emit, agent)
  }
  const after = await request(emit, agent)
  assert.equal(after.provider, 'glm')
})

test('demotion survives a failing notice channel', async () => {
  const { ctx, emit } = mockCtx()
  apply(ctx, CONFIG)
  const agent = mockAgent({ status: 'running' }) // inject() is refused while busy
  await emit('agent/session-start')[0]({ agent })
  await input(emit, agent, 'hi')
  await request(emit, agent)

  const [onError] = emit('agent/request-error')
  const retry = await onError({ agent, failure: { error: { code: 'QUOTA' } } }, async () => ({ kind: 'pass' }))
  assert.deepEqual(retry, { kind: 'retry' })
  assert.equal(agent.injected.length, 0)

  await input(emit, agent, 'next')
  const next = await request(emit, agent)
  assert.equal(next.provider, 'deepseek-account')
})

test('the virtual auto adapter satisfies the 0.2.x prepareCall contract', async () => {
  const seen = []
  const llm = {
    stream: (options) => (async function* () {
      yield { forwardedTo: `${options.provider}/${options.model}`, effort: options.reasoningEffort }
    })(),
  }
  const router = {
    current: () => ({ provider: 'bailian', model: 'qwen3.8-flash', reasoningEffort: 'off' }),
  }
  const adapter = createAutoAdapter({ router: () => router, llm: () => llm })

  const call = await adapter.prepareCall('auto', 'auto', undefined)
  // Exactly what normalizeModelInfo validates on the host side.
  assert.equal(call.model.provider, 'auto')
  assert.equal(call.model.id, 'auto')
  assert.equal(typeof call.model.name, 'string')
  assert.ok(call.model.name.length > 0)
  assert.equal(typeof call.stream, 'function')

  // The stream it hands back forwards to the router's current decision, so a
  // call the router did not intercept still reaches a real model. This mock
  // host cannot report the routed model's efforts, so the level's `off` is
  // dropped rather than sent to a model that may have no thinking mode.
  for await (const chunk of call.stream({ sessionId: 's1' })) seen.push(chunk)
  assert.deepEqual(seen, [{ forwardedTo: 'bailian/qwen3.8-flash', effort: undefined }])
})
