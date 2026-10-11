// tier-cost tests: attribution, the cost join, and the loopback/log plumbing.
//
//   node --test *.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  attributeSession, decodeLog, foldLevels, levelMapFromRouter, levelOf,
  parseEvents, usageOf, FREE, MANUAL, UNKNOWN,
} from './session-cost.mjs'
import { isLoopbackHost, listSessionLogs, originFromHost, resolveOptions } from './index.mjs'

const STATUS = {
  levels: {
    L0: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' },
    L1: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'low' },
    L2: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    L3: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  },
  freeQuota: { routes: [{ provider: 'glm', model: 'glm-4.5-flash', maxLevel: 'L1', reasoningEffort: 'off' }] },
}

// ── level mapping ────────────────────────────────────────────────────────

test('levelOf matches on provider+model+effort first', () => {
  const map = levelMapFromRouter(STATUS)
  assert.equal(levelOf(map, { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' }), 'L0')
  assert.equal(levelOf(map, { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'low' }), 'L1')
  assert.equal(levelOf(map, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }), 'L3')
})

test('levelOf treats a missing effort as off', () => {
  const map = levelMapFromRouter(STATUS)
  assert.equal(levelOf(map, { provider: 'glm', model: 'glm-4.7-flash' }), 'L0')
})

test('levelOf falls back to provider+model, then to free routes and manual/unknown', () => {
  const map = levelMapFromRouter(STATUS)
  // Same model, effort not in the table → the first level that uses it.
  assert.equal(levelOf(map, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' }), 'L2')
  // A declared free route that is not a level.
  assert.equal(levelOf(map, { provider: 'glm', model: 'glm-4.5-flash' }), FREE)
  // An empty table means "the router is not routing" → manual.
  assert.equal(levelOf({ levels: [], free: [] }, { provider: 'glm', model: 'glm-5.3' }), MANUAL)
  // A populated table that misses → unattributed.
  assert.equal(levelOf(map, { provider: 'glm', model: 'glm-5.3' }), UNKNOWN)
  assert.equal(levelOf(map, {}), UNKNOWN)
})

// ── decoding ─────────────────────────────────────────────────────────────

test('decodeLog walks every zstd frame of an appended log', () => {
  const frameA = zlib.zstdCompressSync(Buffer.from('{"type":"a"}\n'))
  const frameB = zlib.zstdCompressSync(Buffer.from('{"type":"b"}\n'))
  const text = decodeLog(Buffer.concat([frameA, frameB]), zlib.zstdDecompressSync)
  assert.deepEqual(parseEvents(text).map((e) => e.type), ['a', 'b'])
})

test('decodeLog survives a torn trailing frame and empty input', () => {
  const good = zlib.zstdCompressSync(Buffer.from('{"type":"ok"}\n'))
  const torn = Buffer.concat([good, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])])
  assert.deepEqual(parseEvents(decodeLog(torn, zlib.zstdDecompressSync)).map((e) => e.type), ['ok'])
  assert.equal(decodeLog(Buffer.alloc(0), zlib.zstdDecompressSync), '')
})

test('parseEvents drops malformed lines', () => {
  assert.deepEqual(parseEvents('{"a":1}\nnot json\n\n{"b":2}\n').length, 2)
})

// ── usage + attribution ──────────────────────────────────────────────────

test('usageOf normalizes adapter field names', () => {
  assert.deepEqual(
    usageOf({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
  )
  assert.deepEqual(
    usageOf({ promptTokens: 5, completionTokens: 1 }),
    { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
  )
  assert.equal(usageOf(undefined), null)
})

test('attributeSession follows the request/header that precedes each message', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'request/header', data: { header: { config: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' } } } },
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 }, message: { source: { provider: 'glm', model: 'glm-4.7-flash' } } } },
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 1 }, message: { source: { provider: 'glm', model: 'glm-4.7-flash' } } } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } } } },
    { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 7, outputTokens: 3 }, message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
  ]
  const rows = attributeSession('session-x', events, levelMapFromRouter(STATUS))
  assert.equal(rows.size, 2)
  const turn1 = rows.get('session-x::1')
  assert.equal(turn1.level, 'L0')
  assert.equal(turn1.calls, 2)
  assert.equal(turn1.input, 150)
  assert.equal(turn1.output, 15)
  assert.equal(turn1.cacheRead, 6)
  const turn2 = rows.get('session-x::2')
  assert.equal(turn2.level, 'L3')
  assert.equal(turn2.input, 7)
})

