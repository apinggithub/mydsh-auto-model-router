// mydsh-auto-model-router plugin entry. Registers the routing layers onto the
// DSH agent lifecycle:
//
//   agent/pre-step          → token accounting + user-input boundary detection
//   system-prompt/assemble  → keep {{model}} consistent with routing
//   agent/request           → reuse the per-input decision (no re-judging per step)
//   agent/request-error     → fallback chain (retry with next route)
//   session/event           → token spend tracking
//   agent/session-start     → per-session state reset + one-time status
//                             report & cost-mode question (no client UI)
//
// A NEW user input is detected when the last user message's text changes
// between requests. Only then does the router make a fresh decision (heuristic
// lock / fixed model / fully-auto). All agent/request steps within the same
// user input reuse that decision — the LLM classifier is never called per step.
//
// The plugin also registers a virtual `auto` provider adapter so the model
// selector shows an "Auto Router" entry. When the user picks Auto, this
// plugin routes the session; any real provider/model picked by the user passes
// through untouched.

import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'
import { AutoAdapter, isAutoSelection } from './auto-adapter.mjs'
import {
  reportStatus, persistStatusReport, statusReport, notifyDowngrade,
  askDowngrade, resolveLocale, askModeSelection, askFixedLevel,
} from './notify.mjs'

export const name = 'mydsh-auto-model-router'
export const inject = ['agents', 'sessions', 'tools', 'llm', 'tokenMeter']

