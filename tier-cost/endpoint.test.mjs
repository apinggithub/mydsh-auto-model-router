// Endpoint integration test for dsh-tier-cost: a real session-log directory
// (zstd frames), a fake router + billing peer on loopback, the plugin's own
// apply() wiring, and the HTTP handler — i.e. everything except the host.
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { apply, USAGE_ROUTE } from './index.mjs'

const ROUTER_STATUS = {
  levels: {
    L0: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' },
    L1: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'low' },
    L2: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    L3: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  },
  freeQuota: { enabled: true, routes: [] },
}

/** The billing plugin's fold, trimmed to the fields tier-cost consumes. */
const BILLING_USAGE = {
  byTurn: [
    { sessionId: 'session-abc', turn: 1, cost: 0.01 },
    { sessionId: 'session-abc', turn: 2, cost: 1.5 },
    { sessionId: 'sub-xyz', turn: 1, cost: 2 },
  ],
}

/** A session log: two routed turns, one free level and one paid level. */
function sessionEvents() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'request/header', data: { header: { config: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' } } } },
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 }, message: { source: { provider: 'glm', model: 'glm-4.7-flash' } } } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } } } },
    { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 2000, outputTokens: 200 }, message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
  ]
}

/** Write a two-level-deep session log exactly like the host does. */
function writeLog(root, workspace, sessionId, events) {
  const dir = path.join(root, workspace, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const frame = zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frame)
  return dir
}

/** A loopback peer serving the router status and billing usage routes. */
function startPeer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/mydsh-auto-model-router/status') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ROUTER_STATUS))
      return
    }
    if (request.url === '/api/billing/usage-stats') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(BILLING_USAGE))
      return
    }
    response.writeHead(404)
    response.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** A cordis-shaped context capturing the route the plugin registers. */
function mockCtx() {
  const captured = { route: null }
  return {
    captured,
    ctx: {
      effect: (fn) => fn(),
      // At boot the webserver is not up yet, so the lookup finds nothing: the
      // route must be claimed through `inject` instead.
      get: () => undefined,
      inject: (deps, callback) => {
        if (!deps.includes('webServer')) return
        callback({
          effect: (fn) => fn(),
          webServer: { register: (route) => { captured.route = route; return () => {} } },
        })
      },
    },
  }
}

/** A context without scoped injection, for the `ctx.get` fallback path. */
function mockCtxWithoutInject() {
  const captured = { route: null }
  return {
    captured,
    ctx: {
      effect: (fn) => fn(),
      get: (service) => (service === 'webServer'
        ? { register: (route) => { captured.route = route; return () => {} } }
        : undefined),
    },
  }
}

/** Call the registered handler with a fake request/response pair. */
async function callRoute(route, host = '127.0.0.1:19387') {
  const out = { status: null, headers: null, body: '' }
  const response = {
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body ?? '' },
  }
  await route.handler({ method: 'GET', headers: { host } }, response)
  return { ...out, json: out.body === '' ? null : JSON.parse(out.body) }
}

test('the route folds logs, joins per-turn cost and labels each bucket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-cost-int-'))
  const { server, port } = await startPeer()
  try {
    writeLog(root, '--D-dsh-default-workspace--', 'session-abc', sessionEvents())
    writeLog(root, '--D-dsh-default-workspace--', 'sub-xyz', [
      { type: 'request/header', data: { header: { config: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' } } } },
      { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { provider: 'glm', model: 'glm-4.7-flash' } } } },
    ])

    const { ctx, captured } = mockCtx()
    apply(ctx, { sessionsDir: root, baseUrl: `http://127.0.0.1:${port}` })
    assert.equal(captured.route.path, USAGE_ROUTE)

    const first = await callRoute(captured.route)
    assert.equal(first.status, 200)
    assert.equal(first.json.ok, true)
    assert.equal(first.json.sessionLogs, 2)
    assert.equal(first.json.turns, 3)

    // Turn 1 of both sessions ran on the free L0 route; turn 2 on the paid L3.
    assert.equal(first.json.levels.L0.turns, 2)
    assert.equal(first.json.levels.L0.calls, 2)
    assert.equal(first.json.levels.L0.input, 1010)
    assert.equal(first.json.levels.L0.output, 101)
    assert.equal(first.json.levels.L0.cacheRead, 500)
    assert.equal(first.json.levels.L0.cost, 0.01 + 2)
    assert.equal(first.json.levels.L3.turns, 1)
    assert.equal(first.json.levels.L3.input, 2000)
    assert.equal(first.json.levels.L3.cost, 1.5)

    assert.equal(first.json.totals.calls, 3)
    assert.equal(first.json.totals.input, 3010)
    assert.equal(first.json.totals.cost, 3.51)
    assert.equal(first.json.costPriced, true)
    assert.equal(first.json.costPartial, false)
    assert.match(first.json.levelLabels.L0, /glm\/glm-4\.7-flash/)
    assert.match(first.json.levelLabels.L3, /deepseek-account\/deepseek-flash/)
    assert.deepEqual(first.json.notes, [])
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the report degrades cleanly when the peer plugins are absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-cost-int-'))
  try {
    writeLog(root, 'ws', 'session-abc', sessionEvents())
    const { ctx, captured } = mockCtx()
    // No baseUrl and a Host header that is not loopback → no peer is reachable.
    apply(ctx, { sessionsDir: root })
    const result = await callRoute(captured.route, 'example.com:80')

    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    // Tokens are still counted; nothing is priced and the reason is reported.
    assert.equal(result.json.totals.input, 3000)
    assert.equal(result.json.totals.cost, 0)
    assert.equal(result.json.costPriced, false)
    assert.ok(result.json.notes.some((note) => note.startsWith('router-status-unavailable')))
    assert.ok(result.json.notes.some((note) => note.startsWith('billing-unavailable')))
    assert.ok(result.json.notes.some((note) => note.startsWith('no-level-table')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a missing sessions directory reports zero instead of throwing', async () => {
  const { ctx, captured } = mockCtx()
  apply(ctx, { sessionsDir: path.join(os.tmpdir(), 'tier-cost-does-not-exist-xyz') })
  const result = await callRoute(captured.route, 'example.com:80')
  assert.equal(result.status, 200)
  assert.equal(result.json.sessionLogs, 0)
  assert.equal(result.json.turns, 0)
})

test('the usage route is still claimed on contexts without scoped injection', () => {
  const { ctx, captured } = mockCtxWithoutInject()
  apply(ctx, { sessionsDir: path.join(os.tmpdir(), 'tier-cost-does-not-exist-xyz') })
  assert.equal(captured.route.path, USAGE_ROUTE)
})
