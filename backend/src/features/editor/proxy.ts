// The same-origin HTTP + WebSocket proxy in front of one session's own
// code-server, reached over the unix socket container.ts/lifecycle.ts starts
// it listening on — see /tmp/agentoo-editor/design.md's "Proxy spec" and
// "Browser reach" sections, which this implements step for step.
//
// Raw `.all()` routes on their own OpenAPIHono router, exactly like docker's
// SSE routes (features/docker/routes.ts): a reverse proxy is neither a JSON
// request nor a JSON response, so it has no business in the generated client
// or `backend/openapi.json`. A separate router from `editorRouter`
// (features/editor/routes.ts), not more routes bolted onto it, is what keeps
// that router's own OpenAPI surface (three JSON routes) untouched by this one.
//
// The one thing every route below shares: the upstream socket path is ALWAYS
// derived server-side from a freshly (or recently cached) resolved
// `resolveDockerScope(projectId, sessionId)` call — never from anything the
// client sends. A client only ever supplies the two path ids and whatever
// comes after `/proxy/`; nothing on this path can steer which socket gets
// dialed, which is what keeps a stale cache entry (see `socketPathCache`
// below) merely dead rather than cross-session.

import { OpenAPIHono, z } from '@hono/zod-openapi'
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import type { Context } from 'hono'
import { editorEnabled } from '@/env'
import { resolveDockerScope } from '@/features/docker/scope'
import {
  AppError,
  badGateway,
  errorBody,
  forbidden,
  issuesFor,
  validationFailed,
} from '@/lib/errors'
import { logger } from '@/lib/logger'
import { editorSocketPath } from '@/lib/paths'

/** The iframe `src` — also the prefix every proxied request/upgrade under it
 * gets stripped of below. Exported for service.ts (see that module's own
 * comment on why `getEditorStatus` builds `proxyPath` from this rather than
 * a second, hand-rolled copy of the same string). */
export function editorProxyPath(projectId: string, sessionId: string): string {
  return `/api/projects/${projectId}/sessions/${sessionId}/editor/proxy/`
}

/** The launcher page a dead-editor page reload is sent back to (see
 * `isDocumentNavigation`/`proxyHttp` below) — must match the frontend route
 * in frontend/src/app/router.tsx (`sessionEditorRoute`,
 * `/projects/$projectId/sessions/$sessionId/editor`). That page starts the
 * editor if it is not already running, then replaces its own location with
 * `editorProxyPath`, so redirecting a stale tab here is what lets it recover
 * on reload instead of dead-ending on a JSON error body. */
export function editorLauncherPath(projectId: string, sessionId: string): string {
  return `/projects/${projectId}/sessions/${sessionId}/editor`
}

export const editorProxyRouter = new OpenAPIHono()

// Same reason dockerRouter/editorRouter each give their own: lets this
// router's own tests exercise it directly and still see AppError's real
// status instead of Hono's generic 500 for an uncaught throw.
editorProxyRouter.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})

// --- scope cache -------------------------------------------------------------

/**
 * Design doc's own "Scope cache: in-memory 5s keyed projectId:sessionId
 * holding the socket path (stale entry can only reach a dead socket => 502,
 * never another session)". The cached value is `editorSocketPath(sessionId)`,
 * a pure function of an already-UUID-shaped id — so even a stale hit can
 * only ever point at *this* session's own socket, dead or alive, never at
 * some other session's. What the cache actually saves is the
 * `resolveDockerScope` round trip (a project lookup plus a session lookup)
 * on every single proxied request, including every static asset the
 * workbench loads.
 */
const SCOPE_CACHE_TTL_MS = 5_000

interface CachedSocket {
  path: string
  expiresAt: number
}

const socketPathCache = new Map<string, CachedSocket>()

async function resolveEditorSocketPath(projectId: string, sessionId: string): Promise<string> {
  const key = `${projectId}:${sessionId}`
  const now = Date.now()
  const cached = socketPathCache.get(key)
  if (cached && cached.expiresAt > now) return cached.path

  await resolveDockerScope(projectId, sessionId) // throws 400/404/409 — see scope.ts
  const path = editorSocketPath(sessionId)
  socketPathCache.set(key, { path, expiresAt: now + SCOPE_CACHE_TTL_MS })
  return path
}

/** Test-only: bring the cache back to empty between test files — the same
 * discipline docker/routes.ts's own `resetLogStreamSlotsForTests` already
 * uses for its per-process counter. */
export function resetEditorProxyScopeCacheForTests(): void {
  socketPathCache.clear()
}

// --- origin check --------------------------------------------------------------

