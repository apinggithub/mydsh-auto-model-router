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
//
// Compatibility posture: a profile's plugin tree is one composition — a bundle
// whose patch fails can keep the host from starting, and an entry that throws
// is reported as "did not activate" and silently loses the router. Every host
// API is therefore probed (see compat.mjs), every per-request path is wrapped
// so a hostile payload passes the host's proposal through untouched, and the
// whole plugin mounts in a degraded, logged mode on a host whose surface moved.

import { resolveConfig } from './config.mjs'
import { ModelRouter } from './router.mjs'
import { createAutoAdapter, isAutoSelection } from './auto-adapter.mjs'
import {
  reportStatus, persistStatusReport, statusReport, notifyDowngrade,
  askDowngrade, resolveLocale, askModeSelection, askFixedLevel,
  notifyFreeQuotaFallback,
} from './notify.mjs'
import {
  TESTED_HOST_RANGE, classifyHostVersion, probeHost, readHostVersion,
  readService, registerRoute, warnOnce,
} from './compat.mjs'

export const name = 'mydsh-auto-model-router'

// `tokenMeter` is deliberately not injected: it only feeds token estimation,
// and a hard dependency would turn a future rename into a failed mount. It is
// looked up softly instead (ctx.tokenMeter ?? ctx.get('tokenMeter')).
export const inject = ['agents', 'sessions', 'tools', 'llm']

/** Session id from either the agent or a bare session-shaped object. */
function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.sessionId
}

/**
 * Accept both the current `{ agent }` payload and a future bare-agent payload.
 * @param {object} payload
 * @returns {object | undefined}
 */
function agentOf(payload) {
  return payload?.agent ?? payload
}

/**
 * Accept both `(session, event)` and a single `{ session, event }` payload.
 * @param {object} first
 * @param {object} second
 * @returns {{ session: object | undefined, event: object | undefined }}
 */
function normalizeSessionEvent(first, second) {
  if (second !== undefined) return { session: first, event: second }
  if (first !== null && typeof first === 'object' && first.event !== undefined && first.session !== undefined) {
    return { session: first.session, event: first.event }
  }
  return { session: first, event: second }
}

