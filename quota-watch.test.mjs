// Quota watchdog: bill parsing, signing, and the routing consequences.
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'
import { aggregateBillItems, createQuotaWatch, signedUrl } from './quota-watch.mjs'

const BILL_ITEM = (model, cost) => ({
  InstanceID: `7740466;ws-xxx;${model};input_token;0`,
  AfterDiscountAmount: cost,
  PretaxGrossAmount: cost,
})

function makeRouter() {
  return new ModelRouter(resolveConfig({
    levels: {
      L0: { provider: 'zhipu', model: 'glm-4.7-flash', reasoningEffort: null, freeQuota: true },
      L1: { provider: 'bailian-dell-vostro', model: 'qwen3.8-flash', reasoningEffort: null },
      L2: { provider: 'bailian-dell-vostro', model: 'qwen3.8-flash', reasoningEffort: null },
      L3: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    },
    heuristic: {
      windowSize: 3,
      counting: 'cjk2',
      thresholds: [{ maxChars: 10, level: 'L0' }, { maxChars: 100, level: 'L1' }],
    },
  }))
}

const WATCH_CONFIG = {
  enabled: true,
  provider: 'bailian-dell-vostro',
  productCode: 'sfm',
  pollMs: 60_000,
  balanceFloorCny: 10,
  demoteOnSpend: true,
  accessKeyIdRef: 'ALI_ID',
  accessKeySecretRef: 'ALI_SECRET',
  timeoutMs: 5_000,
}

const CREDENTIALS = {
  async resolve(ref) {
    return { value: ref === 'ALI_ID' ? 'ak-id' : 'ak-secret' }
  },
}

function fetchStub({ balance = 28.21, items = [], deepseek = '158.50' } = {}) {
  return async (url, options) => {
    if (String(url).includes('/user/balance')) {
      assert.match(String(options?.headers?.authorization), /^Bearer /)
      return {
        text: async () => JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: deepseek, granted_balance: '0.00', topped_up_balance: deepseek }],
        }),
      }
    }
    const body = url.includes('QueryAccountBalance')
      ? { Success: true, Data: { AvailableAmount: String(balance), Currency: 'CNY' } }
      : { Success: true, Data: { Items: items, NextToken: undefined } }
    return { text: async () => JSON.stringify(body) }
  }
}

test('bill lines are summed per model', () => {
  const result = aggregateBillItems([BILL_ITEM('qwen3.8-flash', 1.5), BILL_ITEM('qwen3.8-flash', 0.5), BILL_ITEM('glm-5.3', 2)])
  assert.deepEqual(result.byModel, { 'qwen3.8-flash': 2, 'glm-5.3': 2 })
  assert.equal(result.total, 4)
  assert.equal(result.lines, 3)
})

test('a signed url carries the action, the key and a signature', () => {
  const url = signedUrl({
    action: 'QueryAccountBalance',
    accessKeyId: 'ak-id',
    accessKeySecret: 'ak-secret',
    now: new Date('2026-10-22T00:00:00Z'),
  })
  assert.match(url, /Action=QueryAccountBalance/)
  assert.match(url, /AccessKeyId=ak-id/)
  assert.match(url, /Signature=[^&]+/)
  assert.match(url, /Timestamp=2026-10-22T00%3A00%3A00Z/)
})

test('spend on a guarded route retires it and is reported', async () => {
  const router = makeRouter()
  const watch = createQuotaWatch({
    config: WATCH_CONFIG,
    router,
    credentials: CREDENTIALS,
    fetchImpl: fetchStub({ items: [BILL_ITEM('qwen3.8-flash', 7.79)] }),
  })
  const snapshot = await watch.check()
  assert.equal(snapshot.balanceCny, 28.21)
  assert.equal(snapshot.spendByModel['qwen3.8-flash'], 7.79)
  assert.equal(router.isRouteExhausted({ provider: 'bailian-dell-vostro', model: 'qwen3.8-flash' }), true)
  // A model on another provider is untouched by a bailian bill.
  assert.equal(router.isRouteExhausted({ provider: 'zhipu', model: 'qwen3.8-flash' }), false)
})

test('a retired route is skipped when routing', async () => {
  const router = makeRouter()
  router.markRouteExhausted({ provider: 'bailian-dell-vostro', model: 'qwen3.8-flash' })
  const route = await router.decideOnInput('s1', { inputText: 'hello there' })
  assert.notEqual(route.model, 'qwen3.8-flash')
})

test('the balance floor pauses paid routes', async () => {
  const router = makeRouter()
  const watch = createQuotaWatch({
    config: WATCH_CONFIG,
    router,
    credentials: CREDENTIALS,
    fetchImpl: fetchStub({ balance: 3 }),
  })
  const snapshot = await watch.check()
  assert.equal(snapshot.balanceLow, true)
  assert.equal(router.isBalanceLow(), true)
  const route = await router.decideOnInput('s1', { inputText: 'hello there' })
  assert.equal(route.provider, 'zhipu')
})

test('a failing credential read is reported, not thrown', async () => {
  const router = makeRouter()
  const watch = createQuotaWatch({
    config: WATCH_CONFIG,
    router,
    credentials: {
      async resolve() {
        throw new Error('missing')
      },
    },
    fetchImpl: fetchStub(),
  })
  const snapshot = await watch.check()
  assert.match(String(snapshot.lastError), /credential|missing/i)
  assert.equal(router.isBalanceLow(), false)
})

test('the DeepSeek platform balance gets its own floor', async () => {
  const router = makeRouter()
  const watch = createQuotaWatch({
    config: { ...WATCH_CONFIG, deepseekBalanceFloor: 200, deepseekProvider: 'deepseek-official' },
    router,
    credentials: CREDENTIALS,
    fetchImpl: fetchStub({ deepseek: '158.50' }),
  })
  const snapshot = await watch.check()
  assert.equal(snapshot.deepseekBalanceCny, 158.5)
  assert.equal(snapshot.deepseekBlocked, true)
  assert.equal(router.isProviderBlocked('deepseek-official'), true)
  assert.equal(router.routeBlocked({ provider: 'deepseek-official', model: 'deepseek-flash' }), true)
  assert.equal(router.routeBlocked({ provider: 'zhipu', model: 'glm-4.5-flash' }), false)
})

test('a healthy DeepSeek balance leaves the provider alone', async () => {
  const router = makeRouter()
  const watch = createQuotaWatch({
    config: { ...WATCH_CONFIG, deepseekBalanceFloor: 10, deepseekProvider: 'deepseek-official' },
    router,
    credentials: CREDENTIALS,
    fetchImpl: fetchStub({ deepseek: '158.50' }),
  })
  const snapshot = await watch.check()
  assert.equal(snapshot.deepseekBlocked, false)
  assert.equal(router.isProviderBlocked('deepseek-official'), false)
})