/**
 * First `X-Forwarded-Host` value if present, else `Host` — the "effective
 * host" this proxy's own origin check compares an `Origin` against, and also
 * what it hands upstream as `X-Forwarded-Host` so code-server's own check
 * (`Forwarded host=` -> `X-Forwarded-Host` -> `Host`) agrees with it. Vite's
 * dev proxy sets this header from the browser's real `Host` on both the HTTP
 * and WS legs (see frontend/vite.config.ts); nginx in production forwards
 * `Host` unchanged, so `Host` itself is exactly as good a fallback.
 */
function effectiveHost(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-host')
  const first = forwarded?.split(',')[0]?.trim()
  return first || headers.get('host') || ''
}

/**
 * No `Origin` header at all is not a mismatch: an ordinary top-level
 * navigation (the iframe's own `GET` for the workbench HTML, or for a static
 * asset it references) never carries one, and this is only ever called for a
 * WS upgrade or a non-GET/HEAD request in the first place — see
 * `requiresOriginCheck` below. Ports are compared exactly, never normalized
 * against a scheme's default port: the design's own "compared STRICTLY".
 */
function originAllowed(headers: Headers, effHost: string): boolean {
  const origin = headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === effHost.toLowerCase()
  } catch {
    // Not a parseable URL at all — never something a real browser sends.
    return false
  }
}

/** Design doc's own "Enforce on every WS upgrade and every non-GET/HEAD
 * request" — an ordinary GET/HEAD (the workbench page, its static assets)
 * is exempt, since those are exactly the requests a same-origin iframe
 * navigation legitimately makes with no `Origin` header at all. */
function requiresOriginCheck(method: string, isUpgrade: boolean): boolean {
  return isUpgrade || (method !== 'GET' && method !== 'HEAD')
}

function isWebSocketUpgrade(headers: Headers): boolean {
  const upgrade = headers.get('upgrade')?.toLowerCase()
  const connection = headers.get('connection')?.toLowerCase() ?? ''
  return upgrade === 'websocket' && connection.includes('upgrade')
}

// --- header filtering + Location rewriting ------------------------------------

/**
 * Hop-by-hop per RFC 9110 §7.6.1, plus `proxy-*` and `host` — never forwarded
 * in either direction. `Connection`/`Upgrade`/`Te`/`Trailer`/
 * `Transfer-Encoding`/`Keep-Alive` describe *this* hop's own transport, not a
 * fact about the resource being proxied; `Host` has to be the proxy's own
 * idea of the upstream (`localhost`), never the browser's.
 */
function isHopByHopHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'connection' ||
    lower === 'keep-alive' ||
    lower === 'te' ||
    lower === 'trailer' ||
    lower === 'transfer-encoding' ||
    lower === 'upgrade' ||
    lower === 'host' ||
    lower.startsWith('proxy-')
  )
}

/** Shared by the HTTP and the WebSocket path (the latter converts this to a
 * plain object — see `proxyWebSocket` below) — both need the identical
 * "forward everything but hop-by-hop, then stamp X-Forwarded-*" treatment. */
function upstreamRequestHeaders(source: Headers, effHost: string, proto: string): Headers {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    if (isHopByHopHeader(name)) continue
    headers.set(name, value)
  }
  headers.set('x-forwarded-host', effHost)
  headers.set('x-forwarded-proto', proto)
  return headers
}

/**
 * code-server's own idea of its host is `localhost` — it never sees this
 * proxy, let alone a real hostname — so that is the one shape of absolute
 * `Location` this ever needs to rewrite back through the proxy's own prefix.
 * A relative Location (what v1's own flags always produce — design doc:
 * "relative redirect") is left untouched on purpose: the browser already
 * resolves it correctly against the URL it actually requested, and rewriting
 * it here would need to reimplement that resolution for no gain.
 */
