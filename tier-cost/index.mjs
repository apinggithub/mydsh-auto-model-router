// dsh-tier-cost — host half.
//
// Breaks auto-router spend down by routing level (L0–L3). Tokens come from the
// persisted session logs (each assistant message attributed to the level whose
// request produced it); cost is joined per turn from the billing plugin
// (@kenz1117/dsh-ui-usage-billing) when it is installed, so this plugin owns no
// price table and cannot drift from the panel the user already trusts.
//
// Everything is served from one loopback route:
//   GET /api/tier-cost/usage

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  attributeSession, decodeLog, foldLevels, levelMapFromRouter, parseEvents,
  FREE, LEVEL_IDS, MANUAL, UNKNOWN,
} from './session-cost.mjs'

export const name = 'dsh-tier-cost'

/** Router status route (optional dependency). */
const ROUTER_STATUS_PATH = '/api/mydsh-auto-model-router/status'
/** Billing plugin usage route (optional dependency). */
const BILLING_USAGE_PATH = '/api/billing/usage-stats'
/** The route this plugin serves. */
export const USAGE_ROUTE = '/api/tier-cost/usage'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_CACHE_MS = 10_000
const LOG_NAME = 'session.v4.jsonl.zstd'

/** Resolve the plugin's options from its cordis `config:` block. */
export function resolveOptions(config = {}) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return {
    sessionsDir: typeof config.sessionsDir === 'string' && config.sessionsDir !== ''
      ? config.sessionsDir
      : path.join(home, 'sessions'),
    baseUrl: typeof config.baseUrl === 'string' && config.baseUrl !== '' ? config.baseUrl : null,
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
    cacheMs: Number.isFinite(Number(config.cacheMs)) ? Number(config.cacheMs) : DEFAULT_CACHE_MS,
    includeSubagents: config.includeSubagents !== false,
  }
}

/**
 * Whether a Host header names this machine's loopback interface. Only used to
 * build same-origin URLs for the peer plugins, never to make a security claim.
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  const name = host.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '0.0.0.0'
}

/** `http://127.0.0.1:<port>` from a Host header, or null. */
export function originFromHost(host) {
  if (!isLoopbackHost(host)) return null
  const match = /:(\d{1,5})$/.exec(String(host))
  if (!match) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return `http://127.0.0.1:${port}`
}

/**
 * Every session log under `sessionsDir`. Layout is
 * `<sessionsDir>/<workspace>/<sessionId>/session.v4.jsonl.zstd`, and
 * workspaces nest arbitrarily deep, so walk rather than assume a depth.
 * @param {string} sessionsDir
 * @param {boolean} includeSubagents - subagent sessions carry a bare uuid name.
 * @param {number} maxDepth
 * @returns {Array<{ sessionId: string, file: string, mtimeMs: number, size: number }>}
 */
export function listSessionLogs(sessionsDir, includeSubagents = true, maxDepth = 6) {
  const out = []
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // A directory that holds the log IS a session directory.
    const log = entries.find((entry) => entry.isFile() && entry.name === LOG_NAME)
    if (log !== undefined) {
      const sessionId = path.basename(dir)
      if (includeSubagents || sessionId.startsWith('session-')) {
        const full = path.join(dir, log.name)
        try {
          const stat = fs.statSync(full)
          out.push({ sessionId, file: full, mtimeMs: stat.mtimeMs, size: stat.size })
        } catch {
          // raced with a delete; skip
        }
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      visit(path.join(dir, entry.name), depth + 1)
    }
  }
  visit(sessionsDir, 0)
  return out
}

/**
 * Read and attribute every session log, using a stat-keyed cache so repeated
 * panel loads do not re-decode unchanged logs.
 * @param {object} options
 * @param {{ levels: object[], free: object[] }} map
 * @param {Map<string, object>} cache
 * @returns {{ attributions: Map<string, object>, scanned: number, sessions: number, errors: string[] }}
 */
