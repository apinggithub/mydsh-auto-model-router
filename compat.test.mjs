// Future-host compatibility tests.
//
// The point of these tests is not the happy path (host-wiring.test.mjs covers
// that) but the shapes a later DSH may hand us: a renamed registration method,
// a dropped service, an unexpected event payload. DSH boots all-or-nothing, so
// the contract under test is "mount, degrade, log — never throw".
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply } from './index.mjs'
import { createAutoAdapter } from './auto-adapter.mjs'
import { classifyHostVersion, probeHost, registerRoute } from './compat.mjs'
import { PLUGIN_VERSION } from './config.mjs'

const DEFAULT_LLM = {
  registerAdapter: () => () => {},
  listModels: async () => [],
  stream: async function* () {},
}

/**
 * A cordis-shaped context with every knob a future host may change.
 * `tokenMeter: null` models a host that dropped the service.
 */
function makeCtx({
  tokenMeter = { estimateMessage: () => ({ totalTokens: 1 }) },
  llm = DEFAULT_LLM,
  webServer = undefined,
  scopedInject = true,
  app,
} = {}) {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
    llm,
    provide() {},
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'tokenMeter') return tokenMeter ?? undefined
      if (name === 'app') return app
      return undefined
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
    async fire(event, ...args) {
      const list = handlers.get(event) ?? []
      assert.ok(list.length > 0, `no handler registered for ${event}`)
      return list[0](...args)
    },
    warnings,
  }
  if (tokenMeter !== null) ctx.tokenMeter = tokenMeter
  if (app !== undefined) ctx.app = app
  if (scopedInject) {
    ctx.inject = (deps, callback) => {
      if (!deps.includes('webServer') || webServer === undefined) return
      callback({ effect: (fn) => fn(), webServer })
    }
  }
  return ctx
}

/** One live agent stub. */
function agent(id = 'session-compat') {
  return { session: { id }, status: 'idle', inject() { return true } }
}

test('mounts on a host that dropped the tokenMeter service', () => {
  const ctx = makeCtx({ tokenMeter: null })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.warnings.length, 0, 'a soft dependency must not warn at mount')
})

test('mounts when llm.registerAdapter is gone, and keeps routing', async () => {
  const llm = { listModels: async () => [] } // no registerAdapter, no stream
  const ctx = makeCtx({ llm })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.ok(
    ctx.warnings.some((message) => message.includes('registerAdapter')),
    'the missing virtual provider is reported',
  )

  const live = agent()
  await ctx.fire('agent/pre-step', {
    agent: live,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: { aborted: false },
  }, async () => ({ kind: 'enter' }))
  const routed = await ctx.fire('agent/request', { agent: live }, async () => ({ provider: 'auto', model: 'auto' }))
  assert.equal(routed.provider, 'deepseek-official')
  assert.equal(typeof routed.model, 'string')
})

test('claims the status route through a renamed registration method', () => {
  const routes = []
  const webServer = {
    route(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = makeCtx({ webServer })
  apply(ctx, {})
  assert.ok(
    routes.find((route) => route.path === '/api/mydsh-auto-model-router/status'),
    'route() is accepted when register() is gone',
  )
})

test('registerRoute degrades to a no-op when the server has no known method', () => {
  const dispose = registerRoute({ webServer: {} }, { kind: 'exact', path: '/x', handler() {} })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('malformed event payloads pass the host proposal through untouched', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const proposal = { provider: 'qianwen', model: 'qwen3.8-flash' }

  const routed = await ctx.fire('agent/request', undefined, async () => proposal)
  assert.deepEqual(routed, proposal)

  // No session id, no messages, no signal — none of them may throw.
  await assert.doesNotReject(() => ctx.fire('agent/pre-step', undefined, async () => ({ kind: 'enter' })))
  await assert.doesNotReject(() => ctx.fire('agent/session-start', undefined))
  await assert.doesNotReject(() => ctx.fire('session/event', undefined, undefined))
  await assert.doesNotReject(() => ctx.fire('agent/request-error', undefined, async () => ({ kind: 'pass' })))
})

test('two mounts keep their adapters independent (no global registry)', async () => {
  const first = createAutoAdapter({
    router: () => ({ current: () => ({ provider: 'p1', model: 'm1' }) }),
    llm: () => ({ stream: () => (async function* () { yield 'first' })() }),
  })
  const second = createAutoAdapter({
    router: () => ({ current: () => ({ provider: 'p2', model: 'm2' }) }),
    llm: () => ({ stream: (options) => (async function* () { yield options.provider })() }),
  })
  const collect = async (adapter, sessionId) => {
    const out = []
    for await (const chunk of (await adapter.prepareCall('auto', 'auto')).stream({ sessionId })) out.push(chunk)
    return out
  }
  assert.deepEqual(await collect(first, 'a'), ['first'])
  assert.deepEqual(await collect(second, 'b'), ['p2'])
})

test('an unwired adapter reports a missing mount instead of streaming nothing', async () => {
  const bare = createAutoAdapter()
  const call = await bare.prepareCall('auto', 'auto')
  await assert.rejects(async () => {
    for await (const _ of call.stream({ sessionId: 's' })) { /* unreachable */ }
  }, /no router decision available/)
})

test('host versions outside the exercised range are classified as untested', () => {
  assert.equal(classifyHostVersion('0.1.0-rc.6'), 'tested')
  assert.equal(classifyHostVersion('0.2.1-rc.2'), 'tested')
  assert.equal(classifyHostVersion('0.3.0'), 'tested')
  assert.equal(classifyHostVersion('0.4.0'), 'untested')
  assert.equal(classifyHostVersion('1.0.0'), 'untested')
  assert.equal(classifyHostVersion(undefined), 'unknown')
})

test('an untested host mounts with one warning naming both versions', () => {
  const ctx = makeCtx({ app: { version: '0.5.0' } })
  apply(ctx, {})
  const warning = ctx.warnings.find((message) => message.includes('outside the exercised range'))
  assert.ok(warning, 'the host line is reported')
  assert.match(warning, /0\.5\.0/)
})

test('never reads a non-injected service through ctx property access', () => {
  // cordis throws on `ctx.tokenMeter` unless the service is declared in
  // `inject`; the soft dependency must go through ctx.get() only. This is a
  // regression test for a real host failure ("cannot get property tokenMeter
  // without inject") caught by booting a 0.2.1 host.
  const ctx = makeCtx()
  delete ctx.tokenMeter
  Object.defineProperty(ctx, 'tokenMeter', {
    configurable: true,
    get() {
      throw new Error('cannot get property "tokenMeter" without inject')
    },
  })
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('the status payload reports the plugin version and the host capability probe', async () => {
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const ctx = makeCtx({ webServer })
  apply(ctx, {})

  const route = routes.find((entry) => entry.path === '/api/mydsh-auto-model-router/status')
  let body = null
  route.handler({}, { writeHead() {}, end(payload) { body = JSON.parse(payload) } })

  assert.equal(body.ok, true)
  assert.equal(body.version, PLUGIN_VERSION)
  assert.equal(body.host.compat.registerAdapter, true)
  assert.equal(typeof body.host.testedRange, 'string')
})

test('probeHost reports the missing pieces instead of throwing', () => {
  const probe = probeHost({})
  assert.equal(probe.llm, false)
  assert.equal(probe.registerAdapter, false)
  assert.equal(probe.scopedInject, false)
  assert.equal(probe.webServer, false)
})

test('the package manifest and the runtime version constant agree', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, PLUGIN_VERSION)
  assert.ok(manifest.files.includes('compat.mjs'), 'compat.mjs ships with the package')
})
