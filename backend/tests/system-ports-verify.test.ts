// Behavioural verification of GET /api/system/ports against the real host,
// not just fixtures: real `ss` parity, the real /proc fallback (forced by
// launching a child with a PATH that has no `ss`, or a fake one written here),
// the 503 path, truncation, the argv actually spawned, and in-flight dedup.
//
// Everything here needs Linux with iproute2's `ss` — the only platform this
// endpoint targets — and is skipped elsewhere rather than failing for a reason
// unrelated to the code.
//
// Host-parity checks tolerate churn: the host's socket table changes between
// our own `ss` snapshot and the endpoint's, so each comparison takes a snapshot
// before AND after, requires every socket present in both to be in the
// response, and requires every response row to be explained by one of them.
// The deterministic half (parser vs one captured snapshot) is exact.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'

const ports = await import('../src/features/system/ports')
const { portsResponseSchema } = await import('../src/features/system/schema')
const { systemRouter } = await import('../src/features/system/routes')
const { openApiValidationHook } = await import('../src/lib/openapi-hook')
const { AppError, errorBody } = await import('../src/lib/errors')

type Entry = (typeof ports)['parseSsOutput'] extends (t: string) => Array<infer E> ? E : never
type Body = {
  scope: string
  source: string
  collectedAt: string
  user: string | null
  runningAsRoot: boolean
  total: number
  truncated: boolean
  unattributedCount: number
  inferredCount: number
  ports: Entry[]
}

const BACKEND_DIR = new URL('..', import.meta.url).pathname
const SS_BIN = process.platform === 'linux' ? Bun.which('ss') : null
const SLEEP_BIN = Bun.which('sleep') ?? '/usr/bin/sleep'
const CAT_BIN = Bun.which('cat') ?? '/usr/bin/cat'
const onLinuxWithSs = SS_BIN !== null
const PYTHON = Bun.which('python3')

// In-process app: systemRouter under the production validation hook and an
// onError identical to app.ts's. createApp() itself is only used in the child,
// because in this shared process it would open a BullMQ Redis connection at
// the fake Redis other test files stand up.
const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', systemRouter)
app.onError((error, c) =>
  error instanceof AppError
    ? c.json(errorBody(error), error.status as 400)
    : c.json({ error: 'Internal server error' }, 500),
)

async function getJson(path: string): Promise<{ status: number; body: Body }> {
  const res = await app.request(path)
  return { status: res.status, body: (await res.json()) as Body }
}

/** `ss -p` run by the TEST as an independent oracle only — the endpoint
 * itself never passes `-p` any more (see SS_ARGS). Its users:(...) column is
 * still the one place outside /proc that names a socket's holders, so the
 * parity test below keeps using it to check the endpoint never does worse. */
async function runSs(flag: '-l' | '-a', extra: string[] = []): Promise<string> {
  const proc = Bun.spawn([SS_BIN ?? 'ss', '-H', '-t', '-u', '-n', '-p', flag, ...extra], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`ss ${flag} exited ${proc.exitCode}`)
  return text
}

/** Exactly the argv the endpoint spawns (SS_ARGS, restated here rather than
 * imported, so a change to it cannot silently change the oracle too). */
async function runSsE(flag: '-l' | '-a'): Promise<string> {
  const proc = Bun.spawn([SS_BIN ?? 'ss', '-H', '-t', '-u', '-n', '-e', flag], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`ss -e ${flag} exited ${proc.exitCode}`)
  return text
}

// --- an independent reading of ss output ---------------------------------
// Deliberately not the implementation's parser: a different address splitter
// and a process regex anchored on `,fd=N)` so a comm containing `",pid=` cannot
// shift the match.

interface RawSocket {
  protocol: string
  state: string
  localAddress: string
  localPort: number
  peerAddress: string | null
  peerPort: number | null
  procs: Array<{ pid: number; name: string }>
}

function splitRaw(field: string): { address: string; port: string } {
  const m = /^\[(.+)\](%[^:]+)?:([^:]+)$/.exec(field)
  if (m) return { address: `${m[1]}${m[2] ?? ''}`, port: m[3] ?? '' }
  const i = field.lastIndexOf(':')
  return { address: field.slice(0, i), port: field.slice(i + 1) }
}

function rawSockets(text: string): RawSocket[] {
  const out: RawSocket[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const f = line.trim().split(/\s+/)
    const local = splitRaw(f[4] ?? '')
    const peer = splitRaw(f[5] ?? '')
    const peerWild = peer.address === '*' || ((peer.address === '0.0.0.0' || peer.address === '::') && peer.port === '*')
    const usersIdx = line.indexOf('users:((')
    const procs: Array<{ pid: number; name: string }> = []
    if (usersIdx !== -1) {
      const users = line.slice(usersIdx + 'users:('.length).trimEnd()
      for (const m of users.matchAll(/\("(.*?)",pid=(\d+),fd=\d+\)(?=,\(|\)$)/g)) {
        const pid = Number(m[2])
        if (!procs.some((p) => p.pid === pid)) procs.push({ pid, name: m[1] ?? '' })
      }
    }
    out.push({
      protocol: (f[0] ?? '').toLowerCase(),
      state: (f[1] ?? '').toUpperCase() === 'ESTAB' ? 'ESTABLISHED' : (f[1] ?? '').toUpperCase(),
      localAddress: local.address,
      localPort: Number(local.port),
      peerAddress: peerWild ? null : peer.address,
      peerPort: peerWild || peer.port === '*' ? null : Number(peer.port),
      procs,
    })
  }
  return out
}

/**
 * What the PURE parser (`parseSsOutput`: no /proc scan, no passwd, no docker)
 * must return for one real `ss -e` line, derived independently: positional
 * split for the six columns, and a plain token search for uid/ino/cgroup.
 * pid/name are never resolved by the pure parser (attribution is by inode,
 * done later by the real endpoint); owner is ss's own uid as a numeric string
 * (no passwd behind the pure path), `root` when ss omitted `uid:` (its
 * shorthand for 0), and null for an `ino:0` orphan, which omits uid for a
 * different reason.
 */
function expectedPureRows(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const f = line.trim().split(/\s+/)
    const local = splitRaw(f[4] ?? '')
    const peer = splitRaw(f[5] ?? '')
    const peerWild = peer.address === '*' || ((peer.address === '0.0.0.0' || peer.address === '::') && (peer.port === '*' || peer.port === '0'))
    const tail = f.slice(6).join(' ')
    const uid = /(?:^| )uid:(\d+)/.exec(tail)?.[1]
    const ino = /(?:^| )ino:(\d+)/.exec(tail)?.[1]
    const cgroup = /(?:^| )cgroup:(\S+)/.exec(tail)?.[1] ?? null
    out.push({
      protocol: (f[0] ?? '').toLowerCase(),
      localAddress: local.address,
      localPort: Number(local.port),
      peerAddress: peerWild ? null : peer.address,
      peerPort: peerWild || peer.port === '*' ? null : Number(peer.port),
      state: (f[1] ?? '').toUpperCase() === 'ESTAB' ? 'ESTABLISHED' : (f[1] ?? '').toUpperCase(),
      pid: null,
      processName: 'unknown',
      processKnown: false,
      attribution: 'none',
      unit: deriveUnit(cgroup),
      container: null,
      owner: ino === '0' ? null : uid !== undefined ? uid : 'root',
    })
  }
  return out
}

/** One key per expected output row: (socket, process), or (socket, unknown). */
function expectedRowKeys(sockets: RawSocket[], withPeer = true): string[] {
  const keys: string[] = []
  for (const s of sockets) {
    const base = `${s.protocol}|${s.state}|${s.localAddress}|${s.localPort}${withPeer ? `|${s.peerAddress}|${s.peerPort}` : ''}`
    if (s.procs.length === 0) keys.push(`${base}|null|unknown|false`)
    for (const p of s.procs) keys.push(`${base}|${p.pid}|${p.name}|true`)
  }
  return keys
}

function rowKey(e: Entry, withPeer = true): string {
  return `${e.protocol}|${e.state}|${e.localAddress}|${e.localPort}${withPeer ? `|${e.peerAddress}|${e.peerPort}` : ''}|${e.pid}|${e.processName}|${e.processKnown}`
}

