// Plugin status reporting and one-time user consultation (bilingual).
//
// Surfaces, all host-side (no client bundle needed):
//
// 1. REPORT: on the first session of a plugin load (including hot reload), a
//    durable plugin user-message is injected describing the active routing
//    policy — levels→models, cost mode, budget, fallback chain. Language
//    follows the user's DSH locale preference (settings locale namespace),
//    falling back to 'en'.
//
// 2. ASK (three questions, once per plugin load):
//      Q1  Tier-1 rules:     keep, or view the current rules to decide?
//      Q2  Tier-2 cost mode: keep, or switch to cost-first/balanced/quality-first?
//      Q3  Other config:     skip, or check a named setting?
//    Answers apply live to the router runtime: Q2 switches the mode, Q1/Q3
//    inject the requested current values so the user can decide (the durable
//    change itself stays in cordis.patch.yml, which the message says).
//
// 3. DOWNGRADE: when the session budget trips, notify or ask per
//    costControl.downgradeBehavior (also bilingual).

export const PLUGIN_SOURCE = 'mydsh-auto-model-router'
const ASKED_KEY = Symbol('mydsh-auto-model-router.asked')

// ── i18n ─────────────────────────────────────────────────────────────────

const STRINGS = {
  en: {
    statusTitle: 'Model router is active. Current routing policy:',
    levels: 'Levels:',
    notConfigured: '(not configured)',
    costMode: 'Cost mode',
    defaultLevel: 'Default level',
    budget: 'Session token budget',
    rules: 'Rules',
    classifierEnabled: 'LLM classifier: enabled',
    classifierDisabled: 'LLM classifier: disabled',
    fallback: 'Fallback chain',
    statusFooter: "Adjust these in your profile's cordis.patch.yml under the mydsh-auto-model-router config block, or answer the question below to switch the cost mode now.",
    askHeader: 'Model Router',
    q1: 'Do you want to change the Tier-1 matching rules?',
    q1Keep: 'Keep current rules',
    q1View: 'View current rules',
    q2: 'Do you want to switch the Tier-2 cost mode?',
    q2Keep: 'Keep current mode',
    q2CostFirst: 'cost-first',
    q2Balanced: 'balanced',
    q2QualityFirst: 'quality-first',
    q3: 'Do you want to adjust any other configuration?',
    q3Skip: 'Skip',
    q3Check: 'Check a setting',
    q3CustomHint: 'Type which setting to inspect (e.g. budget, fallbackChain, classifier)',
    rulesView: 'Current Tier-1 rules:',
    rulesViewEmpty: 'No rules configured.',
    rulesViewFooter: 'To change a rule, edit the mydsh-auto-model-router `rules` block in cordis.patch.yml.',
    settingUnknown: 'Unknown setting "{{name}}". Known: budget, fallbackChain, classifier, rules.',
    budgetDetail: 'costControl.tokenBudgetPerSession = {{value}} tokens',
    fallbackDetail: 'fallbackChain: {{value}}',
    classifierDetail: 'llmClassifier.enabled = {{value}}',
    downgradeTitle: 'Model Router — budget exhausted',
    downgradeQuestion: 'Session {{session}} hit its token budget. Switch to the cheaper model for the rest of this session?',
    downgradeAccept: 'Use cheaper model',
    downgradeKeep: 'Keep current model',
    lockCrossedQuestion: 'This input crossed the heuristic lock ceiling. How should the router proceed?',
    lockCrossedDetail: 'input width exceeded the top threshold',
    fixedModel: 'Pin a fixed level',
    fixedModelDesc: 'Use one model level for the next inputs; re-ask after a few inputs.',
    enableAuto: 'Enable fully-auto routing',
    enableAutoDesc: 'Keyword rules score first; zero-score inputs go to the LLM classifier.',
    fixedLevelQuestion: 'Which level should this session use?',
    fixedReelectQuestion: 'Fixed level session: pick the level for the next inputs?',
    fixedLevelDesc: (level, config) => {
      const route = config.levels?.[level]
      return route ? `${route.provider}/${route.model} (effort: ${route.reasoningEffort ?? 'off'})` : 'not configured'
    },
    downgradeBody: [
      'Session {{session}} has exhausted its token budget ({{budget}} tokens).',
      'Remaining requests in this session use the cheapest level ({{model}}).',
      'Raise costControl.tokenBudgetPerSession in cordis.patch.yml to lift the cap.',
    ].join('\n'),
  },
  zh: {
    statusTitle: '模型路由插件已激活。当前路由策略：',
    levels: '层级：',
    notConfigured: '（未配置）',
    costMode: '成本模式',
    defaultLevel: '默认层级',
    budget: '会话 token 预算',
    rules: '规则数',
    classifierEnabled: 'LLM 分类器：已启用',
    classifierDisabled: 'LLM 分类器：未启用',
    fallback: '降级链',
    statusFooter: '可在 profile 的 cordis.patch.yml 中 mydsh-auto-model-router 配置块调整以上项，或回答下面的问题立即切换成本模式。',
    askHeader: '模型路由插件',
    q1: '是否需要更改 Tier-1 匹配规则？',
    q1Keep: '保持现有规则',
    q1View: '查看现有规则',
    q2: '是否需要切换 Tier-2 成本模式？',
    q2Keep: '保持当前模式',
    q2CostFirst: 'cost-first（成本优先）',
    q2Balanced: 'balanced（均衡）',
    q2QualityFirst: 'quality-first（效果优先）',
    q3: '是否需要调整其他配置？',
    q3Skip: '跳过',
    q3Check: '检查某项配置',
    q3CustomHint: '输入要检查的配置名（如 budget、fallbackChain、classifier）',
    rulesView: '当前 Tier-1 规则：',
    rulesViewEmpty: '未配置规则。',
    rulesViewFooter: '要修改规则，请编辑 cordis.patch.yml 中 mydsh-auto-model-router 的 rules 配置块。',
    settingUnknown: '未知配置 "{{name}}"。可选：budget、fallbackChain、classifier、rules。',
    budgetDetail: 'costControl.tokenBudgetPerSession = {{value}} tokens',
    fallbackDetail: 'fallbackChain：{{value}}',
    classifierDetail: 'llmClassifier.enabled = {{value}}',
    downgradeTitle: '模型路由插件 — 预算已耗尽',
    downgradeQuestion: '会话 {{session}} 已达到 token 预算。本会话剩余请求切换到更便宜的模型？',
    downgradeAccept: '使用更便宜的模型',
    downgradeKeep: '继续使用当前模型',
    lockCrossedQuestion: '本次输入已超过启发式锁上限，路由如何继续？',
    lockCrossedDetail: '输入宽度超过最高阈值',
    fixedModel: '固定使用某个层级',
    fixedModelDesc: '接下来几次输入固定用该层级；数轮后重新询问。',
    enableAuto: '开启全自动路由',
    enableAutoDesc: '关键词规则先积分定级；零分输入交给 LLM 分类器判断。',
    fixedLevelQuestion: '本会话固定使用哪个层级？',
    fixedReelectQuestion: '固定层级会话：接下来几次输入用哪个层级？',
    fixedLevelDesc: (level, config) => {
      const route = config.levels?.[level]
      return route ? `${route.provider}/${route.model}（思考: ${route.reasoningEffort ?? 'off'}）` : '未配置'
    },
    downgradeBody: [
      '会话 {{session}} 已耗尽 token 预算（{{budget}} tokens）。',
      '本会话剩余请求使用最便宜层级（{{model}}）。',
      '调高 cordis.patch.yml 中 costControl.tokenBudgetPerSession 可提高上限。',
    ].join('\n'),
  },
}

