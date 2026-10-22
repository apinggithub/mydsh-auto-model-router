// Quota watchdog: read the cloud bill and retire routes that stopped being free.
//
// A "free" tier is only free until the provider silently switches it to
// pay-as-you-go; the router cannot see that from the request path (no error is
// raised). This module asks the billing API instead: once a model that should
// be free shows any spend in the current cycle, its route is retired for the
// session and the router drifts to the next candidate. A balance floor stops
// paid routes entirely before the account runs dry.
//
// Read-only: two GETs per poll (`QueryAccountBalance`, `DescribeInstanceBill`),
// signed with the Aliyun RPC scheme (HMAC-SHA1). No SDK, no dependencies.
import { createHmac, randomUUID } from 'node:crypto'

/** Default bailian product code on the Aliyun bill. */
export const BILL_PRODUCT_CODE = 'sfm'

/** RFC 3986 encoding as Aliyun's RPC signature expects. */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~')
}

/**
 * Build a signed Aliyun RPC GET URL.
 * @param {object} options
 * @param {string} options.action
 * @param {Record<string, string|number>} [options.params]
 * @param {string} options.accessKeyId
 * @param {string} options.accessKeySecret
 * @param {string} [options.endpoint]
 * @param {string} [options.version]
 * @param {Date} [options.now]
 * @returns {string}
 */
