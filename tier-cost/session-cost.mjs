// Pure fold helpers for the tier-cost plugin. No cordis/host imports, so the
// whole attribution pipeline is unit-testable against fixtures.
//
// Attribution is log-derived: the router (mydsh-auto-model-router) rewrites
// every routed request, so each session log carries the provider/model/effort
// actually dispatched in `request/header.config`. Mapping those back through
// the router's own level table yields the routing level (L0–L3) that paid for
// each turn — no cooperation from the router beyond its status endpoint.

export const LEVEL_IDS = ['L0', 'L1', 'L2', 'L3']
/** The user picked a real model: the router was not in the loop. */
export const MANUAL = 'manual'
/** Free-quota route declared outside the level table. */
export const FREE = 'free'
/** Nothing matched — usually a title/compaction call outside the level table. */
export const UNKNOWN = 'unknown'

/** zstd frame magic: a session log is a concatenation of independent frames. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Offsets of every zstd frame in a session log buffer.
 * @param {Buffer|Uint8Array} buf
 * @returns {number[]}
 */
export function frameOffsets(buf) {
  const out = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) out.push(i)
  }
  return out
}

/**
 * Decode a whole session log (all frames) to text.
 * @param {Buffer|Uint8Array} buf
 * @param {(slice: Buffer) => Buffer} decompress - usually zlib.zstdDecompressSync.
 * @returns {string} decoded text (frames that fail to decode are skipped).
 */
export function decodeLog(buf, decompress) {
  const offsets = frameOffsets(buf)
  if (offsets.length === 0) return ''
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      text += decompress(buf.subarray(offsets[i], end)).toString('utf8')
    } catch {
      // A torn final frame (the log is being appended to) is not fatal.
    }
  }
  return text
}

/**
 * Parse JSONL session events, dropping malformed lines.
 * @param {string} text
 * @returns {object[]}
 */
export function parseEvents(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // ignore
    }
  }
  return out
}

/**
 * Build the level table from the router's `/api/mydsh-auto-model-router/status`
 * payload. Free routes declared outside the level table get their own bucket.
 * @param {object} status - the router status payload.
 * @returns {{ levels: object[], free: object[] }}
 */
export function levelMapFromRouter(status) {
  const levels = []
  for (const id of LEVEL_IDS) {
    const route = status?.levels?.[id]
    if (!route?.provider || !route?.model) continue
    levels.push({
      level: id,
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
    })
  }
  const free = []
  for (const entry of status?.freeQuota?.routes ?? []) {
    if (!entry?.provider || !entry?.model) continue
    free.push({ level: FREE, provider: entry.provider, model: entry.model, reasoningEffort: entry.reasoningEffort })
  }
  return { levels, free }
}

/**
 * Attribute one dispatched request config to a routing level.
 *   1. exact provider+model+effort match,
 *   2. else provider+model match (tiers that share a model but not an effort),
 *   3. else a declared free-quota route,
 *   4. else MANUAL when no level table is known, UNKNOWN when it is but misses.
 * @param {{ levels: object[], free: object[] }} map
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} config
 * @returns {string}
 */
export function levelOf(map, config) {
  const provider = config?.provider
  const model = config?.model
  if (!provider || !model) return UNKNOWN
  const effort = config?.reasoningEffort
  const levels = map?.levels ?? []
  const exact = levels.find((entry) => entry.provider === provider && entry.model === model
    && (entry.reasoningEffort ?? 'off') === (effort ?? 'off'))
  if (exact) return exact.level
  const sameModel = levels.find((entry) => entry.provider === provider && entry.model === model)
  if (sameModel) return sameModel.level
  const free = (map?.free ?? []).find((entry) => entry.provider === provider && entry.model === model)
  if (free) return free.level
  return levels.length > 0 ? UNKNOWN : MANUAL
}

