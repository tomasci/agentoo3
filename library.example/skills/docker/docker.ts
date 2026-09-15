// docker.ts — a thin client for this app's own Docker feature.
//
//   bun "${CLAUDE_SKILL_DIR}/docker.ts" <status|up|stop|restart|down|addresses> [flags] [service...]
//
// HARD RULE: ZERO IMPORTS. This file is copied whole (cp -r, no build step)
// into a plugin directory that has no node_modules and no tsconfig sitting
// next to it. Any `import` or `require` here resolves against nothing and
// fails before the first useful line runs. Every capability this script uses
// is therefore a Bun/web global: fetch, AbortSignal, TextDecoder,
// process.env, process.argv, process.exitCode, console. If some future
// change seems to need a package, that is a sign the change belongs
// somewhere else, not a reason to add an import here.
//
// This never shells out to `docker` directly, on purpose: every mutation
// below goes through this app's own API, which is what makes it a real,
// named, stoppable operation on the app's Docker page instead of an
// untracked process only this script's caller can see. See SKILL.md for why
// that distinction matters.

// --- fatal errors --------------------------------------------------------

/** Thrown for anything that means "stop and report one clear line," as
 * opposed to a normal command outcome (an operation that legitimately failed
 * still gets its own status/exit code below, not this). */
class SkillError extends Error {}

function fail(message: string): never {
  throw new SkillError(message)
}