const ABSOLUTE_LOCALHOST_LOCATION = /^https?:\/\/localhost(?::\d+)?(?:[/?#]|$)/i

function rewriteLocation(raw: string, effHost: string, proto: string, prefix: string): string {
  if (!ABSOLUTE_LOCALHOST_LOCATION.test(raw)) return raw
  try {
    const target = new URL(raw)
    return `${proto}://${effHost}${prefix}${target.pathname}${target.search}${target.hash}`
  } catch {
    return raw
  }
}

function downstreamResponseHeaders(
  source: Headers,
  effHost: string,
  proto: string,
  prefix: string,
): Headers {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    if (isHopByHopHeader(name)) continue
    const outValue =
      name.toLowerCase() === 'location' ? rewriteLocation(value, effHost, proto, prefix) : value
    headers.append(name, outValue)
  }
  return headers
}

// --- HTTP proxy ----------------------------------------------------------------

/**
 * True only for the browser's own top-level navigation to the workbench page
 * itself — never an asset it loads, an XHR/fetch it makes, an iframe, or a
 * WebSocket upgrade (which never reaches this function at all — see
 * `handleProxy`'s `upgrade` branch). `Sec-Fetch-Dest: document` is the
 * precise signal for that: a Fetch Metadata header the browser attaches
 * itself to every request, which no asset request or XHR ever sets to
 * `document`. Older clients (or a browser with Fetch Metadata disabled) send
 * none of the `Sec-Fetch-*` headers, so this falls back first to
 * `Sec-Fetch-Mode: navigate` (an older, less specific version of the same
 * signal) and then to a plain `Accept: text/html` check — still never true
 * for a WebSocket handshake (no such `Accept`) or a JS/CSS/image asset
 * (whose `Accept` never lists `text/html`). Restricted to GET/HEAD because
 * those are the only methods a browser navigation ever issues; nothing under
 * this proxy is reached by a submitted HTML form.
 */
function isDocumentNavigation(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const dest = req.headers.get('sec-fetch-dest')
  if (dest) return dest === 'document'
  const mode = req.headers.get('sec-fetch-mode')
  if (mode) return mode === 'navigate'
  return (req.headers.get('accept') ?? '').includes('text/html')
}

async function proxyHttp(
  req: Request,
  socketPath: string,
  pathAndQuery: string,
  effHost: string,
  proto: string,
  prefix: string,
  launcherPath: string,
): Promise<Response> {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

  let upstream: Response
  try {
    upstream = await fetch(`http://localhost${pathAndQuery}`, {
      unix: socketPath,
      method: req.method,
      headers: upstreamRequestHeaders(req.headers, effHost, proto),
      body: hasBody ? req.body : undefined,
      duplex: 'half',
      // Design doc risks 5 & 6, both mandatory. Following a redirect here
      // would resolve it against `localhost` (code-server's own idea of its
      // host), not this proxy's; auto-decompressing would still leave the
      // upstream's original Content-Encoding header on the response,
      // corrupting it for whatever actually reads the (now-plain) bytes.
      redirect: 'manual',
      decompress: false,
      // Design doc risk 2: without this, Bun keeps the unix connection open
      // for reuse across requests, which is exactly what stops
      // code-server's own `--idle-timeout-seconds` from ever seeing zero
      // active connections and shutting itself down.
      keepalive: false,
    })
  } catch (error) {
    logger.debug(`Editor proxy: no answer from ${socketPath}: ${String(error)}`)
    // A reload of the workbench tab itself, after the editor stopped (idle
    // timeout, Stop, a restart) would otherwise land on a bare 502 JSON body
    // with no way back in — the tab's location is stuck on the proxy path,
    // and reloading it just repeats the same dead fetch forever. Sending
    // *only* this one case to the launcher (never an asset/XHR the dead
    // workbench itself was mid-request on, and never a WebSocket, which
    // 502s before ever reaching here) re-enters the same "start if needed,
    // then replace the location" flow the Editor button already uses, so the
    // tab self-heals on reload instead of dead-ending. `no-store` keeps a
    // browser from ever serving this redirect back out of its cache once the
    // editor is running again.
    if (isDocumentNavigation(req)) {
      return new Response(null, {
        status: 303,
        headers: { Location: launcherPath, 'Cache-Control': 'no-store' },
      })
    }
    throw badGateway('The editor is not responding')
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: downstreamResponseHeaders(upstream.headers, effHost, proto, prefix),
  })
}

// --- WebSocket proxy -------------------------------------------------------------

/** Design doc's own "await open (5s timeout else 502)". */
const EDITOR_WS_UPSTREAM_OPEN_TIMEOUT_MS = 5_000
/** Design doc's own "limit 1000 msgs / 8MB" on what gets buffered for a
 * client that has not finished its own upgrade yet (see `proxyWebSocket` and
 * `editorWebSocketHandler.open` below for why that window exists at all). */
const EDITOR_WS_PENDING_MAX_MESSAGES = 1_000
const EDITOR_WS_PENDING_MAX_BYTES = 8 * 1024 * 1024
/** Bun's client `WebSocket` reports `readyState === 1` for OPEN — no `.OPEN`
 * static of its own to reference (see bun-types' own client WebSocket
 * interface), so this is spelled out once, here. */
const WS_READY_STATE_OPEN = 1