/**
 * Resolve the user's locale from the DSH settings document, falling back to
 * 'en'. `ctx.settings` may be absent in minimal harnesses — never throw.
 * @param {object} ctx - cordis context.
 * @returns {'zh' | 'en'}
 */
export function resolveLocale(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const locale = settings?.get?.('locale')
    if (locale?.preference === 'zh') return 'zh'
  } catch { /* fall through */ }
  return 'en'
}

/**
 * Build the status report text from the resolved config.
 * @param {object} config - resolved router config.
 * @param {'zh'|'en'} [locale]
 * @returns {string}
 */
export function statusReport(config, locale = 'en') {
  const t = STRINGS[locale] ?? STRINGS.en
  const lines = ['<mydsh-auto-model-router-status>', t.statusTitle, '', t.levels]
  for (const id of ['L0', 'L1', 'L2', 'L3']) {
    const route = config.levels[id]
    lines.push(`- ${id}: ${route
      ? `${route.provider}/${route.model} (effort: ${route.reasoningEffort ?? 'off'})`
      : t.notConfigured}`)
  }
  lines.push('', `${t.costMode}: ${config.costControl.mode}`)
  lines.push(`${t.defaultLevel}: ${config.costControl.defaultLevel}`)
  lines.push(`${t.budget}: ${config.costControl.tokenBudgetPerSession}`)
  lines.push(`${t.rules}: ${config.rules.length} configured`)
  lines.push(config.llmClassifier.enabled
    ? `${t.classifierEnabled} (${config.llmClassifier.model?.provider}/${config.llmClassifier.model?.model})`
    : t.classifierDisabled)
  if (config.fallbackChain.length > 0) {
    lines.push(`${t.fallback}: ${config.fallbackChain.map(r => `${r.provider}/${r.model}`).join(' → ')}`)
  }
  lines.push('', t.statusFooter, '</mydsh-auto-model-router-status>')
  return lines.join('\n')
}