test('attributeSession ignores messages without usage', () => {
  const events = [
    { type: 'request/header', data: { header: { config: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' } } } },
    { type: 'assistant/message', data: { turn: 1, message: { source: {} } } },
  ]
  assert.equal(attributeSession('s', events, levelMapFromRouter(STATUS)).size, 0)
})

// ── the cost join ────────────────────────────────────────────────────────

test('foldLevels joins cost per turn and reports partial pricing', () => {
  const map = levelMapFromRouter(STATUS)
  const attributions = new Map([
    ...attributeSession('s1', [
      { type: 'request/header', data: { header: { config: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' } } } },
      { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 100 }, message: { source: { provider: 'glm', model: 'glm-4.7-flash' } } } },
    ], map),
    ...attributeSession('s1', [
      { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } } } },
      { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 2000, outputTokens: 200 }, message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
    ], map),
  ])
  const folded = foldLevels(attributions, [
    { sessionId: 's1', turn: 1, cost: 0 },
    { sessionId: 's1', turn: 2, cost: 1.5 },
    { sessionId: 's9', turn: 7, cost: 99 },
  ])
  assert.equal(folded.levels.L0.turns, 1)
  assert.equal(folded.levels.L0.cost, 0)
  assert.equal(folded.levels.L3.cost, 1.5)
  assert.equal(folded.totals.calls, 2)
  assert.equal(folded.totals.input, 3000)
  assert.equal(folded.totals.cost, 1.5)
  assert.equal(folded.priced, true)
  assert.equal(folded.partial, false)
})

test('foldLevels flags a fold where only some turns could be priced', () => {
  const map = levelMapFromRouter(STATUS)
  const attributions = new Map([
    ...attributeSession('s1', [
      { type: 'request/header', data: { header: { config: { provider: 'glm', model: 'glm-4.7-flash', reasoningEffort: 'off' } } } },
      { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1, outputTokens: 1 }, message: { source: { provider: 'glm', model: 'glm-4.7-flash' } } } },
    ], map),
  ])
  assert.equal(foldLevels(attributions, []).priced, false)
  assert.equal(foldLevels(attributions, []).partial, false)
  const half = foldLevels(attributions, [{ sessionId: 'other', turn: 1, cost: 3 }])
  assert.equal(half.priced, false)
  assert.equal(half.partial, false)
})

// ── host plumbing ────────────────────────────────────────────────────────

test('only loopback Host headers become an origin', () => {
  assert.equal(isLoopbackHost('127.0.0.1:19387'), true)
  assert.equal(isLoopbackHost('localhost:19387'), true)
  assert.equal(isLoopbackHost('example.com:19387'), false)
  assert.equal(isLoopbackHost(''), false)
  assert.equal(originFromHost('127.0.0.1:19387'), 'http://127.0.0.1:19387')
  assert.equal(originFromHost('localhost:8080'), 'http://127.0.0.1:8080')
  assert.equal(originFromHost('evil.example:80'), null)
  assert.equal(originFromHost('127.0.0.1'), null)
})

test('resolveOptions defaults the sessions dir under DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\tmp\\dsh-home'
  try {
    assert.equal(resolveOptions({}).sessionsDir, path.join('C:\\tmp\\dsh-home', 'sessions'))
    assert.equal(resolveOptions({ sessionsDir: 'D:\\logs' }).sessionsDir, 'D:\\logs')
    assert.equal(resolveOptions({ baseUrl: 'http://127.0.0.1:1' }).baseUrl, 'http://127.0.0.1:1')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('listSessionLogs finds session logs and skips unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-cost-'))
  try {
    fs.mkdirSync(path.join(root, 'session-abc'))
    fs.writeFileSync(path.join(root, 'session-abc', 'session.v4.jsonl.zstd'), 'x')
    fs.writeFileSync(path.join(root, 'session-abc', 'notes.txt'), 'x')
    fs.mkdirSync(path.join(root, 'def-subagent'))
    fs.writeFileSync(path.join(root, 'def-subagent', 'session.v4.jsonl.zstd'), 'x')
    fs.mkdirSync(path.join(root, 'empty-dir'))
    const all = listSessionLogs(root)
    assert.deepEqual(all.map((row) => row.sessionId).sort(), ['def-subagent', 'session-abc'])
    const mainOnly = listSessionLogs(root, false)
    assert.deepEqual(mainOnly.map((row) => row.sessionId), ['session-abc'])
    assert.deepEqual(listSessionLogs(path.join(root, 'missing')), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
