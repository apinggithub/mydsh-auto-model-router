window.__ModuleLoader__.load({
	id: "@apinggithub/mydsh-auto-model-router",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var _react = require("react");
		//#region client/gate.mjs
		const PLUGIN_ID = '@apinggithub/mydsh-auto-model-router'
const NS = 'mydsh-auto-model-router'

const EN_COPY = {
  nav: 'Auto Router',
  title: 'Auto Model Router',
  description: 'Routes each user input through the configured L0–L3 levels.',
  hintTitle: 'How to change this configuration',
  hintBody: 'Tell the AI in conversation, e.g. "change L2 to deepseek-v4-pro with '
    + 'max reasoning" or "switch cost mode to cost-first". The AI edits '
    + 'cordis.patch.yml; restart DSH to apply.',
  noReport: 'No router status report found yet. Send a message in a session '
    + 'first — the host injects the current policy on session start.',
  reportLabel: 'Current policy',
}

const ZH_COPY = {
  nav: 'Auto Router',
  title: 'Auto 模型路由',
  description: '按配置的 L0–L3 层级，为每次用户输入自动选择模型。',
  hintTitle: '如何修改配置',
  hintBody: '直接在对话中告诉 AI，例如："把 L2 改成 deepseek-v4-pro 且 max 思考"'
    + '或"成本模式切换为 cost-first"。AI 会帮你编辑 cordis.patch.yml，'
    + '重启 DSH 后生效。',
  noReport: '尚未找到路由状态报告。先在会话中发一条消息——host 会在'
    + '会话开始时注入当前策略。',
  reportLabel: '当前策略',
}

const copy = () => {
  const lang = document.documentElement.lang || navigator.language || ''
  return /^zh(?:-|$)/i.test(lang) ? ZH_COPY : EN_COPY
}

const STATUS_ENDPOINT = '/api/mydsh-auto-model-router/status'

/**
 * The settings section component. Rendered with _react.createElement from the
 * module-table react entry; no JSX build step. Fetches the current policy
 * from the host HTTP endpoint on mount.
 */
function RouterSection() {
  const t = copy()
  const styles = {
    section: {
      display: 'flex', flexDirection: 'column', gap: '16px',
      fontSize: '14px', lineHeight: '22px',
    },
    title: { margin: 0, fontSize: '16px', fontWeight: 600 },
    description: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)' },
    block: {
      margin: 0, padding: '12px 14px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
      borderRadius: '12px',
      background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03))',
      font: '12px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    },
    hint: {
      margin: 0, padding: '10px 12px',
      borderLeft: '3px solid var(--dsw-alias-state-info-primary, #2b7fff)',
      background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03))',
    },
    hintTitle: { margin: '0 0 4px', fontWeight: 600 },
    hintBody: { margin: 0 },
  }
  const h = (tag, props, ...children) => _react.createElement(tag, props ?? {}, ...children)

  const [report, setReport] = _react.useState(null)
  _react.useEffect(() => {
    let cancelled = false
    fetch(STATUS_ENDPOINT, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || data?.report === undefined) return
        setReport(data.report)
      })
      .catch(() => { /* offline / no host route: keep "no report" */ })
    return () => { cancelled = true }
  }, [])

  return h('div', { style: styles.section },
    h('h3', { style: styles.title }, t.title),
    h('p', { style: styles.description }, t.description),
    h('p', { style: styles.block },
      report === null ? t.noReport : `【${t.reportLabel}】\n${report}`),
    h('div', { style: styles.hint },
      h('p', { style: styles.hintTitle }, t.hintTitle),
      h('p', { style: styles.hintBody }, t.hintBody)),
  )
}

const name = PLUGIN_ID
const inject = ['slots', 'locale']

function apply(ctx) {
  const t = () => copy()
  ctx.effect(() => {
    return ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'auto-router',
      order: 60,
      label: () => t().nav,
      locale: NS,
    }, RouterSection))
  }, 'mydsh-auto-model-router: settings section')
}
		//#endregion
		//#region client/index.mjs
		
		//#endregion
		module.exports = { name, inject, apply };
		return module.exports;
	}
});