function countMap(keys: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
  return m
}

function intersect(a: string[], b: string[]): string[] {
  const have = countMap(b)
  const out: string[] = []
  for (const k of a) {
    const n = have.get(k) ?? 0
    if (n > 0) {
      have.set(k, n - 1)
      out.push(k)
    }
  }
  return out
}

/** Spec 4, restated independently. */
function isSortedPerSpec(rows: Entry[]): boolean {
  const rank = (e: Entry) => (e.state === 'LISTEN' || e.state === 'UNCONN' ? 0 : 1)
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1] as Entry
    const b = rows[i] as Entry
    const cmp =
      rank(a) - rank(b) ||
      a.localPort - b.localPort ||
      (a.protocol === b.protocol ? 0 : a.protocol < b.protocol ? -1 : 1) ||
      (a.localAddress === b.localAddress ? 0 : a.localAddress < b.localAddress ? -1 : 1) ||
      (a.pid ?? -1) - (b.pid ?? -1)
    if (cmp > 0) return false
  }
  return true
}

const SS_STATES = new Set([
  'LISTEN', 'UNCONN', 'ESTABLISHED', 'SYN-SENT', 'SYN-RECV', 'FIN-WAIT-1', 'FIN-WAIT-2',
  'TIME-WAIT', 'CLOSE-WAIT', 'LAST-ACK', 'CLOSING', 'CLOSED', 'UNKNOWN',
])

/** Spec 1 and 2 invariants that must hold on every row of every response. */
function assertRowInvariants(body: Body) {
  for (const e of body.ports) {
    expect(['tcp', 'udp']).toContain(e.protocol)
    expect(e.localAddress).not.toMatch(/[[\]]/)
    expect(Number.isInteger(e.localPort) && e.localPort >= 0 && e.localPort <= 65535).toBe(true)
    expect(e.peerAddress === null).toBe(e.peerPort === null)
    expect(SS_STATES.has(e.state)).toBe(true)
    expect(e.processKnown).toBe(e.pid !== null)
    if (!e.processKnown) expect(e.processName).toBe('unknown')
  }
  expect(body.unattributedCount).toBe(body.ports.filter((p) => !p.processKnown).length)
  expect(body.total).toBeGreaterThanOrEqual(body.ports.length)
  expect(body.truncated).toBe(body.total > ports.MAX_ROWS)
  expect(isSortedPerSpec(body.ports)).toBe(true)
  expect(portsResponseSchema.safeParse(body).success).toBe(true)
}

// --- independent verification of the three attribution families -------------
// `ss -e` (what the endpoint itself now runs) read separately here, with a
// users/cgroup parse that is NOT the implementation's, so a bug shared with the
// parser cannot hide. Real comms on this host contain no quote or paren, so a
// plain per-entry regex recovers the users column even with the -e tail after
// it. cgroup / cgroup.procs / cmdline / comm are read straight from the kernel.

interface RichSocket {
  protocol: string
  state: string
  localAddress: string
  localPort: number
  procs: Array<{ pid: number; name: string }>
  cgroupPath: string | null
}

function richSockets(text: string): RichSocket[] {
  const out: RichSocket[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const f = line.trim().split(/\s+/)
    const local = splitRaw(f[4] ?? '')
    const procs: Array<{ pid: number; name: string }> = []
    const ui = line.indexOf('users:((')
    if (ui !== -1) {
      for (const m of line.slice(ui).matchAll(/\("([^"]*)",pid=(\d+),fd=\d+\)/g)) {
        const pid = Number(m[2])
        if (!procs.some((p) => p.pid === pid)) procs.push({ pid, name: m[1] ?? '' })
      }
    }
    const cg = /\bcgroup:(\S+)/.exec(line)
    out.push({
      protocol: (f[0] ?? '').toLowerCase(),
      state: (f[1] ?? '').toUpperCase() === 'ESTAB' ? 'ESTABLISHED' : (f[1] ?? '').toUpperCase(),
      localAddress: local.address,
      localPort: Number(local.port),
      procs,
      cgroupPath: cg ? (cg[1] ?? null) : null,
    })
  }
  return out
}

/** The deepest .service/.socket/.scope segment of a cgroup path — an
 * independent re-derivation of what the endpoint calls `unit`. */
function deriveUnit(cgroup: string | null): string | null {
  if (!cgroup) return null
  const segs = cgroup.split('/').filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/\.(service|socket|scope)$/.test(segs[i] as string)) return segs[i] as string
  }
  return null
}

async function cgroupProcs(cgroup: string): Promise<number[]> {
  try {
    const t = await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')
    return t.split('\n').map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n))
  } catch {
    return []
  }
}

async function realComm(pid: number): Promise<string | null> {
  try {
    const r = await readFile(`/proc/${pid}/comm`, 'utf8')
    return r.endsWith('\n') ? r.slice(0, -1) : r
  } catch {
    return null
  }
}

async function realCmdline(pid: number): Promise<string[]> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
  } catch {
    return []
  }
}

function flagOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

// --- child-process harness --------------------------------------------------

let scratch = ''
const orphanPidFiles: string[] = []

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentoo-ports-verify-'))
})