// ── message injection ────────────────────────────────────────────────────

// The message constructor comes from @deepseek-ai/dsh-llm (exact-pinned peer);
// when that package is absent (unit tests without node_modules), fall back to
// the plain shape DSH accepts. In a real profile the peer is always present.
let cachedCreateUserMessage
async function createPluginUserMessage(content, form = 'status') {
  if (cachedCreateUserMessage === undefined) {
    try {
      const llm = await import('@deepseek-ai/dsh-llm')
      cachedCreateUserMessage = llm.createUserMessage
    } catch {
      cachedCreateUserMessage = null
    }
  }
  const payload = {
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: PLUGIN_SOURCE, form },
  }
  return cachedCreateUserMessage ? cachedCreateUserMessage(payload) : { role: 'user', ...payload }
}

/**
 * Inject a message into an idle agent.
 * @param {object} agent - live agent.
 * @param {string} content
 * @param {string} form
 * @returns {Promise<boolean>}
 */
async function injectInto(agent, content, form) {
  if (agent.status !== 'idle') return false
  agent.inject(await createPluginUserMessage(content, form))
  return true
}

/**
 * Inject the status report into the first session of this plugin load.
 * @param {object} agent - the live agent.
 * @param {object} config - resolved router config.
 * @param {'zh'|'en'} [locale]
 * @returns {Promise<boolean>}
 */
export async function reportStatus(agent, config, locale = 'en') {
  return injectInto(agent, statusReport(config, locale), 'status')
}

export const STATUS_STORAGE_KEY = 'mydsh-auto-model-router:status'

/**
 * Persist the status report to localStorage so the browser settings section
 * can render it without depending on the DOM transcript. Best-effort:
 * storage failures (private mode, quota) only skip persistence.
 * @param {object} config - resolved router config.
 * @param {'zh'|'en'} [locale]
 * @returns {string} the persisted report text.
 */
export function persistStatusReport(config, locale = 'en') {
  const text = statusReport(config, locale)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STATUS_STORAGE_KEY, text)
    }
  } catch { /* best-effort */ }
  return text
}