/** Usage buckets of one assistant message, normalized across adapter field names. */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  return {
    input: num(usage.inputTokens ?? usage.input ?? usage.promptTokens),
    output: num(usage.outputTokens ?? usage.output ?? usage.completionTokens),
    cacheRead: num(usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cacheHitTokens),
    cacheWrite: num(usage.cacheWriteTokens ?? usage.cacheCreationTokens),
  }
}

/**
 * Walk one session's events and attribute every assistant message to a level.
 * The request that produced a message is the last `request/header` before it
 * (the host logs one per model request, in order).
 * @param {string} sessionId - the session directory name.
 * @param {object[]} events
 * @param {{ levels: object[], free: object[] }} map
 * @returns {Map<string, { sessionId: string, turn: number, level: string, provider: string, model: string, calls: number, input: number, output: number, cacheRead: number, cacheWrite: number }>}
 */
export function attributeSession(sessionId, events, map) {
  const out = new Map()
  let current = null
  for (const event of events) {
    const config = event?.type === 'request/header' ? event.data?.header?.config : null
    if (config) {
      current = {
        level: levelOf(map, config),
        provider: config.provider ?? '',
        model: config.model ?? '',
      }
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = usageOf(event.data?.usage)
    if (usage === null) continue
    const turn = Number.isInteger(event.data?.turn) ? event.data.turn : -1
    const source = event.data?.message?.source
    const provider = source?.provider ?? current?.provider ?? ''
    const model = source?.model ?? current?.model ?? ''
    const level = current && provider === current.provider && model === current.model
      ? current.level
      : levelOf(map, { provider, model, reasoningEffort: current?.reasoningEffort })
    const key = `${sessionId}::${turn}`
    const row = out.get(key) ?? {
      sessionId, turn, level, provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    }
    row.calls += 1
    row.input += usage.input
    row.output += usage.output
    row.cacheRead += usage.cacheRead
    row.cacheWrite += usage.cacheWrite
    out.set(key, row)
  }
  return out
}

/** An empty accumulator. */
function emptyBucket() {
  return { calls: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: 0 }
}

/**
 * Fold attributed turns into per-level buckets, joining cost from the billing
 * plugin's per-turn rows when they are available.
 * @param {Map<string, object>} attributions - turnKey → attribution row.
 * @param {Array<object>} costTurns - billing `byTurn` rows ({ sessionId, turn, cost, ... }).
 * @returns {object} { levels, totals, priced }
 */
export function foldLevels(attributions, costTurns = []) {
  const costByKey = new Map()
  for (const row of costTurns) {
    if (row?.sessionId === undefined || row?.turn === undefined) continue
    costByKey.set(`${row.sessionId}::${row.turn}`, Number(row.cost) || 0)
  }
  const buckets = new Map()
  const bucketFor = (level) => {
    if (!buckets.has(level)) buckets.set(level, emptyBucket())
    return buckets.get(level)
  }
  let anyPriced = false
  let anyUnpriced = false
  for (const [key, row] of attributions) {
    const bucket = bucketFor(row.level)
    bucket.calls += row.calls
    bucket.turns += 1
    bucket.input += row.input
    bucket.output += row.output
    bucket.cacheRead += row.cacheRead
    bucket.cacheWrite += row.cacheWrite
    if (costByKey.has(key)) {
      bucket.cost += costByKey.get(key)
      bucket.priced += 1
      anyPriced = true
    } else {
      anyUnpriced = true
    }
  }
  const totals = emptyBucket()
  for (const bucket of buckets.values()) {
    for (const key of Object.keys(totals)) totals[key] += bucket[key]
  }
  const order = [...LEVEL_IDS, FREE, MANUAL, UNKNOWN]
  const levels = {}
  for (const id of order) {
    const bucket = buckets.get(id)
    if (bucket === undefined) continue
    levels[id] = {
      ...bucket,
      cost: Math.round(bucket.cost * 1e6) / 1e6,
    }
  }
  return { levels, totals: { ...totals, cost: Math.round(totals.cost * 1e6) / 1e6 }, priced: anyPriced, partial: anyPriced && anyUnpriced }
}
