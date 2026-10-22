// Level routes and reasoning effort.
//
// `reasoningEffort: null` is the escape hatch for providers whose models have
// no thinking mode (Zhipu / Bailian flash models). Sending an effort to such a
// model is rejected by the host before any provider I/O with
// UNSUPPORTED_REASONING_EFFORT, so the field must be omitted entirely.
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from './config.mjs'

test('a level without an effort field defaults to off', () => {
  const config = resolveConfig({ levels: { L1: { provider: 'p', model: 'm' } } })
  assert.equal(config.levels.L1.reasoningEffort, 'off')
})

test('reasoningEffort: null omits the field instead of defaulting to off', () => {
  const config = resolveConfig({ levels: { L1: { provider: 'zhipu', model: 'glm-4-flash', reasoningEffort: null } } })
  assert.equal('reasoningEffort' in config.levels.L1, false)
  assert.equal(config.levels.L1.provider, 'zhipu')
  assert.equal(config.levels.L1.model, 'glm-4-flash')
})

test('an explicit effort is kept as written', () => {
  const config = resolveConfig({ levels: { L1: { provider: 'p', model: 'm', reasoningEffort: 'high' } } })
  assert.equal(config.levels.L1.reasoningEffort, 'high')
})

test('free-quota level flags survive normalisation', () => {
  const config = resolveConfig({
    levels: {
      L0: { provider: 'zhipu', model: 'glm-4.7-flash', reasoningEffort: null, freeQuota: true },
      L1: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    },
  })
  assert.equal(config.levels.L0.freeQuota, true)
  assert.equal('reasoningEffort' in config.levels.L0, false)
  assert.equal(config.levels.L1.freeQuota, undefined)
})