// ── three-question consultation ──────────────────────────────────────────

function modeFromLabel(label, locale) {
  const t = STRINGS[locale] ?? STRINGS.en
  const map = {
    [t.q2CostFirst]: 'cost-first',
    [t.q2Balanced]: 'balanced',
    [t.q2QualityFirst]: 'quality-first',
  }
  return map[label] ?? null
}

/**
 * Ask the user three questions once per plugin load (bilingual):
 *   Q1 rules, Q2 cost mode, Q3 other config.
 * Degrades silently when the user-questions channel is unavailable.
 *
 * @param {object} ctx - cordis context.
 * @param {object} agent - the live root agent.
 * @param {object} router - the ModelRouter instance (config mutated on answer).
 * @returns {Promise<object|null>} summary of the user's answers, or null when
 *   the channel was unavailable. { viewedRules, mode, checkedSetting }.
 */
export async function askOnce(ctx, agent, router) {
  if (ctx[ASKED_KEY]) return null
  ctx[ASKED_KEY] = true
  const userQuestions = ctx.get?.('userQuestions')
  if (!userQuestions) return null
  const locale = resolveLocale(ctx)
  const t = STRINGS[locale] ?? STRINGS.en
  try {
    const answer = await userQuestions.ask({
      agent,
      questions: [
        {
          id: 'mydsh-auto-model-router.q1-rules',
          header: t.askHeader,
          question: t.q1,
          detail: statusReport(router.config, locale),
          options: [
            { label: t.q1Keep, description: 'Tier-1 rules stay as configured.' },
            { label: t.q1View, description: 'Show the current rules in this session.' },
          ],
        },
        {
          id: 'mydsh-auto-model-router.q2-cost-mode',
          header: t.askHeader,
          question: t.q2,
          detail: statusReport(router.config, locale),
          options: [
            { label: t.q2Keep, description: `Keep ${router.config.costControl.mode}.` },
            { label: t.q2CostFirst, description: 'Prefer cheaper models; drift down on ambiguity.' },
            { label: t.q2Balanced, description: 'Default level; rules decide, budget caps.' },
            { label: t.q2QualityFirst, description: 'Prefer stronger models; drift up on ambiguity.' },
          ],
        },
        {
          id: 'mydsh-auto-model-router.q3-other',
          header: t.askHeader,
          question: t.q3,
          detail: statusReport(router.config, locale),
          options: [
            { label: t.q3Skip, description: 'Leave everything else unchanged.' },
            { label: t.q3Check, description: t.q3CustomHint },
          ],
        },
      ],
    })

    const byId = new Map((answer?.answers ?? []).map(item => [item.id, item]))
    const q1 = byId.get('mydsh-auto-model-router.q1-rules')
    const q2 = byId.get('mydsh-auto-model-router.q2-cost-mode')
    const q3 = byId.get('mydsh-auto-model-router.q3-other')

    const viewedRules = q1?.selected?.includes(t.q1View) ?? false
    if (viewedRules) {
      await injectInto(agent, rulesReport(router.config, locale), 'rules')
    }

    const mode = q2 ? modeFromLabel(q2.selected?.[0], locale) : null
    if (mode) router.config.costControl.mode = mode

    const checked = q3?.selected?.includes(t.q3Check) ?? false
    const customSetting = String(q3?.custom ?? '').trim() || undefined
    if (checked) {
      await injectInto(agent, settingReport(router.config, locale, customSetting), 'setting')
    }

    return { viewedRules, mode, checkedSetting: checked ? (customSetting ?? '') : undefined }
  } catch {
    // No provider / not live / aborted: report-only is fine.
    return null
  }
}

/**
 * Build a human-readable listing of the current rules.
 * @param {object} config
 * @param {'zh'|'en'} locale
 * @returns {string}
 */
