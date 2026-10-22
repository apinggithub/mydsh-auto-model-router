// Host-compatibility layer.
//
// DSH's boot is all-or-nothing: a bundle whose patch throws takes the whole
// host down with it. That makes every direct host-API call in `apply()` a
// compatibility risk — a future DSH that renames or drops one of them would
// not merely lose the router, it would stop the user's Harness from starting.
//
// This module probes the APIs the plugin needs once per mount, classifies the
// host line against the range this revision was exercised on, and provides
// small helpers that degrade to a logged no-op instead of throwing. Nothing
// here imports the host, so it stays unit-testable without cordis.

import { createRequire } from 'node:module'

/** Host lines this revision has actually been run against. */
export const TESTED_HOST_RANGE = '>=0.1.0-0 <0.4.0'
/** Host lines the plugin will still attempt to run on (its peer ceiling). */
export const SUPPORTED_HOST_RANGE = '>=0.1.0-0 <1.0.0'

const NOOP = () => {}

/**
 * Read an optional service without tripping cordis's inject fence.
 *
 * cordis throws on `ctx.someService` when that service is not declared in the
 * plugin's `inject` list ("cannot get property ... without inject"), so an
 * optional dependency must always go through `ctx.get()` and still be guarded
 * for hosts that expose no reflection at all.
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {any}
 */
export function readService(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/** Property read that tolerates cordis's inject fence and exotic hosts. */
function readProperty(ctx, name) {
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * Snapshot the host surface the plugin depends on.
 *
 * Every entry is a plain boolean so it can be serialized into the status
 * endpoint and used by tests without a live host.
 *
 * @param {object} ctx - the cordis context handed to `apply()`.
 * @returns {{
 *   llm: boolean, registerAdapter: boolean, listModels: boolean,
 *   stream: boolean, scopedInject: boolean, webServer: boolean,
 *   tokenMeter: boolean, provide: boolean,
 * }}
 */
export function probeHost(ctx) {
  const llm = readProperty(ctx, 'llm') ?? readService(ctx, 'llm')
  const webServer = readService(ctx, 'webServer')
  const tokenMeter = readService(ctx, 'tokenMeter')
  return {
    llm: Boolean(llm),
    registerAdapter: typeof llm?.registerAdapter === 'function',
    listModels: typeof llm?.listModels === 'function',
    stream: typeof llm?.stream === 'function',
    scopedInject: typeof readProperty(ctx, 'inject') === 'function',
    webServer: typeof webServer?.register === 'function',
    tokenMeter: Boolean(tokenMeter),
    provide: typeof readProperty(ctx, 'provide') === 'function',
  }
}

/**
 * Register an HTTP route on a webserver-like service, tolerating a renamed
 * registration method.
 *
 * `register(route)` is the 0.1–0.3 shape; `route(route)` is accepted as a
 * forward-compatible alias. When neither exists the call is a no-op: the
 * settings page will show its "no report yet" state, which is strictly better
 * than refusing to mount.
 *
 * @param {object} scope - a context exposing `webServer` (and usually `effect`).
 * @param {{ kind: string, path: string, handler: Function }} route
 * @returns {() => void} disposer
 */
export function registerRoute(scope, route) {
  const server = scope?.webServer
  if (server === undefined || server === null) return NOOP
  for (const method of ['register', 'route', 'addRoute']) {
    if (typeof server[method] !== 'function') continue
    try {
      const dispose = server[method](route)
      return typeof dispose === 'function' ? dispose : NOOP
    } catch (error) {
      // A duplicate path throws in the current host. That is a composition
      // problem worth failing soft on, not a reason to abort the mount.
      scope?.logger?.warn?.(
        `[mydsh-auto-model-router] could not claim ${route.path} via webServer.${method}: ${error?.message ?? error}`,
      )
      return NOOP
    }
  }
  return NOOP
}

/** Per-context dedupe for warnings that would otherwise repeat per session. */
const warned = new WeakMap()

/**
 * Log a warning at most once per context and key.
 *
 * @param {object} ctx - cordis context (used for the logger and the dedupe key).
 * @param {string} key - stable identifier for the message.
 * @param {string} message - human-readable text (the plugin prefix is added).
 */
export function warnOnce(ctx, key, message) {
  try {
    if (ctx !== null && typeof ctx === 'object') {
      let keys = warned.get(ctx)
      if (keys === undefined) {
        keys = new Set()
        warned.set(ctx, keys)
      }
      if (keys.has(key)) return
      keys.add(key)
    }
    ctx?.logger?.warn?.(`[mydsh-auto-model-router] ${message}`)
  } catch {
    // Logging must never be the thing that breaks a mount.
  }
}

/**
 * Version of the running `@deepseek-ai/dsh` package, when it is resolvable.
 *
 * DSH installs the runtime resolution that lets a profile plugin import the
 * packages carried by the installation, so this usually works inside the host
 * and throws (quietly) everywhere else — which is exactly what a best-effort
 * probe wants.
 *
 * @returns {string | undefined}
 */
function installVersion() {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh/package.json')
    if (typeof manifest?.version === 'string' && manifest.version !== '') return manifest.version
  } catch {
    // Not launched by the harness, or the package does not export its manifest.
  }
  return undefined
}

/**
 * Best-effort host version, read from the places a host may expose it.
 *
 * @param {object} ctx - cordis context.
 * @param {Record<string, string | undefined>} [env] - defaults to `process.env`.
 * @returns {string | undefined}
 */
export function readHostVersion(ctx, env = globalThis.process?.env) {
  const app = readService(ctx, 'app')
  const candidates = [
    app?.version,
    readProperty(ctx, 'cmdlineArgs')?.version,
    readService(ctx, 'cmdlineArgs')?.version,
    env?.DSH_VERSION,
    env?.npm_package_version,
    installVersion(),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * Classify a host version against the range this revision was tested on.
 *
 * @param {string | undefined} version
 * @returns {'tested' | 'untested' | 'unknown'}
 */
export function classifyHostVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (match === null) return 'unknown'
  const major = Number(match[1])
  const minor = Number(match[2])
  // DSH is pre-1.0: every 0.x minor may break. 0.1–0.3 are the exercised
  // lines; 0.4+ and 1.x+ are allowed to mount but reported as untested.
  if (major === 0 && minor <= 3) return 'tested'
  return 'untested'
}