/**
 * Close codes that describe *how* a connection ended without ever being a
 * code an endpoint may actually *send* (RFC 6455 §7.4.1) — relaying one of
 * these verbatim into a real `.close(code, ...)` call throws. Design doc's
 * own list.
 */
const NON_SENDABLE_CLOSE_CODES = new Set([1004, 1005, 1006, 1015])

function sendableCloseCode(code: number): number {
  return NON_SENDABLE_CLOSE_CODES.has(code) ? 1000 : code
}

interface EditorProxyWsData {
  kind: 'editor-proxy'
  upstream: WebSocket
  /** Everything the upstream sent before the client's own `open` callback
   * fired — see `editorWebSocketHandler.open` below for why that gap exists
   * and why nothing sent into it may be dropped. */
  pending: (string | Buffer)[]
  pendingBytes: number
  /** Set once, by `editorWebSocketHandler.open`; null until then — how code
   * running before the client is upgraded (`proxyWebSocket`'s own upstream
   * listeners, registered first) tells "not open yet" from "open". */
  ws: ServerWebSocket<EditorProxyWsData> | null
}

function payloadBytes(payload: string | Buffer): number {
  return typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
}

function bufferPending(data: EditorProxyWsData, payload: string | Buffer): void {
  const size = payloadBytes(payload)
  if (
    data.pending.length >= EDITOR_WS_PENDING_MAX_MESSAGES ||
    data.pendingBytes + size > EDITOR_WS_PENDING_MAX_BYTES
  ) {
    logger.warn('Editor proxy: dropped a message buffered before the client finished upgrading')
    return
  }
  data.pending.push(payload)
  data.pendingBytes += size
}

/**
 * Resolves `true` once `ws` is open, `false` on a timeout or on any
 * error/close that arrives first — design doc's own "open upstream and await
 * `open`". The upstream has to actually accept the connection before this
 * proxy ever calls `server.upgrade`, so a client whose editor container is
 * down, refusing, or merely slow sees a failed handshake, never an open
 * socket to nowhere.
 */
function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  if (ws.readyState === WS_READY_STATE_OPEN) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('close', onFail)
      ws.removeEventListener('error', onFail)
      resolve(ok)
    }
    const onOpen = () => settle(true)
    const onFail = () => settle(false)
    const timer = setTimeout(() => settle(false), timeoutMs)
    ws.addEventListener('open', onOpen)
    ws.addEventListener('close', onFail)
    ws.addEventListener('error', onFail)
  })
}

async function proxyWebSocket(
  c: Context,
  socketPath: string,
  pathAndQuery: string,
  effHost: string,
  proto: string,
  headers: Headers,
): Promise<Response> {
  // Bun.serve's real `fetch` handler always passes the Server as its second
  // argument (src/index.ts), which Hono exposes as `c.env` — see hono's own
  // bun adapter (node_modules/hono/dist/adapter/bun/websocket.js) for the
  // identical lookup. `app.request()` (every test in this file) passes no
  // second argument at all, so `c.env` is `undefined` there — the ONLY way
  // this branch is reachable, hence the design doc's own "only under
  // app.request()" note on the 426 below.
  const server = c.env as { upgrade?: Server<EditorProxyWsData>['upgrade'] } | undefined
  if (typeof server?.upgrade !== 'function') {
    throw new AppError(
      'This process is not serving over a real Bun server, so a WebSocket cannot be upgraded here',
      426,
    )
  }

  const upstreamHeaders = Object.fromEntries(
    upstreamRequestHeaders(headers, effHost, proto).entries(),
  )
  const upstream = new WebSocket(`ws+unix://${socketPath}:${pathAndQuery}`, {
    headers: upstreamHeaders,
  })

  const data: EditorProxyWsData = {
    kind: 'editor-proxy',
    upstream,
    pending: [],
    pendingBytes: 0,
    ws: null,
  }

  // Registered before `waitForOpen` below even starts racing, not after: a
  // message the upstream sends the instant it opens must never be missed
  // just because this proxy was still awaiting that same open event.
  let failedBeforeUpgrade = false
  upstream.addEventListener('message', (event) => {
    const payload = event.data as string | Buffer
    if (data.ws) data.ws.send(payload)
    else bufferPending(data, payload)
  })
  upstream.addEventListener('close', (event) => {
    if (data.ws) data.ws.close(sendableCloseCode(event.code), event.reason)
    else failedBeforeUpgrade = true
  })
  upstream.addEventListener('error', () => {
    // Design doc's own "upstream error -> close client with 1011" — but
    // there is no client yet at this point in the flow; recorded here so the
    // caller 502s instead of upgrading onto a connection that already failed.
    if (data.ws) data.ws.close(1011, 'Upstream connection error')
    else failedBeforeUpgrade = true
  })

  const opened = await waitForOpen(upstream, EDITOR_WS_UPSTREAM_OPEN_TIMEOUT_MS)
  if (!opened || failedBeforeUpgrade) {
    try {
      upstream.close()
    } catch {
      // Already closed/closing.
    }
    throw badGateway('The editor is not responding')
  }

  const upgraded = server.upgrade(c.req.raw, { data })
  if (!upgraded) {
    try {
      upstream.close()
    } catch {
      // Already closed/closing.
    }
    throw new AppError('WebSocket upgrade failed', 500)
  }

  // Bun has already sent (or is about to send, synchronously) the 101
  // response the moment `upgrade` returned true; the fetch handler's own
  // return value is discarded from here on — the same placeholder hono's own
  // bun adapter returns for the identical reason.
  return new Response(null)
}