afterAll(async () => {
  for (const f of orphanPidFiles) {
    const pid = Number((await readFile(f, 'utf8').catch(() => '')).trim())
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  held?.stop()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

let dirSeq = 0
/** A PATH directory containing only a fake `ss` (or nothing, when body is null). */
async function fakeSsDir(body: string | null): Promise<{ dir: string; log: string }> {
  const dir = join(scratch, `path-${dirSeq++}`)
  await Bun.write(join(dir, '.keep'), '')
  const log = join(dir, 'argv.log')
  if (body !== null) {
    const script =
      '#!/bin/sh\n' +
      // One line, one write(2) per invocation: O_APPEND keeps concurrent
      // invocations from interleaving (a per-argument printf did interleave).
      `(IFS='|'; echo "$*") >> '${log}'\n` +
      `${body}\n`
    await writeFile(join(dir, 'ss'), script)
    await chmod(join(dir, 'ss'), 0o755)
  }
  return { dir, log }
}

interface ChildResult {
  footprintBefore: { fds: number; children: number[] }
  footprintAfter: { fds: number; children: number[] }
  pid: number
  tcpPort: number | null
  udpPort: number | null
  batches: Array<{
    responses: Array<{ path: string; status: number; body: Body & { error?: string }; ms: number }>
    log: string | null
  }>
}

async function runChild(
  pathDir: string,
  plan: { breakProc?: boolean; listen?: boolean; batches: string[][]; logFile?: string },
): Promise<ChildResult> {
  const out = join(scratch, `out-${dirSeq++}.json`)
  const proc = Bun.spawn([process.execPath, 'test', './tests/system-ports-verify-child.ts'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PATH: pathDir,
      PORTS_VERIFY_PLAN: JSON.stringify(plan),
      PORTS_VERIFY_OUT: out,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`child exited ${proc.exitCode}:\n${stderr}`)
  return JSON.parse(await readFile(out, 'utf8')) as ChildResult
}

function only<T>(xs: T[] | undefined): T {
  expect(xs?.length).toBe(1)
  return (xs as T[])[0] as T
}

// --- fixtures that name REAL inodes -----------------------------------------
// With `-p` gone, no fixture text can name a pid: a canned row only ever comes
// back `socket` if its `ino:` is an inode some visible process really holds,
// found by the child endpoint's own /proc/*/fd scan. So this test process
// holds one listener for the whole file and the fixtures name its inode —
// the child then attributes that row to THIS pid, exactly as it would a real
// ss line. The inode is learned independently: /proc/net/tcp by port, then
// confirmed in our own fd table.

let held: { port: number; inode: number; stop(): void } | null = null

async function socketInodesOf(pid: number | 'self'): Promise<Map<string, number>> {
  const out = new Map<string, number>() // fd -> inode
  let fds: string[] = []
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    return out
  }
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`))
      if (m) out.set(fd, Number(m[1]))
    } catch {}
  }
  return out
}

async function heldSocket(): Promise<{ port: number; inode: number }> {
  if (held) return held
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const want = `0100007F:${l.port.toString(16).toUpperCase().padStart(4, '0')}`
  const row = (await readFile('/proc/net/tcp', 'utf8'))
    .split('\n')
    .map((r) => r.trim().split(/\s+/))
    .find((f) => f[1] === want && f[3] === '0A')
  const inode = Number(row?.[9])
  const mine = [...(await socketInodesOf('self')).values()]
  if (!Number.isInteger(inode) || inode <= 0 || !mine.includes(inode)) {
    l.stop(true)
    throw new Error(`could not pin the held listener's inode (port ${l.port}, /proc/net row ${JSON.stringify(row)})`)
  }
  held = { port: l.port, inode, stop: () => l.stop(true) }
  return held
}

/** Every visible pid holding `inode` — the same uid-scoped view the endpoint has. */
async function visibleHolders(inode: number): Promise<number[]> {
  const pids: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    if ([...(await socketInodesOf(Number(entry))).values()].includes(inode)) pids.push(Number(entry))
  }
  return pids
}

/** Kernel socket inodes are allocated upward from small numbers; this one is
 * checked unheld by every visible process before any fixture relies on it. */
const UNHELD_INODE = 4_294_967_291
/** A unit with no cgroup directory at all, so `service` attribution finds no
 * cgroup.procs to read and a fixture row stays `none` deterministically. */
const FIXTURE_UNIT = 'agentoo-ports-verify-fixture.service'

async function assertFixturePreconditions(): Promise<void> {
  expect({ unheld: await visibleHolders(UNHELD_INODE) }).toEqual({ unheld: [] })
  expect({ cgroupExists: existsSync(`/sys/fs/cgroup/system.slice/${FIXTURE_UNIT}`) }).toEqual({ cgroupExists: false })
}

/** A small, valid `ss -H -t -u -n -e -l` body (the new no-`-p` shape) for the
 * argv / dedup / empty scenarios:
 *   8000 — our held inode: `socket`, this pid, owner from uid, unit from cgroup;
 *   8001 — the SAME real inode, but the line also carries a users:(...) claim
 *          naming pid 4242: every -e fact is dropped, so no pid (neither the
 *          claimed 4242 nor the real holder), no owner, no unit;
 *   8002 — an inode nobody holds: `none`, but owner and unit still read;
 *   53   — an old-ss line with no -e tail at all: nothing known. */
async function cannedSs(): Promise<string> {
  const h = await heldSocket()
  const uid = userInfo().uid
  return [
    `tcp LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* uid:${uid} ino:${h.inode} sk:1 cgroup:/system.slice/${FIXTURE_UNIT} <->`,
    `tcp LISTEN 0 128 127.0.0.1:8001 0.0.0.0:* users:(("bun",pid=4242,fd=9)) uid:${uid} ino:${h.inode} sk:2 cgroup:/system.slice/${FIXTURE_UNIT} <->`,
    `tcp LISTEN 0 128 127.0.0.1:8002 0.0.0.0:* uid:${uid} ino:${UNHELD_INODE} sk:3 cgroup:/system.slice/${FIXTURE_UNIT} <->`,
    'udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*',
  ].join('\n')
}

// --- 1. real host parity (ss path) ------------------------------------------

describe.skipIf(!onLinuxWithSs)('real host, ss reader', () => {
  // Re-expressed for the inode redesign. These used to feed a real `ss -p`
  // snapshot to parseSsOutput and expect the pids its users:(...) column
  // named; the pure parser no longer reads that column at all (attribution is
  // by inode, in the endpoint). What still has to hold, exactly, on a real
  // snapshot of the argv the endpoint actually spawns: one row per line, every
  // column read right, and every line's `-e` facts (owner, unit) kept — a
  // real ss line whose tail the strict parser rejected would lose its inode,
  // and with it its attribution, without anything else looking wrong.
  const sortKey = (r: Record<string, unknown>) => JSON.stringify(r)
  test('parser output on one captured `ss -e -l` snapshot equals an independent reading of it', async () => {
    const raw = await runSsE('-l')
    expect(raw.trim().split('\n').length).toBeGreaterThan(0)
    const parsed = ports.parseSsOutput(raw) as unknown as Array<Record<string, unknown>>
    expect(parsed.map(sortKey).sort()).toEqual(expectedPureRows(raw).map(sortKey).sort())
    // Not vacuous: a listener is never an ino:0 orphan, so its owner is only
    // ever null if the strict tail parser threw away a real line's facts.
    expect(parsed.filter((r) => r.owner === null)).toEqual([])
  })

  test('parser output on one captured `ss -e -a` snapshot equals an independent reading of it', async () => {
    const raw = await runSsE('-a')
    const parsed = ports.parseSsOutput(raw) as unknown as Array<Record<string, unknown>>
    expect(parsed.map(sortKey).sort()).toEqual(expectedPureRows(raw).map(sortKey).sort())
    // ESTABLISHED rows exist on this host and keep their peers.
    const estab = parsed.filter((e) => e.state === 'ESTABLISHED')
    expect(estab.length).toBeGreaterThan(0)
    expect(estab.every((e) => e.peerAddress !== null && e.peerPort !== null)).toBe(true)
    // The only rows with no owner are ino:0 orphans.
    const inoZero = raw.split('\n').filter((l) => / ino:0( |$)/.test(l)).length
    expect(parsed.filter((r) => r.owner === null).length).toBe(inoZero)
  })

  // ss -e is now the endpoint's own source, so the old test's premise — every
  // socket ss -p leaves unresolved comes back `unknown` — is no longer true:
  // those rows are now often named via docker/service. This checks the two
  // halves that must still hold, each verified against the kernel directly and
  // NOT via the implementation's own parser:
  //   * every socket `ss -p` itself attributes comes back attribution:'socket'
  //     with the same pid (the endpoint never does worse than ss);
  //   * every other returned row is either 'none', or 'docker'/'service' whose
  //     pid this test re-derives independently (docker: the pid's comm is
  //     docker-proxy and its cmdline's -host-port/-proto match; service: the
  //     ss cgroup's own unit == row.unit and the pid is in that cgroup's
  //     cgroup.procs, or pid 1 for an empty .socket unit).
  for (const [scope, flag] of [
    ['listening', '-l'],
    ['all', '-a'],
  ] as const) {
    test(`GET ?scope=${scope} matches \`ss ${flag} -e\` taken around it, every attribution independently verified`, async () => {
      // Our own readable socket: it must ALWAYS come back attribution:'socket'
      // with our pid — never laundered to service/docker via our cgroup.
      const own = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
      const keyOf = (s: { protocol: string; state: string; localAddress: string; localPort: number }) =>
        `${s.protocol}|${s.state}|${s.localAddress}|${s.localPort}`
      try {
        let lastDiff: unknown = null
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = richSockets(await runSs(flag, ['-e']))
          const { status, body } = await getJson(`/api/system/ports?scope=${scope}`)
          const after = richSockets(await runSs(flag, ['-e']))
          expect(status).toBe(200)
          expect(body.source).toBe('ss')
          expect(body.scope).toBe(scope)
          assertRowInvariants(body)

          const beforeKeys = new Set(before.map(keyOf))
          const stable = after.filter((s) => beforeKeys.has(keyOf(s)))
          const stableByKey = new Map(stable.map((s) => [keyOf(s), s]))
          const violations: string[] = []

          // (1) Every socket ss -p itself resolved must be attribution:'socket'
          // in the response, with the pid(s) ss named.
          for (const s of stable) {
            if (s.procs.length === 0) continue
            const rows = body.ports.filter((e) => keyOf(e) === keyOf(s))
            if (rows.length === 0) continue // this socket churned out of the response
            for (const r of rows) {
              if (r.attribution !== 'socket')
                violations.push(`ss-attributed ${keyOf(s)} came back attribution=${r.attribution}, not socket`)
            }
            for (const p of s.procs) {
              const live = await realComm(p.pid)
              if (live === null) continue // pid exited since the snapshot
              if (!p.name.includes('"') && live !== p.name) continue // ss printed a sanitised name
              const row = rows.find((r) => r.pid === p.pid)
              if (!row) violations.push(`ss pid ${p.pid} (${p.name}) on ${keyOf(s)} missing from response`)
              else if (!p.name.includes('"') && row.processName !== p.name)
                violations.push(`pid ${p.pid} name ${row.processName} != ss ${p.name}`)
            }
          }

          // (2) Every response row's attribution independently justified.
          for (const e of body.ports) {
            const k = keyOf(e)
            const s = stableByKey.get(k)
            if (e.attribution === 'socket') {
              if (e.localPort === own.port && e.localAddress === '127.0.0.1') continue
              if (!s) continue // churn — the socket wasn't in both ss snapshots
              const backed = s.procs.some(
                (p) => p.pid === e.pid && (p.name === e.processName || e.processName.includes('"')),
              )
              if (!backed) violations.push(`socket row pid ${e.pid} on ${k} not backed by an ss users:(...) claim`)
            } else if (e.attribution === 'docker') {
              const c = await realComm(e.pid as number)
              if (c === null) continue // proxy exited
              const argv = await realCmdline(e.pid as number)
              const hostPort = Number(flagOf(argv, '-host-port'))
              const proto = flagOf(argv, '-proto')
              if (c !== 'docker-proxy')
                violations.push(`docker row pid ${e.pid} on ${k} has comm ${c}, not docker-proxy`)
              else if (hostPort !== e.localPort || proto !== e.protocol)
                violations.push(`docker row ${k}: proxy -host-port ${hostPort}/-proto ${proto} != ${e.localPort}/${e.protocol}`)
            } else if (e.attribution === 'service') {
              if (!s) continue // churn — can't recover this socket's cgroup
              if (!s.cgroupPath) {
                violations.push(`service row ${k} but its ss line carried no cgroup`)
                continue
              }
              const unit = deriveUnit(s.cgroupPath)
              if (unit !== e.unit) violations.push(`service row ${k}: derived unit ${unit} != ${e.unit}`)
              const procs = await cgroupProcs(s.cgroupPath)
              if (procs.length === 0 && (unit ?? '').endsWith('.socket')) {
                if (e.pid !== 1) violations.push(`empty .socket ${k}: pid ${e.pid} != 1`)
              } else if (!procs.includes(e.pid as number)) {
                // Tolerate a main process that exited between the request and
                // this read; a still-live pid absent from cgroup.procs is real.
                if ((await realComm(e.pid as number)) !== null)
                  violations.push(`service row ${k}: pid ${e.pid} not in ${s.cgroupPath}/cgroup.procs`)
              }
            } else if (e.pid !== null) {
              violations.push(`none row ${k} carries pid ${e.pid}`)
            }
          }

          const mine = body.ports.filter((e) => e.localPort === own.port && e.localAddress === '127.0.0.1')
          if (mine.length !== 1) violations.push(`own socket rows: ${JSON.stringify(mine)}`)
          else if (mine[0]?.attribution !== 'socket' || mine[0]?.pid !== process.pid)
            violations.push(`own socket attribution ${mine[0]?.attribution} pid ${mine[0]?.pid} (expected socket/${process.pid})`)

          if (violations.length === 0) {
            // Not vacuous: the classic socket path and at least the service
            // inference path both occur on this host.
            const attrs = new Set(body.ports.map((e) => e.attribution))
            expect(attrs.has('socket')).toBe(true)
            expect(attrs.has('service')).toBe(true)
            expect(body.total).toBe(body.ports.length)
            expect(body.unattributedCount).toBe(body.ports.filter((e) => e.attribution === 'none').length)
            expect(body.inferredCount).toBe(
              body.ports.filter((e) => e.attribution === 'docker' || e.attribution === 'service').length,
            )
            if (scope === 'all') {
              const estab = body.ports.filter((e) => e.state === 'ESTABLISHED')
              expect(estab.length).toBeGreaterThan(0)
              expect(estab.every((e) => e.peerAddress !== null && e.peerPort !== null)).toBe(true)
            }
            return
          }
          lastDiff = { attempt, violations: violations.slice(0, 12) }
        }
        throw new Error(`attribution parity never converged: ${JSON.stringify(lastDiff)}`)
      } finally {
        own.stop(true)
      }
    }, 30_000)
  }

  test('envelope: user, runningAsRoot and collectedAt describe this process and this read', async () => {
    const t0 = Date.now()
    const { body } = await getJson('/api/system/ports')
    const t1 = Date.now()
    expect(body.scope).toBe('listening') // the default
    expect(body.user).toBe(userInfo().username)
    expect(body.runningAsRoot).toBe(process.geteuid?.() === 0)
    const at = Date.parse(body.collectedAt)
    expect(new Date(at).toISOString()).toBe(body.collectedAt)
    expect(at).toBeGreaterThanOrEqual(t0 - 5)
    expect(at).toBeLessThanOrEqual(t1 + 5)
  })

  test('a process whose comm contains `",pid=1` is attributed to its own pid, not to pid 1', async () => {
    // Any unprivileged process can set its own comm (prctl / /proc/self/comm),
    // and ss prints it unescaped inside users:((...)). Captured on this host:
    //   users:(("a",pid=1",pid=4025930,fd=4))
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `require('fs').writeFileSync('/proc/self/comm', 'a",pid=1');
         const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
         console.log(l.port); setTimeout(() => {}, 20000);`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    try {
      const reader = child.stdout.getReader()
      const { value } = await reader.read()
      const port = Number(new TextDecoder().decode(value).trim())
      expect(port).toBeGreaterThan(0)
      const raw = await runSs('-l')
      expect(raw).toContain(`pid=${child.pid},`) // ss itself does see the real pid
      const { body } = await getJson('/api/system/ports?scope=listening')
      const rows = body.ports.filter((e) => e.localPort === port && e.protocol === 'tcp')
      expect(rows.map((r) => ({ pid: r.pid, name: r.processName }))).toEqual([
        { pid: child.pid, name: 'a",pid=1' },
      ])
    } finally {
      child.kill('SIGKILL')
      await child.exited
    }
  }, 20_000)
})