// --- boundary parsing ------------------------------------------------------
//
// Every value below either came from the network or from argv — both
// untrusted no matter what this file's own types claim — so each is checked
// on the way in and turned into a clear one-line failure rather than a
// `TypeError: Cannot read properties of undefined` three lines later.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${context}: expected an object, got ${describe(value)}`)
  return value
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context}: expected an array, got ${describe(value)}`)
  return value
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string') fail(`${context}: expected a string, got ${describe(value)}`)
  return value
}

function asNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(`${context}: expected a number, got ${describe(value)}`)
  return value
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}

/** Like `describe()`, but for a value that already passed its type check and
 * failed on its *content* instead — naming the type back would just repeat
 * "string", telling the reader nothing they did not already know. Bounded in
 * length because this renders whatever an SSE stream sent, and a corrupt or
 * adversarial stream should not be able to dump unbounded text into the
 * transcript. */
function describeValue(value: unknown, maxLength = 200): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

// --- session scope -----------------------------------------------------
//
// The backend injects these into every session. AGENTOO_SESSION_ID is only
// set when the session has its own git worktree — sending `?sessionId=` iff
// the variable is set (never fabricating one, never dropping one that is
// present) is what makes this mirror the backend's own resolveDockerScope:
// that function 400s a sessionId belonging to a session with no worktree of
// its own, so honouring "is the variable set" rather than guessing means
// this script can never construct a request shaped like that 400 in the
// first place. Omitting the param entirely (an older/shared-checkout
// session) is repo scope, and it is correct, not a fallback or an error.
function scopeQuery(): string {
  const sessionId = process.env.AGENTOO_SESSION_ID
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
}

interface Env {
  base: string
  projectId: string
}

/** Fails loudly and immediately rather than letting an older session (or one
 * launched outside this app) 404 its way through five confusing requests. */
function readEnv(): Env {
  const base = process.env.AGENTOO_API_BASE
  const projectId = process.env.AGENTOO_PROJECT_ID
  if (!base) fail('AGENTOO_API_BASE is not set — this session was not given a docker scope')
  if (!projectId) fail('AGENTOO_PROJECT_ID is not set — this session was not given a docker scope')
  return { base: base.replace(/\/+$/, ''), projectId }
}

// --- HTTP ------------------------------------------------------------------

/** GETs/POSTs JSON, and turns every way that can go wrong — network failure,
 * a non-2xx status, a body that is not JSON at all — into one SkillError
 * instead of an unhandled rejection or a silent `undefined`. */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (error) {
    fail(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await res.text()
  let body: unknown = undefined
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      fail(`${url} returned a non-JSON body (status ${res.status}): ${text.slice(0, 200)}`)
    }
  }
  if (!res.ok) {
    const message = isPlainObject(body) && typeof body.error === 'string' ? body.error : text.slice(0, 200)
    fail(`${url} -> ${res.status}${message ? `: ${message}` : ''}`)
  }
  return body
}

// --- DTOs, hand-parsed from backend/src/features/docker/schema.ts ----------
//
// No zod here (see the header comment) — these mirror dockerStateSchema /
// dockerOperationSchema closely enough to render, and only pull the fields
// this script actually uses.

interface HostAddress {
  label: string
  host: string
}

interface PublishedPort {
  hostPort: number
}

interface ContainerInfo {
  name: string
  service: string | null
  state: string
  health: string
  ports: PublishedPort[]
}

interface ServiceInfo {
  name: string
  state: string
}

interface DaemonInfo {
  cliInstalled: boolean
  available: boolean
  version: string | null
}

interface DetectionInfo {
  hasCompose: boolean
  hasDockerfile: boolean
}

interface DockerState {
  daemon: DaemonInfo
  detection: DetectionInfo
  configError: string | null
  services: ServiceInfo[]
  containers: ContainerInfo[]
  hosts: HostAddress[]
  activeOperationId: string | null
}

function parseState(body: unknown): DockerState {
  const root = asRecord(body, 'docker state')
  const daemonRaw = asRecord(root.daemon, 'docker state.daemon')
  const detectionRaw = asRecord(root.detection, 'docker state.detection')
  return {
    daemon: {
      cliInstalled: daemonRaw.cliInstalled === true,
      available: daemonRaw.available === true,
      version: typeof daemonRaw.version === 'string' ? daemonRaw.version : null,
    },
    detection: {
      hasCompose: detectionRaw.hasCompose === true,
      hasDockerfile: detectionRaw.hasDockerfile === true,
    },
    configError: typeof root.configError === 'string' ? root.configError : null,
    services: asArray(root.services, 'docker state.services').map((raw, i) => {
      const rec = asRecord(raw, `docker state.services[${i}]`)
      return { name: asString(rec.name, `services[${i}].name`), state: asString(rec.state, `services[${i}].state`) }
    }),
    containers: asArray(root.containers, 'docker state.containers').map((raw, i) => {
      const rec = asRecord(raw, `docker state.containers[${i}]`)
      const ports = asArray(rec.ports, `containers[${i}].ports`).map((portRaw, j) => {
        const portRec = asRecord(portRaw, `containers[${i}].ports[${j}]`)
        return { hostPort: asNumber(portRec.hostPort, `containers[${i}].ports[${j}].hostPort`) }
      })
      return {
        name: asString(rec.name, `containers[${i}].name`),
        service: typeof rec.service === 'string' ? rec.service : null,
        state: asString(rec.state, `containers[${i}].state`),
        health: asString(rec.health, `containers[${i}].health`),
        ports,
      }
    }),
    hosts: asArray(root.hosts, 'docker state.hosts').map((raw, i) => {
      const rec = asRecord(raw, `docker state.hosts[${i}]`)
      return { label: asString(rec.label, `hosts[${i}].label`), host: asString(rec.host, `hosts[${i}].host`) }
    }),
    activeOperationId: typeof root.activeOperationId === 'string' ? root.activeOperationId : null,
  }
}

interface OperationInfo {
  id: string
  status: string
  error: string | null
}

function parseOperation(body: unknown): OperationInfo {
  const rec = asRecord(body, 'docker operation')
  return {
    id: asString(rec.id, 'operation.id'),
    status: asString(rec.status, 'operation.status'),
    error: typeof rec.error === 'string' ? rec.error : null,
  }
}

// --- rendering ---------------------------------------------------------

function containerLabel(container: ContainerInfo): string {
  return container.service ? `${container.name} (${container.service})` : container.name
}

/** Every `hosts[]` entry against every `ports[]` entry, the way the docker
 * skill's SKILL.md promises. Deduped on the rendered line itself: a
 * container's published port is reported once per hostIp docker bound it to
 * (0.0.0.0 and :: for the same hostPort is normal), and hostIp plays no part
 * in the URL, so without this the same address would print twice for no
 * reason a reader could use. */
function containerAddressLines(container: ContainerInfo, hosts: HostAddress[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const port of container.ports) {
    for (const host of hosts) {
      const line = `${host.label}: http://${host.host}:${port.hostPort}`
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  return lines
}