export function signedUrl({
  action,
  params = {},
  accessKeyId,
  accessKeySecret,
  endpoint = 'https://business.aliyuncs.com/',
  version = '2017-12-14',
  now = new Date(),
}) {
  const common = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Action: action,
    ...params,
  }
  const canonical = Object.keys(common)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(common[key])}`)
    .join('&')
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64')
  return `${endpoint}?${canonical}&Signature=${percentEncode(signature)}`
}

/** Extract the model id from a 百炼 bill line (`id;instance;model;item;..`). */
export function modelOfBillItem(item) {
  const parts = String(item?.InstanceID ?? '').split(';')
  return (parts[2] ?? '').trim()
}

/**
 * Sum this cycle's bill by model.
 * @param {object[]} items - DescribeInstanceBill `Items`
 * @returns {{ byModel: Record<string, number>, total: number, lines: number }}
 */
export function aggregateBillItems(items = []) {
  const byModel = {}
  let total = 0
  let lines = 0
  for (const item of items) {
    const model = modelOfBillItem(item)
    if (model === '') continue
    const cost = Number(item.AfterDiscountAmount ?? item.PretaxGrossAmount ?? 0)
    if (!Number.isFinite(cost)) continue
    byModel[model] = (byModel[model] ?? 0) + cost
    total += cost
    lines += 1
  }
  return { byModel, total, lines }
}

/** Read the account's available balance in CNY. */
export async function fetchBalance({ accessKeyId, accessKeySecret, timeoutMs = 20_000, fetchImpl = fetch }) {
  const url = signedUrl({ action: 'QueryAccountBalance', accessKeyId, accessKeySecret })
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  const body = JSON.parse(await response.text())
  const data = body?.Data ?? {}
  return {
    availableCny: Number(data.AvailableAmount ?? 0),
    currency: data.Currency ?? 'CNY',
    raw: data,
  }
}

/** Read one billing cycle, following NextToken until exhausted. */
export async function fetchBill({
  accessKeyId,
  accessKeySecret,
  cycle = new Date().toISOString().slice(0, 7),
  maxPages = 10,
  timeoutMs = 20_000,
  fetchImpl = fetch,
}) {
  const items = []
  let token
  for (let page = 0; page < maxPages; page += 1) {
    const url = signedUrl({
      action: 'DescribeInstanceBill',
      params: { BillingCycle: cycle, MaxResults: 300, ...token === undefined ? {} : { NextToken: token } },
      accessKeyId,
      accessKeySecret,
    })
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = JSON.parse(await response.text())
    const data = body?.Data ?? {}
    items.push(...(data.Items ?? []))
    token = data.NextToken
    if (token === undefined || (data.Items ?? []).length === 0) break
  }
  return { cycle, items, ...aggregateBillItems(items) }
}

/**
 * Build the watchdog bound to one plugin mount.
 *
 * @param {object} options
 * @param {object} options.config - resolved `quotaWatch` config
 * @param {object} options.router - ModelRouter
 * @param {object} [options.credentials] - ctx.credentials (`resolve(ref) → {value}`)
 * @param {object} [options.logger]
 * @param {Function} [options.fetchImpl] - injection point for tests
 * @param {() => Date} [options.now]
 */
export function createQuotaWatch({ config, router, credentials, logger, fetchImpl = fetch, now = () => new Date() }) {
  let timer
  let running = false
  const retired = new Set()
  let balanceWarned = false
  let snapshot = {
    enabled: config.enabled === true,
    lastCheckAt: null,
    lastError: null,
    balanceCny: null,
    cycle: null,
    spendByModel: {},
    totalCny: null,
    exhausted: [],
    balanceLow: false,
  }

  async function readSecret(ref) {
    if (typeof credentials?.resolve !== 'function') {
      throw new Error(`mydsh-auto-model-router: no credentials service for "${ref}"`)
    }
    const resolved = await credentials.resolve(ref)
    const value = typeof resolved === 'string' ? resolved : resolved?.value
    if (typeof value !== 'string' || value === '') {
      throw new Error(`mydsh-auto-model-router: credential "${ref}" is not set`)
    }
    return value
  }

  /** Routes this watchdog guards: levels plus declared free routes. */
  function guardedRoutes() {
    const routes = []
    for (const route of Object.values(router.levels ?? {})) if (route) routes.push(route)
    for (const route of router.config?.freeQuota?.routes ?? []) if (route) routes.push(route)
    return routes.filter((route) => route.provider === config.provider)
  }

  async function check() {
    if (running) return snapshot
    running = true
    try {
      const accessKeyId = await readSecret(config.accessKeyIdRef)
      const accessKeySecret = await readSecret(config.accessKeySecretRef)
      const io = { accessKeyId, accessKeySecret, timeoutMs: config.timeoutMs, fetchImpl }
      const balance = await fetchBalance(io)
      const bill = await fetchBill({ ...io, cycle: now().toISOString().slice(0, 7) })

      const floor = Number(config.balanceFloorCny) || 0
      const low = floor > 0 && balance.availableCny < floor
      if (low !== router.isBalanceLow()) {
        router.setBalanceLow(low)
        if (low) {
          logger?.warn?.(`[mydsh-auto-model-router] balance ¥${balance.availableCny.toFixed(2)} is below the ¥${floor} floor: paid routes are paused`)
          balanceWarned = true
        } else if (balanceWarned) {
          logger?.info?.(`[mydsh-auto-model-router] balance ¥${balance.availableCny.toFixed(2)} is above the floor again: paid routes resumed`)
          balanceWarned = false
        }
      }

      if (config.demoteOnSpend) {
        for (const route of guardedRoutes()) {
          const spend = bill.byModel[route.model]
          if (!(spend > 0)) continue
          router.markRouteExhausted(route)
          const key = `${route.provider}/${route.model}`
          if (!retired.has(key)) {
            retired.add(key)
            logger?.warn?.(
              `[mydsh-auto-model-router] ${key} billed ¥${spend.toFixed(4)} this cycle — `
              + 'it is not a free route any more; retired for this session',
            )
          }
        }
      }

      snapshot = {
        enabled: true,
        lastCheckAt: now().toISOString(),
        lastError: null,
        balanceCny: balance.availableCny,
        cycle: bill.cycle,
        spendByModel: bill.byModel,
        totalCny: bill.total,
        exhausted: router.exhaustedRouteKeys(),
        balanceLow: router.isBalanceLow(),
      }
    } catch (error) {
      snapshot = { ...snapshot, lastCheckAt: now().toISOString(), lastError: String(error?.message ?? error) }
      logger?.warn?.(`[mydsh-auto-model-router] quota check failed: ${error?.message ?? error}`)
    } finally {
      running = false
    }
    return snapshot
  }

  return {
    check,
    snapshot: () => snapshot,
    /** Start polling; returns a disposer. */
    start() {
      if (config.enabled !== true) return () => {}
      if (timer !== undefined) return () => stop()
      // Kick off immediately, then on the configured cadence.
      void check()
      timer = setInterval(() => void check(), config.pollMs)
      timer.unref?.()
      return () => stop()
    },
    stop,
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
}