// --- 2. IPv6 hex decoder vs ss, same inode ---------------------------------

describe.skipIf(!onLinuxWithSs)('real host, /proc/net/*6 decoder', () => {
  test('every tcp6/udp6 local address decodes to what ss prints for the same inode', async () => {
    // Guarantee IPv6 variety: a ::1 listener, a dual-stack :: listener and a
    // v4 client connected to it (whose tcp6 entry is v4-mapped).
    const lo6 = Bun.listen({ hostname: '::1', port: 0, socket: { data() {} } })
    const dual = Bun.listen({ hostname: '::', port: 0, socket: { data() {} } })
    const client = await Bun.connect({ hostname: '127.0.0.1', port: dual.port, socket: { data() {} } })
    try {
      await Bun.sleep(50)
      const ssText = await runSs('-a', ['-e'])
      const byInode = new Map<number, { address: string; port: number }>()
      for (const line of ssText.split('\n')) {
        const ino = /\bino:(\d+)/.exec(line)
        if (!ino) continue
        const f = line.trim().split(/\s+/)
        const local = splitRaw(f[4] ?? '')
        byInode.set(Number(ino[1]), { address: local.address, port: Number(local.port) })
      }
      const mismatches: string[] = []
      let compared = 0
      for (const [file, proto] of [
        ['/proc/net/tcp6', 'tcp'],
        ['/proc/net/udp6', 'udp'],
      ] as const) {
        for (const row of ports.parseProcNet(await readFile(file, 'utf8'), proto)) {
          const ss = byInode.get(row.inode)
          if (row.inode === 0 || !ss) continue
          compared++
          // Known, non-decoder differences: ss prints a dual-stack (v6only=0)
          // socket as `*`, and a SO_BINDTODEVICE zone that /proc/net does not
          // carry. Neither is information the hex column contains.
          const expected = ss.address === '*' ? '::' : ss.address.replace(/%.*$/, '')
          if (row.localAddress !== expected || row.localPort !== ss.port) {
            mismatches.push(`ino ${row.inode}: /proc -> ${row.localAddress}:${row.localPort}, ss -> ${ss.address}:${ss.port}`)
          }
        }
      }
      expect(compared).toBeGreaterThan(2)
      expect(mismatches).toEqual([])
    } finally {
      client.end()
      dual.stop(true)
      lo6.stop(true)
    }
  })
})