function renderStatus(state: DockerState): string {
  const lines: string[] = []
  lines.push(
    `daemon: cliInstalled=${state.daemon.cliInstalled} available=${state.daemon.available} version=${state.daemon.version ?? 'unknown'}`,
  )
  lines.push(`detection: hasCompose=${state.detection.hasCompose} hasDockerfile=${state.detection.hasDockerfile}`)
  if (state.configError) lines.push(`configError: ${state.configError}`)
  if (state.services.length === 0) {
    lines.push('services: (none — plain-Dockerfile project, or nothing compose-shaped detected)')
  } else {
    for (const service of state.services) lines.push(`service ${service.name}: ${service.state}`)
  }
  if (state.containers.length === 0) {
    lines.push('containers: (none)')
  } else {
    for (const container of state.containers) {
      lines.push(`container ${containerLabel(container)}: state=${container.state} health=${container.health}`)
      for (const line of containerAddressLines(container, state.hosts)) lines.push(`  ${line}`)
    }
  }
  lines.push(`activeOperationId: ${state.activeOperationId ?? 'none'}`)
  return lines.join('\n')
}

function renderAddresses(state: DockerState): string {
  const lines: string[] = []
  for (const container of state.containers) {
    const addresses = containerAddressLines(container, state.hosts)
    if (addresses.length === 0) continue
    lines.push(`${containerLabel(container)}:`)
    for (const line of addresses) lines.push(`  ${line}`)
  }
  if (lines.length === 0) lines.push('no published ports yet — nothing to address (is the stack up?)')
  return lines.join('\n')
}

// --- operation events (SSE) -------------------------------------------------
//
// Mirrors backend/src/features/docker/routes.ts's operation-events route:
// `retry: 3000\n: connected\n\n`, then `event: operation|output|end\ndata:
// <json>\n\n` frames, plus a `: ping\n\n` comment every 20s. A `data:` line
// never itself contains a raw newline (JSON.stringify escapes them), so a
// frame is exactly the text between one blank-line separator and the next —
// no SSE library needed for a one-shot, non-reconnecting read like this one.
//
// The route itself always writes bare LF (`\n\n`); the CRLF (`\r\n\r\n`)
// tolerance in findFrameBoundary below is for a proxy in front of it that
// might rewrite line endings, not for anything this app emits itself. Kept
// in step with handleFrame's own per-line `.replace(/\r$/, '')` on purpose —
// that strip only makes sense if a CRLF stream can also be split into frames
// in the first place, so do not "simplify" one half back out without the
// other.

/** The backend's own worker timeout is 30 minutes (DOCKER_OP_TIMEOUT_MS); this
 * is deliberately half that. An agent blocked for 15 minutes with nothing on
 * screen should get its terminal back and go re-check with `status`, rather
 * than sit through the worker's own much longer ceiling doing nothing useful. */
const STREAM_TIMEOUT_MS = 15 * 60 * 1000

/** The earliest blank-line frame separator in `buffer`, bare-LF or CRLF —
 * see the comment above for why both have to be recognised. Returns the
 * separator's own length alongside its index so the caller can skip past
 * whichever one actually matched, not a byte count hardcoded to one form. */
function findFrameBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  if (lf !== -1) return { index: lf, length: 2 }
  return null
}