export function rulesReport(config, locale = 'en') {
  const t = STRINGS[locale] ?? STRINGS.en
  const lines = ['<mydsh-auto-model-router-rules>', t.rulesView]
  if (config.rules.length === 0) {
    lines.push(`- ${t.rulesViewEmpty}`)
  } else {
    for (const rule of config.rules) {
      lines.push(`- ${rule.match} → ${rule.level}`)
    }
  }
  lines.push(t.rulesViewFooter, '</mydsh-auto-model-router-rules>')
  return lines.join('\n')
}

/**
 * Build a report of one named setting (or a hint when unknown).
 * @param {object} config
 * @param {'zh'|'en'} locale
 * @param {string} [name]
 * @returns {string}
 */
export function settingReport(config, locale = 'en', name) {
  const t = STRINGS[locale] ?? STRINGS.en
  const key = String(name ?? '').toLowerCase()
  let detail
  if (key === 'budget' || key === 'tokenbudget') {
    detail = t.budgetDetail.replace('{{value}}', String(config.costControl.tokenBudgetPerSession))
  } else if (key === 'fallbackchain' || key === 'fallback') {
    const value = config.fallbackChain.length > 0
      ? config.fallbackChain.map(r => `${r.provider}/${r.model}`).join(' → ')
      : '(none)'
    detail = t.fallbackDetail.replace('{{value}}', value)
  } else if (key === 'classifier') {
    detail = t.classifierDetail.replace('{{value}}', String(config.llmClassifier.enabled))
  } else if (key === 'rules') {
    return rulesReport(config, locale)
  } else if (key === '') {
    detail = t.settingUnknown.replace('{{name}}', '(none)')
  } else {
    detail = t.settingUnknown.replace('{{name}}', name)
  }
  return ['<mydsh-auto-model-router-setting>', detail, '</mydsh-auto-model-router-setting>'].join('\n')
}

// ── budget downgrade ─────────────────────────────────────────────────────

/**
 * Build the budget-downgrade notice text.
 * @param {object} config - resolved router config.
 * @param {string} sessionId
 * @param {'zh'|'en'} locale
 * @returns {string}
 */
export function downgradeNotice(config, sessionId, locale = 'en') {
  const t = STRINGS[locale] ?? STRINGS.en
  const cheap = config.levels.L0
    ? `${config.levels.L0.provider}/${config.levels.L0.model}`
    : 'L0 (not configured)'
  const body = t.downgradeBody
    .replaceAll('{{session}}', sessionId)
    .replaceAll('{{budget}}', config.costControl.tokenBudgetPerSession.toLocaleString())
    .replaceAll('{{model}}', cheap)
  return `<mydsh-auto-model-router-downgrade>\n${body}\n</mydsh-auto-model-router-downgrade>`
}

/**
 * Inject a user-visible downgrade notice (downgradeBehavior: notify).
 * @param {object} agent - the live agent.
 * @param {object} config - resolved router config.
 * @param {string} sessionId
 * @param {'zh'|'en'} locale
 * @returns {Promise<boolean>}
 */
export async function notifyDowngrade(agent, config, sessionId, locale = 'en') {
  return injectInto(agent, downgradeNotice(config, sessionId, locale), 'downgrade')
}

/**
 * Ask the user whether to keep the cheap model or continue with the
 * pre-budget model (downgradeBehavior: ask). Returns true when the user
 * wants to keep the original model (caller waives the budget), false when
 * they accept the downgrade or the channel is unavailable.
 *
 * @param {object} ctx - cordis context.
 * @param {object} agent - the live root agent.
 * @param {object} router - the ModelRouter instance.
 * @param {string} sessionId
 * @returns {Promise<boolean>} true = keep original model (waive budget).
 */