export function collectAttributions(options, map, cache = new Map()) {
  const attributions = new Map()
  const errors = []
  let scanned = 0
  let sessions = 0
  for (const log of listSessionLogs(options.sessionsDir, options.includeSubagents)) {
    const key = `${log.file}:${log.mtimeMs}:${log.size}`
    let rows = cache.get(key)
    if (rows === undefined) {
      try {
        const text = decodeLog(fs.readFileSync(log.file), zlib.zstdDecompressSync)
        rows = attributeSession(log.sessionId, parseEvents(text), map)
      } catch (error) {
        errors.push(`${log.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        rows = new Map()
      }
      cache.set(key, rows)
    }
    scanned += 1
    sessions += 1
    for (const [turnKey, row] of rows) attributions.set(turnKey, row)
  }
  return { attributions, scanned, sessions, errors }
}

/** JSON GET against a loopback route; returns null on any failure. */
async function getJson(origin, route, timeoutMs) {
  if (origin === null) return null
  try {
    const response = await fetch(`${origin}${route}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Build the whole report.
 * @param {object} options - resolveOptions output.
 * @param {string} origin - loopback origin of this host, or null.
 * @param {object} state - { cache, mapCache, costCache }
 * @returns {Promise<object>}
 */
export async function buildReport(options, origin, state) {
  const now = Date.now()
  const notes = []

  // 1. The router's level table (optional dependency).
  let map = state.mapCache?.value ?? { levels: [], free: [] }
  if (state.mapCache === undefined || now - state.mapCache.at > options.cacheMs) {
    const status = await getJson(origin, ROUTER_STATUS_PATH, options.timeoutMs)
    if (status !== null) {
      map = levelMapFromRouter(status)
      state.mapCache = { at: now, value: map }
    } else {
      state.mapCache = { at: now, value: map }
      notes.push('router-status-unavailable: routing levels could not be read, attribution falls back to the level table below')
    }
  }
  if (map.levels.length === 0) {
    notes.push('no-level-table: install/configure mydsh-auto-model-router (or set levelMapPath) for L0–L3 attribution')
  }

  // 2. Per-turn cost from the billing plugin (optional dependency).
  let costTurns = []
  if (state.costCache === undefined || now - state.costCache.at > options.cacheMs) {
    const usage = await getJson(origin, BILLING_USAGE_PATH, options.timeoutMs)
    if (usage !== null) {
      costTurns = Array.isArray(usage.byTurn) ? usage.byTurn : []
      state.costCache = { at: now, value: costTurns }
    } else {
      state.costCache = { at: now, value: [] }
      notes.push('billing-unavailable: tokens are counted, cost is not')
    }
  }
  costTurns = state.costCache?.value ?? []

  // 3. Fold the logs.
  const collected = collectAttributions(options, map, state.cache ??= new Map())
  for (const error of collected.errors.slice(0, 5)) notes.push(`log-error: ${error}`)
  const folded = foldLevels(collected.attributions, costTurns)

  const wired = Object.fromEntries(
    [...LEVEL_IDS, FREE, MANUAL, UNKNOWN]
      .filter((id) => folded.levels[id] !== undefined)
      .map((id) => [id, describeLevel(id, map)]),
  )
  return {
    ok: true,
    schema: 'dsh-tier-cost/usage/v1',
    generatedAt: new Date(now).toISOString(),
    sessionsDir: options.sessionsDir,
    sessionLogs: collected.scanned,
    turns: collected.attributions.size,
    levels: folded.levels,
    totals: folded.totals,
    costPriced: folded.priced,
    costPartial: folded.partial,
    levelTable: map,
    levelLabels: wired,
    notes,
  }
}

/** Human-readable description of a bucket id. */
function describeLevel(id, map) {
  if (id === MANUAL) return 'manual model choice (router not in the loop)'
  if (id === UNKNOWN) return 'unattributed (title/compaction or an unknown route)'
  if (id === FREE) {
    const entry = map.free[0]
    return entry ? `free quota: ${entry.provider}/${entry.model}` : 'free quota route'
  }
  const entry = map.levels.find((row) => row.level === id)
  return entry ? `${entry.provider}/${entry.model} (effort: ${entry.reasoningEffort ?? 'off'})` : 'not configured'
}

/** The cordis plugin entry point. */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  const state = { mapCache: undefined, costCache: undefined, cache: new Map() }

  const usageRoute = {
    kind: 'exact',
    path: USAGE_ROUTE,
    handler: async (request, response) => {
      try {
        const origin = options.baseUrl
          ?? originFromHost(request?.headers?.host ?? request?.headers?.Host)
        const report = await buildReport(options, origin, state)
        const body = JSON.stringify(report)
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        response.end(body)
      } catch (error) {
        const body = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(body)
      }
    },
  }
  const registerUsageRoute = (scope) => scope.effect(
    () => scope.webServer.register(usageRoute),
    'tierCost.usageEndpoint()',
  )
  // Claimed through a scoped injection rather than a bare
  // `ctx.get('webServer')`: at boot the service is not up yet, so the lookup
  // returns nothing, the registration is skipped, and the exact route is never
  // claimed — requests then fall through to the `/api` prefix owner (401).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerUsageRoute)
  } else {
    const webServer = ctx.get?.('webServer')
    if (webServer?.register !== undefined) {
      registerUsageRoute({ effect: (fn) => fn(), webServer })
    }
  }
}