function handleFrame(frame: string): 'succeeded' | 'failed' | null {
  let eventName: string | null = null
  let dataLine: string | null = null
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue // comment or heartbeat
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim()
  }
  if (eventName === null || dataLine === null) return null

  let data: unknown
  try {
    data = JSON.parse(dataLine)
  } catch {
    fail(`operation event stream sent malformed ${eventName} data: ${dataLine.slice(0, 200)}`)
  }

  if (eventName === 'output') {
    const rec = asRecord(data, 'output event')
    const text = typeof rec.text === 'string' ? rec.text : ''
    const toStderr = rec.stream === 'stderr'
    ;(toStderr ? console.error : console.log)(text)
    return null
  }
  if (eventName === 'end') {
    const rec = asRecord(data, 'end event')
    const status = rec.status
    if (status === 'succeeded' || status === 'failed') return status
    fail(`operation ended with an unexpected status: ${describeValue(status)}`)
  }
  // 'operation' frames are progress markers (queued -> running); the route
  // always follows a terminal status with its own 'end' frame (replayed
  // immediately if the operation had already finished by the time this
  // connected), so waiting for 'end' rather than resolving here loses nothing.
  return null
}

/** Opens the operation's SSE stream, prints `output` frames as they arrive,
 * and returns once an `end` frame reports a terminal status — or throws on
 * a genuine transport problem, or fails after STREAM_TIMEOUT_MS with the
 * operation id so the caller can re-check by hand instead of hanging. */
async function streamOperation(base: string, projectId: string, operationId: string): Promise<'succeeded' | 'failed'> {
  const url = `${base}/projects/${projectId}/docker/operations/${operationId}/events`
  const signal = AbortSignal.timeout(STREAM_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } })
  } catch (error) {
    if (signal.aborted) fail(timeoutMessage(operationId))
    fail(`could not open the operation event stream at ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!res.ok) fail(`operation event stream ${url} responded ${res.status}`)
  if (!res.body) fail(`operation event stream ${url} returned no body`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: { index: number; length: number } | null
      while ((boundary = findFrameBoundary(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const result = handleFrame(frame)
        if (result !== null) return result
      }
    }
  } catch (error) {
    if (signal.aborted) fail(timeoutMessage(operationId))
    // A SkillError thrown from handleFrame (malformed data, an unexpected
    // status) is already the precise, one-line diagnosis; wrapping it in
    // "broke: " here would bury that behind a vaguer transport-sounding
    // message for something that was never a transport problem. Only a
    // genuine transport error — one handleFrame never had a chance to shape —
    // gets the wrapper below.
    if (error instanceof SkillError) throw error
    fail(`operation event stream ${url} broke: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    reader.cancel().catch(() => {})
  }
  fail(`operation event stream ${url} ended before the operation reached a terminal status`)
}

function timeoutMessage(operationId: string): string {
  return (
    `operation ${operationId} did not finish within ${STREAM_TIMEOUT_MS / 60_000} minutes — ` +
    `it may still be running server-side; re-check with the "status" command rather than waiting longer here`
  )
}

// --- argv -------------------------------------------------------------

type Flags = Record<string, string | true>

function parseArgs(rest: string[]): { flags: Flags; services: string[] } {
  const flags: Flags = {}
  const services: string[] = []
  const numericFlags = new Set(['container-port', 'host-port'])
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) {
      services.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const name = arg.slice(2)
    const next = rest[i + 1]
    if (numericFlags.has(name) && next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      i += 1
    } else {
      flags[name] = true
    }
  }
  return { flags, services }
}

function requireAllowedFlags(flags: Flags, allowed: string[], command: string): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) {
      fail(`unknown flag --${name} for "${command}" — expected one of: ${allowed.map((n) => `--${n}`).join(', ') || '(none)'}`)
    }
  }
}

