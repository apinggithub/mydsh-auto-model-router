window.__ModuleLoader__.load({
	id: "@apinggithub/dsh-tier-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var _react = require("react");
		//#region client/section.mjs
		const PLUGIN_ID = '@apinggithub/dsh-tier-cost'
const NS = 'dsh-tier-cost'
const ENDPOINT = '/api/tier-cost/usage'

const ORDER = ['L0', 'L1', 'L2', 'L3', 'free', 'manual', 'unknown']

const EN_COPY = {
  nav: 'Tier Cost',
  title: 'Cost by routing level',
  description: 'Token usage and cost folded from session logs, attributed to the level the auto router dispatched.',
  loading: 'Loading…',
  failed: 'Could not read /api/tier-cost/usage.',
  empty: 'No routed turns found yet. Send a message with Auto selected first.',
  col: { level: 'Level', calls: 'Calls', input: 'Input', output: 'Output', cache: 'Cache r/w', cost: 'Cost' },
  total: 'Total',
  partial: 'Some turns could not be priced (the billing plugin had no rate for them) — tokens are still counted.',
  noCost: 'Cost columns are empty: install @kenz1117/dsh-ui-usage-billing to price these turns.',
  turns: (turns, logs) => `${turns} turns across ${logs} session logs · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
}

const ZH_COPY = {
  nav: '档位花费',
  title: '按路由档位的花费',
  description: '从会话日志折叠出的 token 用量与费用，按 Auto 路由实际派发的档位归集。',
  loading: '加载中…',
  failed: '无法读取 /api/tier-cost/usage。',
  empty: '还没有可归集的调用。先在选择器里选 Auto 发一条消息。',
  col: { level: '档位', calls: '调用', input: '输入', output: '输出', cache: '缓存读/写', cost: '费用' },
  total: '合计',
  partial: '有部分轮次缺少单价（计费插件没有该模型的价格），token 仍照常统计。',
  noCost: '费用列为空：装上 @kenz1117/dsh-ui-usage-billing 才能折算金额。',
  turns: (turns, logs) => `共 ${turns} 轮 / ${logs} 个会话日志 · 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
}

const copy = () => {
  const lang = document.documentElement.lang || navigator.language || ''
  return /^zh(?:-|$)/i.test(lang) ? ZH_COPY : EN_COPY
}

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
const int = (value) => n(value).toLocaleString()
const cny = (value) => `¥${n(value).toFixed(4)}`

function TierCostSection() {
  const t = copy()
  const styles = {
    section: { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '14px', lineHeight: '22px' },
    title: { margin: 0, fontSize: '16px', fontWeight: 600 },
    description: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)' },
    meta: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)', fontSize: '12px' },
    table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
    th: { textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))', fontWeight: 600 },
    thFirst: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))', fontWeight: 600 },
    td: { textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))' },
    tdFirst: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))' },
    note: { margin: 0, padding: '10px 12px', borderLeft: '3px solid var(--dsw-alias-state-info-primary, #2b7fff)', background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03))' },
    mono: { font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  }
  const h = (tag, props, ...children) => _react.createElement(tag, props ?? {}, ...children)

  const [state, setState] = _react.useState({ phase: 'loading', data: null })
  _react.useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch(ENDPOINT, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => { if (!cancelled) setState({ phase: data?.ok ? 'ready' : 'failed', data }) })
        .catch(() => { if (!cancelled) setState({ phase: 'failed', data: null }) })
    }
    load()
    return () => { cancelled = true }
  }, [])

  const rows = []
  const data = state.data
  if (data?.levels) {
    for (const id of ORDER) {
      const bucket = data.levels[id]
      if (bucket === undefined) continue
      rows.push(h('tr', { key: id },
        h('td', { style: styles.tdFirst },
          h('div', null, `${id}  ${data.levelLabels?.[id] ?? ''}`)),
        h('td', { style: styles.td }, int(bucket.calls)),
        h('td', { style: styles.td }, int(bucket.input)),
        h('td', { style: styles.td }, int(bucket.output)),
        h('td', { style: styles.td }, `${int(bucket.cacheRead)} / ${int(bucket.cacheWrite)}`),
        h('td', { style: styles.td }, cny(bucket.cost)),
      ))
    }
  }

  const body = state.phase === 'loading'
    ? h('p', { style: styles.meta }, t.loading)
    : state.phase === 'failed'
      ? h('p', { style: styles.meta }, t.failed)
      : rows.length === 0
        ? h('p', { style: styles.meta }, t.empty)
        : h('table', { style: styles.table },
            h('thead', null, h('tr', null,
              h('th', { style: styles.thFirst }, t.col.level),
              h('th', { style: styles.th }, t.col.calls),
              h('th', { style: styles.th }, t.col.input),
              h('th', { style: styles.th }, t.col.output),
              h('th', { style: styles.th }, t.col.cache),
              h('th', { style: styles.th }, t.col.cost),
            )),
            h('tbody', null,
              rows,
              h('tr', { key: '__total' },
                h('td', { style: styles.tdFirst }, h('strong', null, t.total)),
                h('td', { style: styles.td }, int(data?.totals?.calls)),
                h('td', { style: styles.td }, int(data?.totals?.input)),
                h('td', { style: styles.td }, int(data?.totals?.output)),
                h('td', { style: styles.td }, `${int(data?.totals?.cacheRead)} / ${int(data?.totals?.cacheWrite)}`),
                h('td', { style: styles.td }, cny(data?.totals?.cost)),
              ),
            ))

  const notes = []
  if (state.phase === 'ready') {
    notes.push(h('p', { key: 'meta', style: styles.meta }, t.turns(data?.turns ?? 0, data?.sessionLogs ?? 0)))
    if (data?.costPartial) notes.push(h('p', { key: 'partial', style: styles.note }, t.partial))
    if (!data?.costPriced) notes.push(h('p', { key: 'nocost', style: styles.note }, t.noCost))
    for (const note of data?.notes ?? []) notes.push(h('p', { key: note, style: styles.mono }, note))
  }

  return h('div', { style: styles.section },
    h('h3', { style: styles.title }, t.title),
    h('p', { style: styles.description }, t.description),
    body,
    ...notes,
  )
}

const name = PLUGIN_ID
const inject = ['slots', 'locale']

function apply(ctx) {
  const t = () => copy()
  ctx.effect(() => {
    return ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'tier-cost',
      order: 61,
      label: () => t().nav,
      locale: NS,
    }, TierCostSection))
  }, 'dsh-tier-cost: settings section')
}
		//#endregion
		module.exports = { name, inject, apply };
		return module.exports;
	}
});