export function apply(ctx, input = {}) {
  const config = resolveConfig(input)
  const compat = probeHost(ctx)
  // Never `ctx.tokenMeter`: cordis throws on a service property that is not in
  // `inject`, and tokenMeter is deliberately soft (see the comment on inject).
  const tokenMeter = readService(ctx, 'tokenMeter')
  const router = new ModelRouter(config, {
    llm: ctx.llm,
    tokenMeter,
  })

  if (compat.provide) ctx.provide('modelRouter', router)

  const warn = (key, message) => warnOnce(ctx, key, message)
  const hostVersion = readHostVersion(ctx)
  if (classifyHostVersion(hostVersion) === 'untested') {
    warn(
      'host-version',
      `host ${hostVersion} is outside the exercised range ${TESTED_HOST_RANGE}; `
      + 'the plugin mounts, but an API it relies on may have moved. Report a broken '
      + 'route with the plugin version and the host version.',
    )
  }

  ctx.effect?.(
    () => () => {
      router.cost.reset()
    },
    'modelRouter.reset()',
  )

  // Register the virtual "auto" provider so the model selector shows it.
  let autoRegistration
  if (compat.registerAdapter) {
    autoRegistration = ctx.llm.registerAdapter(
      ['auto'],
      createAutoAdapter({ router: () => router, llm: () => ctx.llm }),
    )
  } else {
    warn(
      'registerAdapter',
      'the host exposes no llm.registerAdapter(); the "Auto" model will not appear '
      + 'in the model picker. Routing still applies to sessions already on provider "auto".',
    )
  }
  ctx.effect?.(
    () => () => autoRegistration?.(),
    'modelRouter.unregisterAutoAdapter()',
  )

  // ── catalog freshness: read provider catalogs at activation, then poll ──
  // A retired model id makes its level stale; the router then drifts around it
  // and the status report names same-family candidates for the one-line fix.
  ctx.effect?.(() => {
    if (!compat.listModels) return undefined
    void router.refreshCatalogs()
    const timer = setInterval(() => void router.refreshCatalogs(), config.modelsGuard.refreshMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'modelRouter.catalogWatch()')

  // ── HTTP status endpoint for the browser settings section ─────────────
  // The client fetch()es /api/mydsh-auto-model-router/status to render the
  // current routing policy (no localStorage / DOM-transcript dependency).
  //
  // The webserver is claimed through a *scoped injection* instead of a hard
  // `inject` entry: headless deployments have no webserver and must still
  // route. A plain `ctx.get('webServer')` is not enough — at boot the service
  // is not up yet, so the lookup returns nothing, the registration is skipped,
  // and the exact route is never claimed (requests then fall through to the
  // `/api` prefix owner and answer 401). `ctx.inject` runs the callback when —
  // and only when — the service exists.
  const statusRoute = {
    kind: 'exact',
    path: '/api/mydsh-auto-model-router/status',
    handler: (_req, res) => {
      const body = JSON.stringify({
        ok: true,
        version: config.pluginVersion,
        report: statusReport(config, resolveLocale(ctx), { stale: router.staleLevels() }),
        levels: config.levels,
        costControl: config.costControl,
        freeQuota: config.freeQuota,
        contextGuard: config.contextGuard,
        modelsGuard: config.modelsGuard,
        staleLevels: router.staleLevels(),
        rules: config.rules,
        scoring: config.scoring,
        fallbackChain: config.fallbackChain,
        host: {
          version: hostVersion ?? null,
          // Live probe: unlike the mount-time snapshot this sees the webserver,
          // which is only up after the composition finished.
          compat: probeHost(ctx),
          mount: compat,
          testedRange: TESTED_HOST_RANGE,
        },
      })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(body)
    },
  }
  const registerStatusRoute = (scope) => {
    if (typeof scope?.effect !== 'function') {
      registerRoute(scope, statusRoute)
      return
    }
    scope.effect(
      () => registerRoute(scope, statusRoute),
      'modelRouter.statusEndpoint()',
    )
  }
  if (compat.scopedInject) {
    ctx.inject(['webServer'], registerStatusRoute)
  } else {
    // Fallback for contexts without scoped injection (tests, older hosts).
    const webServer = readService(ctx, 'webServer')
    if (webServer !== undefined && webServer !== null) {
      registerStatusRoute({ effect: (fn) => fn(), webServer })
    }
  }

  // ── session start: fresh routing state per session ─────────────────────
  // Injects the status report into the session (visible, non-blocking) but
  // never pops a dialog — configuration changes are guided through the
  // Auto Router settings section instead.
  ctx.on('agent/session-start', async (payload) => {
    const agent = agentOf(payload)
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return true
    try {
      router.resetSession(sessionId)
      if (agent.status === 'idle') {
        const locale = resolveLocale(ctx)
        persistStatusReport(config, locale)
        await reportStatus(agent, config, locale)
      }
    } catch (error) {
      warn('session-start', `session start bookkeeping failed for ${sessionId}: ${error?.message ?? error}`)
    }
    return true
  })

  // ── pre-step: token accounting + cache the latest user input ──────────
  // The latest user message text changes only here (a new user input); every
  // subsequent agent/request step of the SAME input reuses this cached text,
  // so we never re-scan the full derived message history per step.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || payload?.signal?.aborted) return decision
      const sessionId = sessionIdOf(agentOf(payload))
      if (sessionId === undefined) return decision
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      const last = messages.at(-1)
      if (last) router.recordTokens(sessionId, last)
      // Cache the latest user text ONLY when the newest message is a user
      // message — that is the event that opens a new user input.
      if (last?.role === 'user') {
        const text = messageText(last)
        if (text !== '') router.rememberInput(sessionId, text)
      }
      return decision
    } catch (error) {
      warn('pre-step', `pre-step bookkeeping failed: ${error?.message ?? error}`)
      return decision
    }
  })

  // ── prompt assembly: keep {{model}} consistent with the routed model ────
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    try {
      const sessionId = assembly?.variables?.sessionId
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
    } catch (error) {
      warn('assemble', `prompt assembly override skipped: ${error?.message ?? error}`)
      return assembled
    }
  })

  // ── ★ agent/request: reuse the per-input decision ──────────────────────
  // Only a NEW user input triggers a fresh decision (and only when the
  // session picked the virtual auto provider). Steps within the same input
  // reuse state.current — no per-step re-judging, no per-step classifier.
  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    const sessionId = sessionIdOf(agentOf(payload))
    try {
      ctx.logger?.info?.(
        `[mydsh-auto-model-router] agent/request session=${sessionId} proposed=${proposed?.provider}/${proposed?.model} isAuto=${isAutoSelection(proposed)}`,
      )
      if (sessionId === undefined) return proposed
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
          const picked = await askModeSelection(ctx, agentOf(payload), router, sessionId)
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
          const picked = await askFixedLevel(ctx, agentOf(payload), router, sessionId)
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
          await notifyDowngrade(agentOf(payload), config, sessionId, locale)
        } else if (behavior === 'ask') {
          const keep = await askDowngrade(ctx, agentOf(payload), router, sessionId)
          if (keep) router.waiveBudget(sessionId)
        }
      }
      // A free route that burned its quota earlier in this session was replaced
      // by a paid one while routing — tell the user once.
      const demotion = router.consumeFreeDemotionFlag(sessionId)
      if (demotion && config.freeQuota.notify) {
        await notifyFreeQuotaFallback(agentOf(payload), sessionId, demotion, resolveLocale(ctx))
      }
      return {
        ...proposed,
        provider: route.provider,
        model: route.model,
        // Levels always carry an explicit reasoningEffort (default 'off'), so
        // the routed effort is always stated — including 'off' for no thinking.
        reasoningEffort: route.reasoningEffort,
      }
    } catch (error) {
      // The router must never be able to fail a user request: hand the host's
      // own proposal back untouched and surface the reason once.
      ctx.logger?.warn?.(
        `[mydsh-auto-model-router] routing failed for ${sessionId ?? 'unknown session'}; `
        + `passing the host proposal through: ${error?.message ?? error}`,
      )
      return proposed
    }
  })

  // ── agent/request-error: fallback chain (auto mode only) ────────────────
  // A free-quota route that fails (quota exhausted, rate limited, rejected) is
  // demoted for the rest of the session: the retry runs on the next viable
  // route, and every later decision for that level skips the burned route.
  ctx.on('agent/request-error', async (payload, next) => {
    let retry = false
    try {
      const sessionId = sessionIdOf(agentOf(payload))
      if (sessionId !== undefined && router.isAutoActive(sessionId)) {
        const failedRoute = router.current(sessionId)
        const burned = config.freeQuota.enabled && config.freeQuota.demoteOnError
          ? router.markFreeExhausted(sessionId, failedRoute)
          : false
        const fallback = router.nextOnFailure(sessionId, failedRoute)
        if (fallback) {
          ctx.logger?.info?.(
            `[mydsh-auto-model-router] ${sessionId}: request failed (${payload?.failure?.error?.code ?? 'unknown'})`
            + `${burned ? ' on a free route, which is now demoted for this session' : ''},`
            + ` falling back to ${fallback.provider}/${fallback.model}`,
          )
          // The user-visible notice is owned by the routing path, which knows
          // the level and the paid replacement: announcing it here too would
          // report the same demotion twice.
          retry = true
        }
      }
    } catch (error) {
      warn('request-error', `fallback handling failed: ${error?.message ?? error}`)
    }
    return retry ? { kind: 'retry' } : next()
  })

  // ── session/event: track spend from assistant messages ──────────────────
  ctx.on('session/event', (first, second) => {
    const { session, event } = normalizeSessionEvent(first, second)
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined || event === undefined) return
    try {
      if (event.type === 'assistant/message') {
        router.recordTokens(sessionId, event.data?.message)
        // The input side of the request that produced this message is the best
        // context-size signal the context guard has.
        router.recordUsage(sessionId, event.data?.usage)
      }
      if (event.type === 'message') {
        const message = event.data?.message
        if (message?.role === 'assistant' && Array.isArray(message.content)) {
          const text = message.content
            .map((block) => (typeof block?.text === 'string' ? block.text : ''))
            .join('\n')
          if (text) router.rememberReply(sessionId, text)
        }
      }
    } catch (error) {
      warn('session-event', `session event handling failed: ${error?.message ?? error}`)
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