function parsePort(flags: Flags, name: string): number | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (value === true) fail(`--${name} needs a value`)
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--${name} must be an integer between 1 and 65535, got "${value}"`)
  return n
}

/** upRequestSchema.hostPort floors at 1024 (backend/src/features/docker/schema.ts)
 * so a mutation this skill sends never needs a privileged port; containerPort
 * carries no such floor. Checked as its own step, after parsePort's generic
 * 1..65535 range check above, so a value that is merely not a number still
 * gets that plain message, and only a value that parsed fine but is
 * privileged gets told the real rule — the same distinction the API's own
 * schema draws between "not an int" and "below the floor". Do not fold this
 * into parsePort itself: that would raise the floor for --container-port too,
 * which the API does not do. */
function requireUnprivilegedHostPort(port: number): number {
  if (port < 1024) fail(`--host-port must be 1024 or higher (ports below 1024 are privileged), got ${port}`)
  return port
}

// --- commands -----------------------------------------------------

async function fetchState(env: Env): Promise<DockerState> {
  return parseState(await fetchJson(`${env.base}/projects/${env.projectId}/docker${scopeQuery()}`))
}

async function runStatus(env: Env): Promise<number> {
  console.log(renderStatus(await fetchState(env)))
  return 0
}

async function runAddresses(env: Env): Promise<number> {
  console.log(renderAddresses(await fetchState(env)))
  return 0
}

async function runMutation(
  env: Env,
  kind: 'up' | 'stop' | 'restart' | 'down',
  body: Record<string, unknown>,
): Promise<number> {
  const url = `${env.base}/projects/${env.projectId}/docker/${kind}${scopeQuery()}`
  const posted = parseOperation(
    await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  console.log(`${kind} queued — operation ${posted.id}`)

  const finalStatus = await streamOperation(env.base, env.projectId, posted.id)

  if (finalStatus === 'succeeded') {
    if (kind === 'up') {
      console.log('')
      console.log('published addresses:')
      console.log(renderAddresses(await fetchState(env)))
    }
    return 0
  }

  // A failed operation is a real, reportable outcome, not a script bug — the
  // build/compose output already streamed above explains what broke; this
  // just adds the structured error field, when the operation recorded one.
  const finished = parseOperation(
    await fetchJson(`${env.base}/projects/${env.projectId}/docker/operations/${posted.id}`),
  )
  console.error(`${kind} failed (operation ${posted.id})${finished.error ? `: ${finished.error}` : ''}`)
  return 1
}

const USAGE = 'usage: docker.ts <status|up|stop|restart|down|addresses> [flags] [service...]'

async function main(): Promise<number> {
  const env = readEnv()
  const [, , command, ...rest] = process.argv
  if (!command) fail(USAGE)
  const { flags, services } = parseArgs(rest)

  switch (command) {
    case 'status':
      requireAllowedFlags(flags, [], command)
      return runStatus(env)
    case 'addresses':
      requireAllowedFlags(flags, [], command)
      return runAddresses(env)
    case 'up': {
      requireAllowedFlags(flags, ['build', 'force-recreate', 'remove-orphans', 'container-port', 'host-port'], command)
      const body: Record<string, unknown> = {}
      if (services.length > 0) body.services = services
      if (flags.build) body.build = true
      if (flags['force-recreate']) body.forceRecreate = true
      if (flags['remove-orphans']) body.removeOrphans = true
      const containerPort = parsePort(flags, 'container-port')
      if (containerPort !== undefined) body.containerPort = containerPort
      const hostPort = parsePort(flags, 'host-port')
      if (hostPort !== undefined) body.hostPort = requireUnprivilegedHostPort(hostPort)
      return runMutation(env, 'up', body)
    }
    case 'stop': {
      requireAllowedFlags(flags, [], command)
      const body: Record<string, unknown> = {}
      if (services.length > 0) body.services = services
      return runMutation(env, 'stop', body)
    }
    case 'restart': {
      requireAllowedFlags(flags, [], command)
      const body: Record<string, unknown> = {}
      if (services.length > 0) body.services = services
      return runMutation(env, 'restart', body)
    }
    case 'down': {
      requireAllowedFlags(flags, ['remove-volumes', 'remove-images'], command)
      const body: Record<string, unknown> = {}
      if (services.length > 0) body.services = services
      if (flags['remove-volumes']) body.removeVolumes = true
      if (flags['remove-images']) body.removeImages = true
      return runMutation(env, 'down', body)
    }
    default:
      fail(`unknown command "${command}" — ${USAGE}`)
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`docker skill: ${message}`)
    process.exitCode = 1
  })