export function apply(ctx, input = {}) {
  const config = resolveConfig(input)
  const router = new ModelRouter(config, {
    llm: ctx.llm,
    tokenMeter: ctx.tokenMeter,
  })
  ctx.provide('modelRouter', router)
  // Global backstop so the virtual auto adapter can forward a request that
  // reaches it without an agent/request interception.
  globalThis.__dshAutoModelRouter = router
  globalThis.__dshLl = ctx.llm
  ctx.effect(
    () => () => {
      router.cost.reset()
      delete globalThis.__dshAutoModelRouter
      delete globalThis.__dshLl
    },
    'modelRouter.reset()',
  )

  // Register the virtual "auto" provider so the model selector shows it.
  const autoRegistration = ctx.llm?.registerAdapter?.(
    ['auto'],
    AutoAdapter,
  )
  ctx.effect(
    () => () => autoRegistration?.(),
    'modelRouter.unregisterAutoAdapter()',
  )

  // ── HTTP status endpoint for the browser settings section ─────────────
  // The client fetch()es /api/mydsh-auto-model-router/status to render the
  // current routing policy (no localStorage / DOM-transcript dependency).
  // Uses ctx.get('webServer') so deployments without the webserver degrade
  // to settings-section "no report" instead of failing activation.
  ctx.effect(() => {
    const webServer = ctx.get?.('webServer')
    if (webServer?.register === undefined) return
    const dispose = webServer.register({
      kind: 'exact',
      path: '/api/mydsh-auto-model-router/status',
      handler: (_req, res) => {
        const body = JSON.stringify({
          ok: true,
          report: statusReport(config, resolveLocale(ctx)),
          levels: config.levels,
          costControl: config.costControl,
          rules: config.rules,
          scoring: config.scoring,
          fallbackChain: config.fallbackChain,
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(body)
      },
    })
    return dispose
  }, 'modelRouter.statusEndpoint()')

  // ── session start: fresh routing state per session ─────────────────────
  // Injects the status report into the session (visible, non-blocking) but
  // never pops a dialog — configuration changes are guided through the
  // Auto Router settings section instead.
  ctx.on('agent/session-start', async ({ agent }) => {
    router.resetSession(agent.session.id)
    if (agent.status === 'idle') {
      const locale = resolveLocale(ctx)
      persistStatusReport(config, locale)
      await reportStatus(agent, config, locale)
    }
    return true
  })

  // ── pre-step: token accounting + cache the latest user input ──────────
  // The latest user message text changes only here (a new user input); every
  // subsequent agent/request step of the SAME input reuses this cached text,
  // so we never re-scan the full derived message history per step.
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    const last = messages.at(-1)
    if (last) router.recordTokens(agent.session.id, last)
    // Cache the latest user text ONLY when the newest message is a user
    // message — that is the event that opens a new user input.
    if (last?.role === 'user') {
      const text = messageText(last)
      if (text !== '') router.rememberInput(agent.session.id, text)
    }
    return decision
  })

  // ── prompt assembly: keep {{model}} consistent with the routed model ────
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    const sessionId = assembly.variables?.sessionId
    if (!sessionId) return assembled
    if (!router.isAutoActive(sessionId)) return assembled
    const route = router.current(sessionId)
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: route.provider,
        model: route.model,
      },
    }
  })

  // ── ★ agent/request: reuse the per-input decision ──────────────────────
  // Only a NEW user input triggers a fresh decision (and only when the
  // session picked the virtual auto provider). Steps within the same input
  // reuse state.current — no per-step re-judging, no per-step classifier.
  ctx.on('agent/request', async ({ agent }, next) => {
    const proposed = await next()
    const sessionId = agent.session.id
    ctx.logger?.info?.(
      `[mydsh-auto-model-router] agent/request session=${sessionId} proposed=${proposed?.provider}/${proposed?.model} isAuto=${isAutoSelection(proposed)}`,
    )
    if (!isAutoSelection(proposed)) {
      router.markAutoInactive(sessionId)
      return proposed
    }
    router.markAutoActive(sessionId)

    // Use the cached latest user input (set in agent/pre-step) — do NOT
    // re-scan the full derived message history on every step.
    const input = router.currentInput(sessionId) ?? ''
    const decision = await router.decideOnInput(sessionId, {
      inputText: input,
      prevInputText: router.lastInputText(sessionId) ?? '',
      lastReplyText: router.lastReplyText(sessionId) ?? '',
    })

    if (decision?.needsAsk) {
      const locale = resolveLocale(ctx)
      if (decision.needsAsk === 'above-lock') {
        // Ask: 固定模型 or 开启全自动.
        const picked = await askModeSelection(ctx, agent, router, sessionId)
        if (picked?.kind === 'fixed') {
          router.setMode(sessionId, 'fixed', { fixedLevel: picked.level })
        } else if (picked?.kind === 'auto') {
          router.setMode(sessionId, 'auto')
        }
        // fallback: user dismissed → stay in heuristic mode.
        const route = router.current(sessionId)
        return { ...proposed, provider: route.provider, model: route.model,
          ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort } }
      }
      if (decision.needsAsk === 'fixed-reelect') {
        const picked = await askFixedLevel(ctx, agent, router, sessionId)
        if (picked) router.setMode(sessionId, 'fixed', { fixedLevel: picked })
        const route = router.current(sessionId)
        return { ...proposed, provider: route.provider, model: route.model,
          ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort } }
      }
    }

    const route = router.current(sessionId)
    const downgraded = router.consumeDowngradeFlag(sessionId)
    if (downgraded) {
      const behavior = config.costControl.downgradeBehavior
      const locale = resolveLocale(ctx)
      if (behavior === 'notify') {
        await notifyDowngrade(agent, config, sessionId, locale)
      } else if (behavior === 'ask') {
        const keep = await askDowngrade(ctx, agent, router, sessionId)
        if (keep) router.waiveBudget(sessionId)
      }
    }
    return {
      ...proposed,
      provider: route.provider,
      model: route.model,
      // Levels always carry an explicit reasoningEffort (default 'off'), so
      // the routed effort is always stated — including 'off' for no thinking.
      reasoningEffort: route.reasoningEffort,
    }
  })

  // ── agent/request-error: fallback chain (auto mode only) ────────────────
  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    const sessionId = agent.session.id
    if (!router.isAutoActive(sessionId)) return next()
    const failedRoute = router.current(sessionId)
    const fallback = router.nextOnFailure(sessionId, failedRoute)
    if (fallback) {
      ctx.logger?.info?.(
        `[mydsh-auto-model-router] ${sessionId}: request failed (${failure?.error?.code ?? 'unknown'}), falling back to ${fallback.provider}/${fallback.model}`,
      )
      return { kind: 'retry' }
    }
    return next()
  })

  // ── session/event: track spend from assistant messages ──────────────────
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      router.recordTokens(session.id, event.data?.message)
    }
    if (event.type === 'message') {
      const message = event.data?.message
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content
          .map((block) => (typeof block?.text === 'string' ? block.text : ''))
          .join('\n')
        if (text) router.rememberReply(session.id, text)
      }
    }
  })
}

/** Extract the text content of a single message. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n')
      .trim()
  }
  return ''
}