/**
 * Passed to `Bun.serve` in src/index.ts as `websocket:` — the client-facing
 * half of the proxy; `proxyWebSocket` above is the upstream-facing half.
 * `idleTimeout`/`sendPings` match the design doc's own "Handler idleTimeout:
 * 300, pings on."
 */
export const editorWebSocketHandler: WebSocketHandler<EditorProxyWsData> = {
  idleTimeout: 300,
  sendPings: true,
  open(ws) {
    ws.data.ws = ws
    // Flush whatever the upstream already sent while this handshake was
    // still in flight (see `proxyWebSocket`'s own listeners) — nothing sent
    // in that window is allowed to be lost.
    for (const payload of ws.data.pending) ws.send(payload)
    ws.data.pending = []
    ws.data.pendingBytes = 0
  },
  message(ws, message) {
    // Client -> upstream, unchanged either way (string or Buffer).
    ws.data.upstream.send(message)
  },
  close(ws, code, reason) {
    try {
      ws.data.upstream.close(sendableCloseCode(code), reason)
    } catch {
      // Already closed/closing.
    }
  },
}

// --- routes ----------------------------------------------------------------------

const proxyParams = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() })

function parseProxyParams(c: Context): { id: string; sessionId: string } {
  const parsed = proxyParams.safeParse({
    id: c.req.param('id'),
    sessionId: c.req.param('sessionId'),
  })
  if (!parsed.success) throw validationFailed(issuesFor(parsed.error))
  return parsed.data
}

async function handleProxy(c: Context, id: string, sessionId: string): Promise<Response> {
  if (!editorEnabled) {
    throw forbidden('The editor is disabled (DOCKER_ENABLED or EDITOR_ENABLED is false)')
  }

  const req = c.req.raw
  const url = new URL(req.url)
  const headers = req.headers
  const upgrade = isWebSocketUpgrade(headers)
  const effHost = effectiveHost(headers)

  // Before anything is proxied, and before the scope lookup below runs — a
  // request whose origin already disqualifies it should not also learn
  // whether the project/session it named exists.
  if (requiresOriginCheck(req.method, upgrade) && !originAllowed(headers, effHost)) {
    throw forbidden('Origin does not match this host')
  }

  const socketPath = await resolveEditorSocketPath(id, sessionId) // 400/404/409

  // The prefix is derived from `editorProxyPath`, never hand-duplicated, so
  // the string this strips can never drift from the one service.ts hands the
  // client as `proxyPath`. Slicing the raw pathname (not a decoded/rejoined
  // one) is what keeps percent-encoding in the tail exactly as the client
  // sent it — see design doc's own "keep the RAW pathname".
  const prefix = editorProxyPath(id, sessionId).slice(0, -1) // drop the trailing '/'
  const pathAndQuery = url.pathname.slice(prefix.length) + url.search
  const proto = headers.get('x-forwarded-proto') || url.protocol.replace(':', '')

  if (upgrade) return proxyWebSocket(c, socketPath, pathAndQuery, effHost, proto, headers)
  return proxyHttp(
    req,
    socketPath,
    pathAndQuery,
    effHost,
    proto,
    prefix,
    editorLauncherPath(id, sessionId),
  )
}

editorProxyRouter.all('/projects/:id/sessions/:sessionId/editor/proxy', (c) => {
  const { id, sessionId } = parseProxyParams(c)
  const search = new URL(c.req.url).search
  return c.redirect(`${editorProxyPath(id, sessionId)}${search}`, 308)
})

editorProxyRouter.all('/projects/:id/sessions/:sessionId/editor/proxy/*', async (c) => {
  const { id, sessionId } = parseProxyParams(c)
  return handleProxy(c, id, sessionId)
})