export async function askDowngrade(ctx, agent, router, sessionId) {
  const userQuestions = ctx.get?.('userQuestions')
  if (!userQuestions) return false
  const locale = resolveLocale(ctx)
  const t = STRINGS[locale] ?? STRINGS.en
  try {
    const answer = await userQuestions.ask({
      agent,
      questions: [{
        id: 'mydsh-auto-model-router.downgrade',
        header: t.downgradeTitle,
        question: t.downgradeQuestion.replace('{{session}}', sessionId),
        detail: downgradeNotice(router.config, sessionId, locale),
        options: [
          { label: t.downgradeAccept, description: 'Continue with the cheapest level; stays under budget.' },
          { label: t.downgradeKeep, description: 'Ignore the budget for the rest of this session.' },
        ],
      }],
    })
    const selected = answer?.answers?.[0]?.selected?.[0]
    // Default (no answer, aborted) = accept the downgrade.
    return selected === t.downgradeKeep
  } catch {
    // No provider / not live: accept the downgrade silently.
    return false
  }
}

/**
 * Ask the user how to proceed once the heuristic lock is crossed
 * (width > top threshold). Options: pick a fixed level, or enable fully-auto
 * (keyword rules + LLM classifier).
 *
 * @param {object} ctx - cordis context.
 * @param {object} agent - the live root agent.
 * @param {object} router - the ModelRouter instance.
 * @param {string} sessionId
 * @returns {Promise<{kind:'fixed', level:string}|{kind:'auto'}|null>}
 *   null when the channel is unavailable or the user dismissed.
 */
export async function askModeSelection(ctx, agent, router, sessionId) {
  const userQuestions = ctx.get?.('userQuestions')
  if (!userQuestions) return null
  const locale = resolveLocale(ctx)
  const t = STRINGS[locale] ?? STRINGS.en
  try {
    const answer = await userQuestions.ask({
      agent,
      questions: [{
        id: 'mydsh-auto-model-router.mode',
        header: t.askHeader,
        question: t.lockCrossedQuestion,
        options: [
          { label: t.fixedModel, description: t.fixedModelDesc },
          { label: t.enableAuto, description: t.enableAutoDesc },
        ],
      }],
    })
    const selected = answer?.answers?.[0]?.selected?.[0]
    if (selected === t.enableAuto) return { kind: 'auto' }
    if (selected === t.fixedModel) {
      // Second question: which level to pin.
      const levelAnswer = await userQuestions.ask({
        agent,
          questions: [{
          id: 'mydsh-auto-model-router.fixed-level',
          header: t.askHeader,
          question: t.fixedLevelQuestion,
          options: ['L0', 'L1', 'L2', 'L3'].map(level => ({
            label: level,
            description: t.fixedLevelDesc(level, router.config),
          })),
        }],
      })
      const level = levelAnswer?.answers?.[0]?.selected?.[0]
      if (level && ['L0', 'L1', 'L2', 'L3'].includes(level)) {
        return { kind: 'fixed', level }
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Re-elect a fixed level after askEveryInputs inputs in fixed mode.
 * @param {object} ctx
 * @param {object} agent
 * @param {object} router
 * @param {string} sessionId
 * @returns {Promise<string|null>} a LEVEL_IDS entry or null.
 */
export async function askFixedLevel(ctx, agent, router, sessionId) {
  const userQuestions = ctx.get?.('userQuestions')
  if (!userQuestions) return null
  const locale = resolveLocale(ctx)
  const t = STRINGS[locale] ?? STRINGS.en
  try {
    const answer = await userQuestions.ask({
      agent,
      questions: [{
        id: 'mydsh-auto-model-router.fixed-reelect',
        header: t.askHeader,
        question: t.fixedReelectQuestion,
        options: ['L0', 'L1', 'L2', 'L3'].map(level => ({
          label: level,
          description: t.fixedLevelDesc(level, router.config),
        })),
      }],
    })
    const level = answer?.answers?.[0]?.selected?.[0]
    if (level && ['L0', 'L1', 'L2', 'L3'].includes(level)) return level
    return null
  } catch {
    return null
  }
}