// --- 3. the /proc fallback, for real -----------------------------------------

describe.skipIf(!onLinuxWithSs)('real host, /proc fallback (ss absent from PATH)', () => {
  test('answers 200 from /proc, agrees with ss on listening sockets, and attributes the caller\'s own sockets', async () => {
    const { dir } = await fakeSsDir(null)
    let lastDiff: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const keyOf = (s: RawSocket) =>
        `${s.protocol}|${s.state}|${s.localAddress === '*' ? '::' : s.localAddress.replace(/%.*$/, '')}|${s.localPort}`
      const before = rawSockets(await runSs('-l')).map(keyOf)
      const result = await runChild(dir, { listen: true, batches: [['/api/system/ports?scope=listening']] })
      const after = rawSockets(await runSs('-l')).map(keyOf)
      const res = only(only(result.batches).responses)
      expect(res.status).toBe(200)
      expect(res.body.source).toBe('proc')
      assertRowInvariants(res.body)

      const own = res.body.ports.filter(
        (e) => e.localAddress === '127.0.0.1' && (e.localPort === result.tcpPort || e.localPort === result.udpPort),
      )
      expect(own.map((e) => `${e.protocol}|${e.state}|${e.pid}|${e.processName}|${e.processKnown}`).sort()).toEqual([
        `tcp|LISTEN|${result.pid}|bun|true`,
        `udp|UNCONN|${result.pid}|bun|true`,
      ])

      // Distinct socket keys, because ss and /proc each give one row per
      // (socket, process) and process visibility is identical (same uid).
      const got = [...new Set(res.body.ports.filter((e) => !own.includes(e)).map((e) => `${e.protocol}|${e.state}|${e.localAddress}|${e.localPort}`))]
      const stable = [...new Set(intersect(before, after))]
      const missing = stable.filter((k) => !got.includes(k))
      const unexplained = got.filter((k) => !before.includes(k) && !after.includes(k))
      if (missing.length === 0 && unexplained.length === 0) return
      lastDiff = { attempt, missing, unexplained }
    }
    throw new Error(`/proc vs ss parity never converged: ${JSON.stringify(lastDiff)}`)
  }, 60_000)

  test('scope=all from /proc includes ESTABLISHED rows with peers', async () => {
    const { dir } = await fakeSsDir(null)
    const result = await runChild(dir, { batches: [['/api/system/ports?scope=all']] })
    const res = only(only(result.batches).responses)
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('proc')
    assertRowInvariants(res.body)
    const estab = res.body.ports.filter((e) => e.state === 'ESTABLISHED')
    expect(estab.length).toBeGreaterThan(0)
    expect(estab.every((e) => e.peerAddress !== null && e.peerPort !== null)).toBe(true)
  }, 30_000)
})

// --- 4. fake ss failure modes: fallback, timing, 503 --------------------------

const FAILURE_MODES = {
  missing: null,
  nonzero: "echo 'ss: fake failure for tests' >&2; exit 3",
  garbage: "echo 'this is not ss output'; echo 'nor is this'; exit 0",
  // The sleep is a background grandchild holding stdout open, so the SIGKILL
  // of `sh` alone does not close the pipe — the worst case for the read.
  timeout: (pidFile: string) => `${SLEEP_BIN} 15 & echo $! > '${pidFile}'; wait`,
} as const

async function modeDir(mode: keyof typeof FAILURE_MODES) {
  if (mode === 'timeout') {
    const pidFile = join(scratch, `sleep-${dirSeq++}.pid`)
    orphanPidFiles.push(pidFile)
    return fakeSsDir(FAILURE_MODES.timeout(pidFile))
  }
  return fakeSsDir(FAILURE_MODES[mode])
}

describe.skipIf(!onLinuxWithSs)('ss failure modes fall back to /proc', () => {
  for (const mode of ['missing', 'nonzero', 'garbage', 'timeout'] as const) {
    test(`ss ${mode} -> 200 with source proc${mode === 'timeout' ? ', within ~5-8s, leaking no fd or child' : ''}`, async () => {
      const { dir } = await modeDir(mode)
      const result = await runChild(dir, { batches: [['/api/system/ports']] })
      const res = only(only(result.batches).responses)
      expect(res.status).toBe(200)
      expect(res.body.source).toBe('proc')
      expect(res.body.ports.length).toBeGreaterThan(0)
      assertRowInvariants(res.body)
      console.log(`[ports-verify] ss ${mode} fallback took ${res.ms}ms`)
      if (mode === 'timeout') {
        expect(res.ms).toBeGreaterThanOrEqual(4900)
        // 5s ss timeout + 300ms drain grace + at most the 2s /proc scan budget.
        expect(res.ms).toBeLessThan(8500)
        // The SIGKILLed ss (and its pipe, still held open by the orphaned
        // grandchild) leaves no fd behind in the backend and no live child.
        expect(result.footprintAfter.children).toEqual([])
        expect(result.footprintAfter.fds - result.footprintBefore.fds).toBeLessThanOrEqual(1)
      } else {
        expect(res.ms).toBeLessThan(4000)
      }
    }, 30_000)
  }

  test('ss exiting 0 with empty output is a real "no sockets" answer, not a fallback', async () => {
    const { dir } = await fakeSsDir('exit 0')
    const res = only(only((await runChild(dir, { batches: [['/api/system/ports']] })).batches).responses)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source: 'ss', total: 0, truncated: false, unattributedCount: 0, ports: [] })
  }, 30_000)
})

describe.skipIf(!onLinuxWithSs)('both readers failing -> 503', () => {
  const messages: Partial<Record<keyof typeof FAILURE_MODES, string>> = {}

  for (const mode of ['missing', 'nonzero', 'garbage', 'timeout'] as const) {
    test(`ss ${mode} + /proc/net unreadable -> 503 { error } naming both`, async () => {
      const { dir } = await modeDir(mode)
      const result = await runChild(dir, { breakProc: true, batches: [['/api/system/ports']] })
      const res = only(only(result.batches).responses)
      expect(res.status).toBe(503)
      expect(Object.keys(res.body)).toEqual(['error'])
      const msg = String(res.body.error)
      messages[mode] = msg
      console.log(`[ports-verify] 503 message (ss ${mode}, ${res.ms}ms): ${msg}`)
      expect(msg).toContain('`ss`')
      expect(msg).toContain('/proc/net/{tcp,tcp6,udp,udp6} could not be read (EACCES)')
      if (mode === 'nonzero') expect(msg).toContain('ss: fake failure for tests')
      if (mode === 'timeout') expect(res.ms).toBeLessThan(8500)
    }, 30_000)
  }

  test('no 503 message leaks a bare null/undefined, and a timeout says it timed out', () => {
    // Runs after the four above have captured their messages.
    for (const [mode, msg] of Object.entries(messages)) {
      expect({ mode, msg: /\b(null|undefined)\b/.test(msg ?? '') }).toEqual({ mode, msg: false })
    }
    expect(messages.timeout ?? '').toMatch(/timed out|timeout|killed/i)
  })
})

// --- 5. argv, read-only, validation, dedup (fake ss that logs its argv) ------

describe.skipIf(!onLinuxWithSs)('argv actually spawned, query validation, dedup', () => {
  let result: ChildResult
  const argvRuns = (log: string | null) =>
    (log ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('|'))

  beforeAll(async () => {
    await assertFixturePreconditions()
    const fixture = join(scratch, 'canned-ss.txt')
    await writeFile(fixture, `${await cannedSs()}\n`)
    const { dir, log } = await fakeSsDir(`${SLEEP_BIN} 0.5; ${CAT_BIN} '${fixture}'; exit 0`)
    result = await runChild(dir, {
      logFile: log,
      batches: [
        ['/api/system/ports'], // 0: default scope
        ['/api/system/ports?scope=listening'], // 1
        ['/api/system/ports?scope=all'], // 2
        ['/api/system/ports?scope=all&x=-K&kill=1&diag=-D'], // 3: extra params ignored
        ['/api/system/ports?scope=-K'], // 4
        ['/api/system/ports?scope=ALL'], // 5
        ['/api/system/ports?scope='], // 6
        ['/api/system/ports?scope=listening%20-K'], // 7
        ['/api/system/ports?scope=all', '/api/system/ports?scope=all'], // 8: concurrent, same scope
        ['/api/system/ports?scope=all', '/api/system/ports?scope=listening'], // 9: concurrent, different scopes
        ['/api/system/ports?scope=all&scope=-K'], // 10: repeated param
        ['/api/openapi.json'], // 11
      ],
    })
  }, 60_000)

  const spawnsIn = (i: number) =>
    argvRuns(result.batches[i]?.log ?? '').length - (i === 0 ? 0 : argvRuns(result.batches[i - 1]?.log ?? '').length)
  const lastArgv = (i: number, n = 1) => argvRuns(result.batches[i]?.log ?? '').slice(-n)

  test('SS_ARGS is exactly the two fixed read-only argv arrays, with no -p', () => {
    expect(ports.SS_ARGS).toEqual({
      listening: ['ss', '-H', '-t', '-u', '-n', '-e', '-l'],
      all: ['ss', '-H', '-t', '-u', '-n', '-e', '-a'],
    })
    // Whitelist, independent of the exact arrays above: nothing that closes a
    // socket (-K/--kill), writes a dump (-D/--diag), reads a filter file (-F),
    // or asks ss to print a process's self-chosen comm (-p/--processes).
    for (const argv of Object.values(ports.SS_ARGS)) {
      const forbidden = argv.filter((a) => /^(-K|--kill|-D|--diag|-F|--filter|-p|--processes)$/.test(a) || /^-[a-zA-Z]*[KDFp]/.test(a))
      expect({ argv, forbidden }).toEqual({ argv, forbidden: [] })
    }
  })

  test('ports.ts has exactly one process spawn (Bun.spawn(argv), argv = SS_ARGS[scope]) and no write API', async () => {
    const src = await readFile(join(BACKEND_DIR, 'src/features/system/ports.ts'), 'utf8')
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code.match(/\bBun\.spawn(Sync)?\s*\(/g)).toEqual(['Bun.spawn('])
    expect(code).toMatch(/const argv = SS_ARGS\[scope\]/)
    expect(code).toMatch(/Bun\.spawn\(argv,/)
    for (const forbidden of [
      /child_process/, /\bBun\.\$/, /(?<![.\w])exec(Sync|File|FileSync)?\s*\(/ /* not RegExp#exec */, /\bspawnSync\b/, /\bshell\s*:/,
      /\bwriteFile\b/, /\bappendFile\b/, /\bBun\.write\b/, /\bcreateWriteStream\b/, /\b(unlink|rm|rmdir|mkdir|rename|truncate|chmod|chown)\s*\(/,
      /process\.kill\b/, /['"]-K['"]|--kill|['"]-D['"]|--diag|['"]-F['"]/,
    ]) {
      expect({ forbidden: String(forbidden), found: forbidden.test(code) }).toEqual({ forbidden: String(forbidden), found: false })
    }
    expect(code.match(/import \{([^}]*)\} from 'node:fs\/promises'/)?.[1]?.split(',').map((x) => x.trim()).sort()).toEqual([
      'readFile', 'readdir', 'readlink',
    ])
    // The route hands getPorts only the validated enum value.
    const routes = await readFile(join(BACKEND_DIR, 'src/features/system/routes.ts'), 'utf8')
    expect(routes).toContain("getPorts(c.req.valid('query').scope)")
  })

  test('the spawned argv is exactly the constant for the scope, whatever else was in the query', () => {
    const L = ports.SS_ARGS.listening.slice(1)
    const A = ports.SS_ARGS.all.slice(1)
    for (const [i, argv] of [[0, L], [1, L], [2, A], [3, A]] as const) {
      expect(result.batches[i]?.responses[0]?.status).toBe(200)
      expect(spawnsIn(i)).toBe(1)
      expect(lastArgv(i)).toEqual([argv])
    }
    // Nothing ever spawned carried a flag outside the two constants.
    const every = argvRuns(result.batches.at(-1)?.log ?? '').flat()
    // `-p` is no longer on the list: an spawned argv carrying it would fail here.
    expect(every.length).toBeGreaterThan(0)
    expect(every.filter((a) => !['-H', '-t', '-u', '-n', '-e', '-l', '-a'].includes(a))).toEqual([])
  })

  test('an invalid scope is a 400 in the standard error envelope and spawns nothing', () => {
    for (const i of [4, 5, 6, 7]) {
      const res = result.batches[i]?.responses[0]
      expect({ i, status: res?.status }).toEqual({ i, status: 400 })
      expect(typeof (res?.body as { error?: unknown }).error).toBe('string')
      expect(spawnsIn(i)).toBe(0)
    }
  })

  test('a repeated scope param resolves to one fixed argv or a 400, never a mix', () => {
    const res = result.batches[10]?.responses[0]
    console.log(`[ports-verify] ?scope=all&scope=-K -> ${res?.status}`)
    if (res?.status === 200) expect(lastArgv(10)).toEqual([ports.SS_ARGS.all.slice(1)])
    else {
      expect(res?.status).toBe(400)
      expect(spawnsIn(10)).toBe(0)
    }
  })

  test('two concurrent requests for the same scope spawn ss once and get the same read', () => {
    const [a, b] = result.batches[8]?.responses ?? []
    expect(a?.status).toBe(200)
    expect(b?.status).toBe(200)
    expect(spawnsIn(8)).toBe(1)
    expect(a?.body.collectedAt).toBe(b?.body.collectedAt as string)
  })

  test('concurrent requests for different scopes spawn once each', () => {
    expect(spawnsIn(9)).toBe(2)
    expect(lastArgv(9, 2).sort()).toEqual([ports.SS_ARGS.all.slice(1), ports.SS_ARGS.listening.slice(1)].sort())
  })

  test('sequential requests re-read (no TTL cache)', () => {
    expect(spawnsIn(1)).toBe(1)
    expect(spawnsIn(2)).toBe(1)
    const c1 = result.batches[1]?.responses[0]?.body.collectedAt
    const c0 = result.batches[0]?.responses[0]?.body.collectedAt
    expect(c1).not.toBe(c0)
  })

  test('the canned ss output comes back as the documented rows', async () => {
    const body = result.batches[1]?.responses[0]?.body as Body
    expect(body.source).toBe('ss')
    const me = userInfo().username
    const name = await realComm(process.pid)
    expect(typeof name).toBe('string')
    const base = { peerAddress: null, peerPort: null, container: null }
    expect(body.ports).toEqual([
      { protocol: 'udp', localAddress: '127.0.0.53%lo', localPort: 53, state: 'UNCONN', ...base, pid: null, processName: 'unknown', processKnown: false, attribution: 'none', unit: null, owner: null },
      // Attributed purely by inode: the child endpoint found OUR pid holding it.
      { protocol: 'tcp', localAddress: '127.0.0.1', localPort: 8000, state: 'LISTEN', ...base, pid: process.pid, processName: name, processKnown: true, attribution: 'socket', unit: FIXTURE_UNIT, owner: me },
      // users:(...) on the line: no pid at all — not 4242, not our real pid —
      // and owner/unit are not taken from the dropped tail either.
      { protocol: 'tcp', localAddress: '127.0.0.1', localPort: 8001, state: 'LISTEN', ...base, pid: null, processName: 'unknown', processKnown: false, attribution: 'none', unit: null, owner: null },
      { protocol: 'tcp', localAddress: '127.0.0.1', localPort: 8002, state: 'LISTEN', ...base, pid: null, processName: 'unknown', processKnown: false, attribution: 'none', unit: FIXTURE_UNIT, owner: me },
    ])
    expect(body.unattributedCount).toBe(3)
    expect(body.inferredCount).toBe(0)
  })

  test('openapi documents /api/system/ports with scope enum and 200/400/503', async () => {
    const doc = result.batches[11]?.responses[0]?.body as unknown as {
      paths: Record<string, { get?: { parameters?: Array<{ name: string; in: string; schema?: { enum?: string[] } }>; responses: Record<string, unknown> } }>
    }
    const op = doc.paths['/api/system/ports']?.get
    expect(Object.keys(op?.responses ?? {}).sort()).toEqual(['200', '400', '503'])
    const scope = op?.parameters?.find((p) => p.name === 'scope')
    expect(scope?.in).toBe('query')
    expect(scope?.schema?.enum?.sort()).toEqual(['all', 'listening'])

    // The checked-out openapi.json (git-ignored, regenerated by pre-push) too, if present.
    const file = Bun.file(join(BACKEND_DIR, 'openapi.json'))
    if (await file.exists()) {
      const onDisk = (await file.json()) as typeof doc
      expect(Object.keys(onDisk.paths['/api/system/ports']?.get?.responses ?? {}).sort()).toEqual(['200', '400', '503'])
    }
  })
})

describe.skipIf(!onLinuxWithSs)('safe to call repeatedly (real ss)', () => {
  test('30 sequential + 2x5 concurrent requests: all 200, no fd growth, no leftover children', async () => {
    const ssDir = (SS_BIN as string).replace(/\/ss$/, '')
    const seq = Array.from({ length: 30 }, (_, i) => [`/api/system/ports?scope=${i % 2 ? 'all' : 'listening'}`])
    const burst = Array.from({ length: 5 }, () => '/api/system/ports?scope=all')
    const burst2 = Array.from({ length: 5 }, () => '/api/system/ports?scope=listening')
    const result = await runChild(ssDir, { batches: [...seq, burst, burst2] })
    const all = result.batches.flatMap((b) => b.responses)
    expect(all.filter((r) => r.status !== 200 || r.body.source !== 'ss')).toEqual([])
    // Each burst shared a single read.
    for (const b of result.batches.slice(-2)) {
      expect(new Set(b.responses.map((r) => r.body.collectedAt)).size).toBe(1)
    }
    expect(result.footprintAfter.children).toEqual([])
    expect(result.footprintAfter.fds - result.footprintBefore.fds).toBeLessThanOrEqual(2)
    console.log(`[ports-verify] fds before ${result.footprintBefore.fds}, after ${result.footprintAfter.fds}; slowest ${Math.max(...all.map((r) => r.ms))}ms`)
  }, 60_000)
})

// --- 6. truncation, end to end ----------------------------------------------

describe.skipIf(!onLinuxWithSs)('truncation at MAX_ROWS', () => {
  test('6000 sockets -> 5000 rows, total 6000, LISTEN kept first, unattributedCount over returned rows', async () => {
    // 5000 ESTAB first in the file (ports 20000..24999; those >= 24000 are
    // unattributed), then 1000 LISTEN on high ports 60000..60999, unattributed.
    // Correct: LISTEN sorts first despite higher ports and later position, so
    // the 1000 dropped rows are ESTAB 24000..24999 — exactly the unattributed
    // ESTAB ones. unattributedCount must then be 1000, not 2000.
    // New `-e` shape: "attributed" means the line names our held inode (the
    // child's /proc scan finds this pid); "unattributed" names an inode no
    // visible process holds, in a unit with no cgroup to fall back on.
    await assertFixturePreconditions()
    const h = await heldSocket()
    const uid = userInfo().uid
    const lines: string[] = []
    for (let i = 0; i < 5000; i++) {
      const port = 20000 + i
      const ino = port >= 24000 ? UNHELD_INODE : h.inode
      lines.push(`tcp ESTAB 0 0 10.0.0.1:${port} 10.0.0.2:443 uid:${uid} ino:${ino} sk:${(i + 1).toString(16)} cgroup:/system.slice/${FIXTURE_UNIT} <->`)
    }
    for (let i = 0; i < 1000; i++) {
      lines.push(`tcp LISTEN 0 128 0.0.0.0:${60000 + i} 0.0.0.0:* uid:${uid} ino:${UNHELD_INODE} sk:${(9000 + i).toString(16)} cgroup:/system.slice/${FIXTURE_UNIT} <->`)
    }
    const fixture = join(scratch, 'ss-6000.txt')
    await writeFile(fixture, `${lines.join('\n')}\n`)
    const { dir } = await fakeSsDir(`${CAT_BIN} '${fixture}'; exit 0`)

    const res = only(only((await runChild(dir, { batches: [['/api/system/ports?scope=all']] })).batches).responses)
    const body = res.body
    expect(res.status).toBe(200)
    expect(body.source).toBe('ss')
    expect(body.total).toBe(6000)
    expect(body.truncated).toBe(true)
    expect(body.ports).toHaveLength(ports.MAX_ROWS)
    expect(body.ports.slice(0, 1000).every((e) => e.state === 'LISTEN')).toBe(true)
    expect(body.ports[0]?.localPort).toBe(60000)
    expect(body.ports[999]?.localPort).toBe(60999)
    expect(body.ports[1000]).toMatchObject({ state: 'ESTABLISHED', localPort: 20000 })
    expect(body.ports.at(-1)).toMatchObject({ state: 'ESTABLISHED', localPort: 23999 })
    expect(body.unattributedCount).toBe(1000)
    // Every kept ESTAB row is ours, by inode; every LISTEN row is nobody's.
    expect(body.ports.slice(1000).filter((e) => e.attribution !== 'socket' || e.pid !== process.pid)).toEqual([])
    expect(body.ports.slice(0, 1000).filter((e) => e.attribution !== 'none' || e.pid !== null)).toEqual([])
    expect(portsResponseSchema.safeParse(body).success).toBe(true)
  }, 30_000)
})

// --- 7. parser edge cases ------------------------------------------------------

describe('parseSsOutput edge cases', () => {
  const one = (line: string) => ports.parseSsOutput(line)

  test('`*:port` dual-stack local keeps `*` as the address', () => {
    // Re-expressed in the -e shape (the old fixture carried a users: column,
    // which now drops the tail and so no longer exercises the address path
    // alongside real -e facts).
    expect(one('tcp LISTEN 0 128 *:51233 *:* uid:999 ino:5 sk:1 cgroup:/system.slice/x.service <->')).toEqual([
      { protocol: 'tcp', localAddress: '*', localPort: 51233, peerAddress: null, peerPort: null, state: 'LISTEN', pid: null, processName: 'unknown', processKnown: false, attribution: 'none', unit: 'x.service', container: null, owner: '999' },
    ])
  })

  test('v4-mapped bracketed address on both sides', () => {
    expect(one('tcp ESTAB 0 0 [::ffff:127.0.0.1]:80 [::ffff:127.0.0.1]:41002')[0]).toMatchObject({
      localAddress: '::ffff:127.0.0.1', localPort: 80, peerAddress: '::ffff:127.0.0.1', peerPort: 41002, state: 'ESTABLISHED',
    })
  })

  test('bracketed link-local with a %zone after the bracket', () => {
    expect(one('udp UNCONN 0 0 [fe80::1]%eth0:546 [::]:*')[0]).toMatchObject({
      localAddress: 'fe80::1%eth0', localPort: 546, peerAddress: null, peerPort: null,
    })
  })

  test('ports 0 and 65535 are accepted, 65536 is not', () => {
    expect(one('tcp ESTAB 0 0 127.0.0.1:0 127.0.0.1:65535')[0]).toMatchObject({ localPort: 0, peerPort: 65535 })
    expect(one('tcp LISTEN 0 1 127.0.0.1:65535 0.0.0.0:*')[0]?.localPort).toBe(65535)
    expect(one('tcp LISTEN 0 1 127.0.0.1:65536 0.0.0.0:*')).toEqual([])
  })

  test('a 5-field line (no peer column) is skipped without taking its neighbours with it', () => {
    const rows = ports.parseSsOutput(['tcp LISTEN 0 128 127.0.0.1:80', 'tcp LISTEN 0 128 127.0.0.1:81 0.0.0.0:*'].join('\n'))
    expect(rows.map((r) => r.localPort)).toEqual([81])
  })

  test('Windows line endings parse the same as \\n', () => {
    // -e shape, so a trailing \r would have to survive into the tail to break
    // it: the facts on both lines must be identical either way.
    const lf = 'tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* uid:999 ino:7 sk:1 cgroup:/system.slice/a.service <->\nudp UNCONN 0 0 [::1]:323 [::]:* ino:8 sk:2 cgroup:/system.slice/chrony.service v6only:1 <->\n'
    expect(ports.parseSsOutput(lf.replaceAll('\n', '\r\n'))).toEqual(ports.parseSsOutput(lf))
    expect(ports.parseSsOutput(lf).map((r) => [r.localPort, r.owner, r.unit])).toEqual([
      [80, '999', 'a.service'],
      [323, 'root', 'chrony.service'],
    ])
  })

  test('an empty users:(()) column is one unknown row', () => {
    expect(one('tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(())')).toEqual([
      { protocol: 'tcp', localAddress: '127.0.0.1', localPort: 80, peerAddress: null, peerPort: null, state: 'LISTEN', pid: null, processName: 'unknown', processKnown: false, attribution: 'none', unit: null, container: null, owner: null },
    ])
  })

  // The four tests below used to pin how the (now deleted) users:(...) tiler
  // EXTRACTED a comm/pid from text. The parser no longer extracts anything
  // from that column: a line carrying one keeps its row but loses every -e
  // fact, so no pid at all — never the genuine one printed there, never the
  // forged one. The property they protected (a comm's bytes cannot move a
  // pid, and the real holder is named with its real comm) is now re-checked
  // against real processes in 'comm bytes never reach a parser' below.
  const dropped = (line: string) =>
    one(line).map((r) => ({ port: r.localPort, pid: r.pid, name: r.processName, attribution: r.attribution, owner: r.owner, unit: r.unit }))
  const DROPPED_ROW = (port: number) => ({ port, pid: null, name: 'unknown', attribution: 'none', owner: null, unit: null })
  const TAIL = 'uid:999 ino:77 sk:1 cgroup:/system.slice/a.service <->'

  test('users: column with a comm containing `),(` or `pid=`: row kept, no pid, no facts', () => {
    expect(dropped(`tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(("x),(y",pid=5,fd=3)) ${TAIL}`)).toEqual([DROPPED_ROW(80)])
    expect(dropped(`tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(("pid=9",pid=5,fd=3)) ${TAIL}`)).toEqual([DROPPED_ROW(80)])
  })

  test('users: column with a comm containing a double quote: row kept, no pid, no facts', () => {
    expect(dropped(`tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(("a"b",pid=5,fd=3)) ${TAIL}`)).toEqual([DROPPED_ROW(80)])
  })

  test('users: column `a",pid=1` (line captured from this host): row kept, never pid 1, never the printed pid', () => {
    const line = `tcp UNCONN 0 0 127.0.0.1:41285 0.0.0.0:* users:(("a",pid=1",pid=4025930,fd=4)) ${TAIL}`
    expect(dropped(line)).toEqual([DROPPED_ROW(41285)])
  })

  test('users: column listing one pid on two fds, and a second socket: one row per LINE, none with a pid', () => {
    const rows = ports.parseSsOutput(
      [
        `tcp LISTEN 0 1 0.0.0.0:80 0.0.0.0:* users:(("n",pid=7,fd=3),("n",pid=7,fd=9)) ${TAIL}`,
        `tcp LISTEN 0 1 0.0.0.0:80 0.0.0.0:* users:(("n",pid=7,fd=4)) ${TAIL}`,
      ].join('\n'),
    )
    expect(rows.map((r) => [r.pid, r.owner, r.unit])).toEqual([
      [null, null, null],
      [null, null, null],
    ])
  })
})

// --- 8. comm bytes never reach a parser (real processes) ----------------------
// The real-process half of the users:(...) tests above. Each process sets its
// own comm (prctl PR_SET_NAME, bytes passed as hex so nothing is re-encoded on
// the way), binds on 127.0.0.1, and the endpoint must name it with its REAL
// pid and the byte-exact /proc/<pid>/comm — not `none`, since the fd is ours
// and readable, and never another pid. PR_SET_PDEATHSIG so nothing outlives
// the runner.

const COMM_CHILD = `
import ctypes, os, socket, sys, time
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(1, 9, 0, 0, 0)
libc.prctl(15, ctypes.c_char_p(bytes.fromhex(sys.argv[1])), 0, 0, 0)
mode = sys.argv[2]
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
if mode == "dup":
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
s.bind(("127.0.0.1", 0)); s.listen()
port = s.getsockname()[1]
keep = []
if mode == "dup":
    keep.append(os.dup(s.fileno())); keep.append(os.dup(s.fileno()))
    s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s2.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    s2.bind(("127.0.0.1", port)); s2.listen(); keep.append(s2)
print(port, flush=True)
time.sleep(60)
`

async function spawnComm(comm: string, mode: 'one' | 'dup' = 'one') {
  const proc = Bun.spawn([PYTHON as string, '-c', COMM_CHILD, Buffer.from(comm, 'utf8').toString('hex'), mode], { stdout: 'pipe', stderr: 'ignore' })
  const reader = proc.stdout.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const port = Number(buf.trim())
  if (!(port > 0)) throw new Error(`comm child did not start: ${JSON.stringify(buf)}`)
  return { pid: proc.pid, port, kill: async () => { proc.kill('SIGKILL'); await proc.exited } }
}

describe.skipIf(!onLinuxWithSs || PYTHON === null)('comm bytes never reach a parser (real processes)', () => {
  test('comms `x),(y`, `pid=9`, `a"b`, `a",pid=1`: socket, real pid, byte-exact comm', async () => {
    const children: Array<Awaited<ReturnType<typeof spawnComm>> & { comm: string }> = []
    try {
      for (const comm of ['x),(y', 'pid=9', 'a"b', 'a",pid=1']) children.push({ ...(await spawnComm(comm)), comm })
      const { status, body } = await getJson('/api/system/ports?scope=listening')
      expect(status).toBe(200)
      const got = children.map((c) => ({
        comm: c.comm,
        rows: body.ports
          .filter((e) => e.protocol === 'tcp' && e.localAddress === '127.0.0.1' && e.localPort === c.port)
          .map((e) => ({ pid: e.pid, name: e.processName, attribution: e.attribution })),
      }))
      const want = await Promise.all(
        children.map(async (c) => ({ comm: c.comm, rows: [{ pid: c.pid, name: (await realComm(c.pid)) as string, attribution: 'socket' }] })),
      )
      // Delivered as intended: the kernel holds exactly the comm we asked for.
      expect(want.map((w) => w.rows[0]?.name)).toEqual(children.map((c) => c.comm))
      expect(got).toEqual(want)
      // And no row anywhere names pid 1 or 5 as a socket holder on these ports.
      const ours = new Set(children.map((c) => c.port))
      expect(body.ports.filter((e) => ours.has(e.localPort) && e.pid !== null && !children.some((c) => c.pid === e.pid))).toEqual([])
    } finally {
      for (const c of children) await c.kill()
    }
  }, 30_000)

  test('one pid on three fds of one socket is one row; a second socket on the same port is a second row', async () => {
    const c = await spawnComm('dup  holder', 'dup')
    try {
      // Independent truth: /proc/net/tcp's inodes for this port, then the fd
      // table — 3 fds on one, 1 on the other. (Filtered by port because the
      // child's stdout pipe is itself a unix socketpair.)
      const want = `0100007F:${c.port.toString(16).toUpperCase().padStart(4, '0')}`
      const onPort = new Set(
        (await readFile('/proc/net/tcp', 'utf8'))
          .split('\n')
          .map((r) => r.trim().split(/\s+/))
          .filter((f) => f[1] === want && f[3] === '0A')
          .map((f) => Number(f[9])),
      )
      const inodes = [...(await socketInodesOf(c.pid)).values()].filter((i) => onPort.has(i))
      const perInode = [...countMap(inodes.map(String)).values()].sort()
      expect({ onPort: onPort.size, perInode }).toEqual({ onPort: 2, perInode: [1, 3] })
      const { body } = await getJson('/api/system/ports?scope=listening')
      const rows = body.ports
        .filter((e) => e.protocol === 'tcp' && e.localAddress === '127.0.0.1' && e.localPort === c.port)
        .map((e) => ({ pid: e.pid, name: e.processName, attribution: e.attribution }))
      const one = { pid: c.pid, name: 'dup  holder', attribution: 'socket' }
      expect(rows).toEqual([one, one])
    } finally {
      await c.kill()
    }
  }, 30_000)
})
