// Final verification of the inode redesign of GET /api/system/ports
// (backend/src/features/system/ports.ts): `ss -H -t -u -n -e {-l|-a}` with no
// `-p`, sockets attributed by `ino:<n>` plus a /proc/*/fd scan, names read
// from /proc/<pid>/comm. The property:
//
//   No socket is attributed to a pid that does not hold it, no row is
//   fabricated, and no socket is hidden by a process name.
//
// Every expectation here is derived WITHOUT the module under test: this
// file's own `ss -e` reader, its own /proc/*/fd scan (the same uid-scoped view
// the endpoint has, since both run as this account), /proc/<pid>/comm read as
// bytes, cgroup.procs + PPid for a unit's main process, /proc for genuine
// docker-proxies, and `docker ps` for container names.
//
// Host churn: every host-wide comparison takes an ss + fd snapshot before AND
// after the request and only holds the endpoint to sockets that were identical
// in both; counts get a tolerance equal to what actually churned between them
// (plus a small constant). Each such check retries up to 3 times before
// failing, and reports the last difference.
//
// Needs Linux + iproute2 `ss` + python3 (skipped otherwise). Every python
// helper sets PR_SET_PDEATHSIG(SIGKILL) and is SIGKILLed in its test's finally
// and again in afterAll.

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { OpenAPIHono } from '@hono/zod-openapi'

const { portsResponseSchema } = await import('../src/features/system/schema')
const { systemRouter } = await import('../src/features/system/routes')
const { openApiValidationHook } = await import('../src/lib/openapi-hook')
const { AppError, errorBody } = await import('../src/lib/errors')
type PortEntry = import('../src/features/system/ports').PortEntry

const SS_BIN = process.platform === 'linux' ? Bun.which('ss') : null
const PYTHON = Bun.which('python3')
const DOCKER = Bun.which('docker')
const canRun = SS_BIN !== null && PYTHON !== null

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', systemRouter)
app.onError((error, c) =>
  error instanceof AppError
    ? c.json(errorBody(error), error.status as 400)
    : c.json({ error: 'Internal server error' }, 500),
)

type Scope = 'listening' | 'all'
type Body = { source: string; total: number; truncated: boolean; ports: PortEntry[] }

async function getBody(scope: Scope): Promise<Body> {
  const res = await app.request(`/api/system/ports?scope=${scope}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Body
  expect(body.source).toBe('ss')
  const parsed = portsResponseSchema.safeParse(body)
  expect(parsed.success ? null : parsed.error.issues.slice(0, 3)).toBeNull()
  expect(body.truncated).toBe(false) // every comparison below assumes the whole table
  return body
}

// --- independent ground truth ------------------------------------------------

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** /proc/<pid>/comm minus its one trailing newline, decoded as UTF-8 — the
 * same decode JSON has to apply, so a valid-UTF-8 comm compares byte-exact. */
async function realComm(pid: number): Promise<string | null> {
  const raw = await readText(`/proc/${pid}/comm`)
  if (raw === null) return null
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

/** inode -> sorted holder pids, for every pid whose fd table this account can
 * read. Deliberately a different shape from the module's own scan (no budget,
 * no inode filter): every socket fd of every visible pid. */
async function fdScan(): Promise<Map<number, number[]>> {
  const out = new Map<number, Set<number>>()
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let fds: string[]
    try {
      fds = await readdir(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let link: string
      try {
        link = await readlink(`/proc/${entry}/fd/${fd}`)
      } catch {
        continue
      }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (!m) continue
      const ino = Number(m[1])
      if (!out.has(ino)) out.set(ino, new Set())
      out.get(ino)?.add(Number(entry))
    }
  }
  return new Map([...out].map(([ino, pids]) => [ino, [...pids].sort((a, b) => a - b)]))
}

interface SsSocket {
  key: string
  protocol: string
  state: string
  localAddress: string
  localPort: number
  peerAddress: string | null
  peerPort: number | null
  ino: number
  uid: number | null
  cgroup: string | null
}

function splitAddr(field: string): { address: string; port: string } {
  const m = /^\[(.+)\](%[^:]+)?:([^:]+)$/.exec(field)
  if (m) return { address: `${m[1]}${m[2] ?? ''}`, port: m[3] ?? '' }
  const i = field.lastIndexOf(':')
  return { address: field.slice(0, i), port: field.slice(i + 1) }
}

const keyOf = (s: Pick<PortEntry, 'protocol' | 'state' | 'localAddress' | 'localPort' | 'peerAddress' | 'peerPort'>) =>
  `${s.protocol}|${s.state}|${s.localAddress}|${s.localPort}|${s.peerAddress}|${s.peerPort}`

/** Exactly the argv the endpoint spawns, read with this file's own parser.
 * Safe to split on whitespace: without -p no process text is in the line. */
async function ssE(scope: Scope): Promise<SsSocket[]> {
  const proc = Bun.spawn([SS_BIN as string, '-H', '-t', '-u', '-n', '-e', scope === 'all' ? '-a' : '-l'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  const out: SsSocket[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const f = line.trim().split(/\s+/)
    const local = splitAddr(f[4] ?? '')
    const peer = splitAddr(f[5] ?? '')
    const peerWild = peer.address === '*' || ((peer.address === '0.0.0.0' || peer.address === '::') && (peer.port === '*' || peer.port === '0'))
    const tail = f.slice(6).join(' ')
    const s = {
      protocol: (f[0] ?? '').toLowerCase(),
      state: (f[1] ?? '').toUpperCase() === 'ESTAB' ? 'ESTABLISHED' : (f[1] ?? '').toUpperCase(),
      localAddress: local.address,
      localPort: Number(local.port),
      peerAddress: peerWild ? null : peer.address,
      peerPort: peerWild || peer.port === '*' ? null : Number(peer.port),
      ino: Number(/(?:^| )ino:(\d+)/.exec(tail)?.[1] ?? Number.NaN),
      uid: /(?:^| )uid:(\d+)/.test(tail) ? Number(/(?:^| )uid:(\d+)/.exec(tail)?.[1]) : null,
      cgroup: /(?:^| )cgroup:(\S+)/.exec(tail)?.[1] ?? null,
    }
    out.push({ ...s, key: keyOf(s) })
  }
  return out
}

interface Snapshot {
  sockets: SsSocket[]
  holders: Map<number, number[]>
}

async function snapshot(scope: Scope): Promise<Snapshot> {
  const sockets = await ssE(scope)
  return { sockets, holders: await fdScan() }
}

/** Per key: sorted list of "inode:holders" signatures — the thing the
 * endpoint's rows for that key must be explained by. */
function signatures(snap: Snapshot): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const s of snap.sockets) {
    const h = s.ino > 0 ? (snap.holders.get(s.ino) ?? []) : []
    if (!out.has(s.key)) out.set(s.key, [])
    out.get(s.key)?.push(`${s.ino}:${h.join(',')}`)
  }
  for (const v of out.values()) v.sort()
  return out
}

/**
 * The per-socket parity check, for every key whose sockets AND holders were
 * identical in both snapshots:
 *   - `socket` rows' pid multiset == the multiset union of the holders of the
 *     key's inodes (so: the right pids, one row per (socket, holder));
 *   - every other row is one inode that had NO visible holder, one row each;
 *   - every `socket` row's name is that pid's /proc comm, byte-exact.
 * Returns violations, plus stats for the report.
 */
async function parityViolations(body: Body, before: Snapshot, after: Snapshot) {
  const sb = signatures(before)
  const sa = signatures(after)
  const rowsByKey = new Map<string, PortEntry[]>()
  for (const r of body.ports) {
    const k = keyOf(r)
    if (!rowsByKey.has(k)) rowsByKey.set(k, [])
    rowsByKey.get(k)?.push(r)
  }
  const violations: unknown[] = []
  let stableKeys = 0
  let socketRowsChecked = 0
  for (const [k, sig] of sb) {
    if (JSON.stringify(sa.get(k)) !== JSON.stringify(sig)) continue // churned
    stableKeys++
    const rows = rowsByKey.get(k) ?? []
    const inodes = sig.map((x) => x.split(':'))
    const wantPids = inodes.flatMap(([, h]) => (h ? h.split(',').map(Number) : [])).sort((a, b) => a - b)
    const wantUnheld = inodes.filter(([, h]) => !h).length
    const gotPids = rows.filter((r) => r.attribution === 'socket').map((r) => r.pid as number).sort((a, b) => a - b)
    const gotOther = rows.filter((r) => r.attribution !== 'socket').length
    if (JSON.stringify(gotPids) !== JSON.stringify(wantPids) || gotOther !== wantUnheld) {
      violations.push({ key: k, sig, rows: rows.map((r) => ({ pid: r.pid, name: r.processName, attribution: r.attribution })) })
      continue
    }
    for (const r of rows.filter((r) => r.attribution === 'socket')) {
      socketRowsChecked++
      const live = await realComm(r.pid as number)
      if (live !== null && live !== r.processName) violations.push({ key: k, pid: r.pid, name: r.processName, comm: live })
    }
  }
  // No row may exist for a key neither snapshot had at all (fabrication).
  const known = new Set([...sb.keys(), ...sa.keys()])
  const unexplained = body.ports.filter((r) => !known.has(keyOf(r)))
  for (const r of unexplained) violations.push({ unexplainedRow: keyOf(r), pid: r.pid, name: r.processName })
  return { violations, stableKeys, socketRowsChecked, unexplained: unexplained.length }
}

/** Retry a host-wide check up to 3 times, since only sockets that held still
 * for a whole request can be compared at all. */
async function converge<T extends { violations: unknown[] }>(label: string, attempt: () => Promise<T>): Promise<T> {
  let last: T | null = null
  for (let i = 0; i < 3; i++) {
    last = await attempt()
    if (last.violations.length === 0) return last
  }
  throw new Error(`${label}: never converged; last: ${JSON.stringify({ ...last, violations: last?.violations.slice(0, 8) })}`)
}

// --- processes with crafted comms --------------------------------------------

// argv: <mode> <hex comm>... . Every process renames itself (PR_SET_NAME) to
// its own comm; PR_SET_PDEATHSIG(SIGKILL) everywhere.
//   shared — one tcp listener, then one forked child per extra comm (all hold
//            it). Prints "<port> <pid0> <pid1>...".
//   udp    — one udp socket on 127.0.0.1:0. Prints "<port> <pid>".
//   conn   — a listener L held by the parent; a forked child closes L and
//            connects to it; the parent accepts. Three sockets, three distinct
//            holder sets (L: parent; accepted: parent; client: child).
//            Prints "<lport> <cport> <parent> <child>".
const HELPER = `
import ctypes, os, socket, sys, time
libc = ctypes.CDLL("libc.so.6", use_errno=True)
def rename(b): libc.prctl(15, ctypes.c_char_p(b), 0, 0, 0)
libc.prctl(1, 9, 0, 0, 0)
mode = sys.argv[1]
names = [bytes.fromhex(h) for h in sys.argv[2:]]
if mode == "shared":
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0)); s.listen()
    r, w = os.pipe(); pids = [os.getpid()]
    for n in names[1:]:
        pid = os.fork()
        if pid == 0:
            libc.prctl(1, 9, 0, 0, 0); rename(n); os.write(w, b"x"); time.sleep(90); os._exit(0)
        pids.append(pid)
    for _ in names[1:]: os.read(r, 1)
    rename(names[0])
    print(s.getsockname()[1], *pids, flush=True)
elif mode == "udp":
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0)); rename(names[0])
    print(s.getsockname()[1], os.getpid(), flush=True)
elif mode == "conn":
    l = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    l.bind(("127.0.0.1", 0)); l.listen()
    lport = l.getsockname()[1]
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        libc.prctl(1, 9, 0, 0, 0); rename(names[1]); l.close()
        c = socket.create_connection(("127.0.0.1", lport))
        os.write(w, str(c.getsockname()[1]).encode() + b"\\n"); time.sleep(90); os._exit(0)
    a, _ = l.accept()
    cport = int(os.read(r, 32).decode().strip())
    rename(names[0])
    print(lport, cport, os.getpid(), pid, flush=True)
time.sleep(90)
`

const live = new Set<number>()
afterAll(() => {
  for (const pid of live) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')

interface Helper {
  nums: number[]
  kill(): Promise<void>
}

async function spawnHelper(mode: 'shared' | 'udp' | 'conn', comms: string[]): Promise<Helper> {
  for (const c of comms) expect({ c, fits: Buffer.byteLength(c) <= 15 && !c.includes('\0') }).toEqual({ c, fits: true })
  const proc = Bun.spawn([PYTHON as string, '-c', HELPER, mode, ...comms.map(hex)], { stdout: 'pipe', stderr: 'pipe' })
  live.add(proc.pid)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const nums = buf.trim().split(' ').map(Number)
  if (nums.length < 2 || nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`helper ${mode} did not start: ${JSON.stringify(buf)} ${await new Response(proc.stderr as ReadableStream).text()}`)
  }
  const pids = mode === 'conn' ? nums.slice(2) : nums.slice(1)
  for (const p of pids) live.add(p)
  return {
    nums,
    async kill() {
      for (const p of pids) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {}
      }
      await proc.exited
    },
  }
}

/** The comms these tests use, each <= 15 bytes and valid UTF-8, together
 * covering every byte class the brief lists: \n, \r, ", ), runs of spaces and
 * multi-byte UTF-8 — the exact bytes that broke the `ss -p` parsers. */
const COMM = {
  sharedA: 'nl\nx"q  )',
  sharedB: 'cr\r)x   y"',
  single: '日本  é)"',
  udp: 'u\r\n"  )é',
  server: 'srv é\n)"',
  client: 'cli  )\r"日',
}

// ---------------------------------------------------------------------------
// 1. Attribution parity on sockets we create
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('attribution parity: pids per inode == our own /proc/*/fd scan, names == /proc comm', () => {
  test('listener, fork-shared listener, UDP socket (listening); accepted connection + client (all)', async () => {
    const helpers: Helper[] = []
    try {
      const shared = await spawnHelper('shared', [COMM.sharedA, COMM.sharedB])
      helpers.push(shared)
      const single = await spawnHelper('shared', [COMM.single])
      helpers.push(single)
      const udp = await spawnHelper('udp', [COMM.udp])
      helpers.push(udp)
      const conn = await spawnHelper('conn', [COMM.server, COMM.client])
      helpers.push(conn)
      const [sharedPort, sharedP0, sharedP1] = shared.nums as [number, number, number]
      const [singlePort, singlePid] = single.nums as [number, number]
      const [udpPort, udpPid] = udp.nums as [number, number]
      const [lport, cport, srvPid, cliPid] = conn.nums as [number, number, number, number]

      // Delivered: the kernel holds exactly the bytes we asked for.
      const delivered = {
        [sharedP0]: COMM.sharedA,
        [sharedP1]: COMM.sharedB,
        [singlePid]: COMM.single,
        [udpPid]: COMM.udp,
        [srvPid]: COMM.server,
        [cliPid]: COMM.client,
      }
      for (const [pid, comm] of Object.entries(delivered)) {
        expect({ pid, comm: await realComm(Number(pid)) }).toEqual({ pid, comm })
      }

      // Our sockets, keyed as the endpoint keys them, with the holder set our
      // OWN fd scan must find and the endpoint must reproduce.
      const mine: Array<{ scope: Scope; key: string; holders: number[] }> = [
        { scope: 'listening', key: `tcp|LISTEN|127.0.0.1|${sharedPort}|null|null`, holders: [sharedP0, sharedP1].sort((a, b) => a - b) },
        { scope: 'listening', key: `tcp|LISTEN|127.0.0.1|${singlePort}|null|null`, holders: [singlePid] },
        { scope: 'listening', key: `udp|UNCONN|127.0.0.1|${udpPort}|null|null`, holders: [udpPid] },
        { scope: 'listening', key: `tcp|LISTEN|127.0.0.1|${lport}|null|null`, holders: [srvPid] },
        { scope: 'all', key: `tcp|ESTABLISHED|127.0.0.1|${lport}|127.0.0.1|${cport}`, holders: [srvPid] },
        { scope: 'all', key: `tcp|ESTABLISHED|127.0.0.1|${cport}|127.0.0.1|${lport}`, holders: [cliPid] },
      ]

      for (const scope of ['listening', 'all'] as const) {
        const snap = await snapshot(scope)
        const body = await getBody(scope)
        for (const m of mine.filter((x) => x.scope === scope || scope === 'all')) {
          const sockets = snap.sockets.filter((s) => s.key === m.key)
          // Independent: exactly one socket for this key, and our fd scan
          // finds exactly the holders we expect for its inode.
          expect({ key: m.key, n: sockets.length }).toEqual({ key: m.key, n: 1 })
          const ino = (sockets[0] as SsSocket).ino
          expect({ key: m.key, ino, holders: snap.holders.get(ino) }).toEqual({ key: m.key, ino, holders: m.holders })
          // The endpoint: one `socket` row per holder, that pid's exact comm.
          const rows = body.ports
            .filter((r) => keyOf(r) === m.key)
            .map((r) => ({ pid: r.pid, name: r.processName, attribution: r.attribution, known: r.processKnown }))
            .sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0))
          const want = m.holders.map((pid) => ({ pid, name: delivered[pid] as string, attribution: 'socket', known: true }))
          expect({ scope, key: m.key, rows }).toEqual({ scope, key: m.key, rows: want })
        }
        // Our pids appear on no other row at all.
        const ours = new Set(Object.keys(delivered).map(Number))
        const keys = new Set(mine.filter((x) => x.scope === scope || scope === 'all').map((x) => x.key))
        const elsewhere = body.ports.filter((r) => r.pid !== null && ours.has(r.pid) && !keys.has(keyOf(r)))
        expect({ scope, elsewhere }).toEqual({ scope, elsewhere: [] })
      }
    } finally {
      for (const h of helpers) await h.kill()
    }
  }, 60_000)

  for (const scope of ['listening', 'all'] as const) {
    test(`host-wide, scope=${scope}: every stable socket's rows match its inode's visible holders exactly`, async () => {
      const result = await converge(`parity ${scope}`, async () => {
        const before = await snapshot(scope)
        const body = await getBody(scope)
        const after = await snapshot(scope)
        return parityViolations(body, before, after)
      })
      console.log(`[ports-inode] parity ${scope}: ${result.stableKeys} stable keys, ${result.socketRowsChecked} socket rows name-checked`)
      expect(result.stableKeys).toBeGreaterThan(10)
      expect(result.socketRowsChecked).toBeGreaterThan(0)
    }, 60_000)
  }
})

// ---------------------------------------------------------------------------
// 2. No fabrication, no hiding: the attacks that broke the ss -p parsers
// ---------------------------------------------------------------------------

/** Rows for the docker-published redis proxy port, as a comparable shape. */
const redisRows = (body: Body) =>
  body.ports
    .filter((r) => r.protocol === 'tcp' && r.localPort === 56379)
    .map((r) => ({ addr: r.localAddress, state: r.state, pid: r.pid, name: r.processName, attribution: r.attribution, container: r.container, unit: r.unit, owner: r.owner }))
    .sort((a, b) => (a.addr < b.addr ? -1 : 1))

/** The same attack property for one body: our sockets present with exactly
 * their own holders, our pids nowhere else, and no row the kernel does not
 * back (via the host-wide parity check's "unexplained" rows). */
async function attackViolations(scope: Scope, attackers: Array<{ port: number; pids: number[]; comms: string[] }>) {
  return converge(`attack ${scope}`, async () => {
    const before = await snapshot(scope)
    const body = await getBody(scope)
    const after = await snapshot(scope)
    const parity = await parityViolations(body, before, after)
    const violations = [...parity.violations]
    const allPids = new Set(attackers.flatMap((a) => a.pids))
    for (const a of attackers) {
      const key = `tcp|LISTEN|127.0.0.1|${a.port}|null|null`
      const rows = body.ports
        .filter((r) => keyOf(r) === key)
        .map((r) => ({ pid: r.pid, name: r.processName, attribution: r.attribution }))
        .sort((x, y) => (x.pid ?? 0) - (y.pid ?? 0))
      const want = await Promise.all(
        [...a.pids].sort((x, y) => x - y).map(async (pid) => ({ pid, name: (await realComm(pid)) as string, attribution: 'socket' })),
      )
      if (JSON.stringify(rows) !== JSON.stringify(want)) violations.push({ comms: a.comms, port: a.port, rows, want })
    }
    for (const r of body.ports) {
      if (r.pid !== null && allPids.has(r.pid) && !attackers.some((a) => a.pids.includes(r.pid as number) && r.localPort === a.port)) {
        violations.push({ attackerPidOnForeignRow: keyOf(r), pid: r.pid })
      }
    }
    return { violations, body }
  })
}

describe.skipIf(!canRun)('no fabrication or hiding via comm (A1, A2 re-run on the inode design)', () => {
  test('A1: two-process shared socket `\\ntcp ESTAB 0 0 ` + `:56379 *:* `, both orders: no extra rows, redis proxy unchanged', async () => {
    const head = '\ntcp ESTAB 0 0 '
    const rest = ':56379 *:* '
    expect([Buffer.byteLength(head), Buffer.byteLength(rest)]).toEqual([15, 11])
    const baseline = { listening: redisRows(await getBody('listening')), all: redisRows(await getBody('all')) }
    const helpers: Helper[] = []
    try {
      const a = await spawnHelper('shared', [head, rest])
      helpers.push(a)
      const b = await spawnHelper('shared', [rest, head])
      helpers.push(b)
      const attackers = [a, b].map((h, i) => ({ port: h.nums[0] as number, pids: h.nums.slice(1), comms: i === 0 ? [head, rest] : [rest, head] }))
      for (const scope of ['listening', 'all'] as const) {
        const { body } = await attackViolations(scope, attackers)
        expect({ scope, redis: redisRows(body) }).toEqual({ scope, redis: baseline[scope] })
      }
      // Not vacuous: the baseline really has the docker-published redis rows.
      if (baseline.listening.length > 0) {
        expect(baseline.listening.filter((r) => r.state === 'LISTEN').map((r) => r.attribution)).toEqual(['docker', 'docker'])
      } else {
        console.log('[ports-inode] no listener on 56379 on this host — redis-unchanged half is vacuous')
      }
    } finally {
      for (const h of helpers) await h.kill()
    }
  }, 90_000)

  test('A2: `abc\\rdef`, `a b`, and newline + state-name comms: no extra rows, each socket its own', async () => {
    const comms = ['abc\rdef', 'a b']
    for (const netid of ['tcp', 'udp']) {
      for (const state of ['ESTAB', 'LISTEN', 'UNCONN', 'TIME-WAIT', 'SYN-SENT', 'CLOSE-WAIT']) {
        comms.push(Buffer.from(`\n${netid} ${state} 0 0 `).subarray(0, 15).toString())
      }
    }
    comms.push('\ntcp LISTEN 0 0', '\n*:* uid:0 ', 'x\n\n\ny', '\r\n\r\n')
    const helpers: Helper[] = []
    try {
      for (const c of comms) helpers.push(await spawnHelper('shared', [c]))
      const attackers = helpers.map((h, i) => ({ port: h.nums[0] as number, pids: h.nums.slice(1), comms: [comms[i] as string] }))
      for (const a of attackers) expect({ comm: a.comms[0], got: await realComm(a.pids[0] as number) }).toEqual({ comm: a.comms[0], got: a.comms[0] })
      for (const scope of ['listening', 'all'] as const) await attackViolations(scope, attackers)
    } finally {
      for (const h of helpers) await h.kill()
    }
  }, 90_000)
})

// ---------------------------------------------------------------------------
// 3. Row count parity
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('row count parity with our own `ss -H -t -u -n -e` snapshot', () => {
  for (const scope of ['listening', 'all'] as const) {
    test(`scope=${scope}: distinct (protocol, local, peer, state, inode) sockets == ss, within churn`, async () => {
      const result = await converge(`count ${scope}`, async () => {
        const before = await snapshot(scope)
        const body = await getBody(scope)
        const after = await snapshot(scope)
        const sock = (s: SsSocket) => `${s.key}|${s.ino}`
        const b = new Set(before.sockets.map(sock))
        const a = new Set(after.sockets.map(sock))
        const churn = [...b].filter((x) => !a.has(x)).length + [...a].filter((x) => !b.has(x)).length
        // The endpoint's distinct sockets, reconstructed WITHOUT an inode on
        // the wire: per key, one socket per non-`socket` row, plus the number
        // of distinct inodes (of that key, in either snapshot) held by the
        // pids its `socket` rows name.
        const byKey = new Map<string, PortEntry[]>()
        for (const r of body.ports) byKey.set(keyOf(r), [...(byKey.get(keyOf(r)) ?? []), r])
        const inodesOfKey = new Map<string, Set<number>>()
        for (const s of [...before.sockets, ...after.sockets]) {
          if (!inodesOfKey.has(s.key)) inodesOfKey.set(s.key, new Set())
          inodesOfKey.get(s.key)?.add(s.ino)
        }
        let endpointSockets = 0
        for (const [k, rows] of byKey) {
          endpointSockets += rows.filter((r) => r.attribution !== 'socket').length
          const pids = new Set(rows.filter((r) => r.attribution === 'socket').map((r) => r.pid as number))
          if (pids.size === 0) continue
          const held = [...(inodesOfKey.get(k) ?? [])].filter((ino) =>
            [before.holders.get(ino) ?? [], after.holders.get(ino) ?? []].some((h) => h.some((p) => pids.has(p))),
          )
          endpointSockets += Math.max(1, held.length)
        }
        const lo = Math.min(b.size, a.size) - churn - 2
        const hi = Math.max(b.size, a.size) + churn + 2
        const ok = endpointSockets >= lo && endpointSockets <= hi
        return {
          violations: ok ? [] : [{ endpointSockets, before: b.size, after: a.size, churn }],
          endpointSockets,
          before: b.size,
          after: a.size,
          churn,
          rows: body.ports.length,
        }
      })
      console.log(`[ports-inode] count ${scope}: endpoint ${result.endpointSockets} sockets (${result.rows} rows); ss before ${result.before}, after ${result.after}, churn ${result.churn}`)
      expect(result.endpointSockets).toBeGreaterThan(0)
    }, 60_000)
  }
})

// ---------------------------------------------------------------------------
// 4. Regression on this host's well-known listeners
// ---------------------------------------------------------------------------

async function passwdName(uid: number): Promise<string> {
  for (const line of ((await readText('/etc/passwd')) ?? '').split('\n')) {
    const f = line.split(':')
    if (Number(f[2]) === uid && f[0]) return f[0]
  }
  return String(uid)
}

/** A unit's main process, restated: the member of cgroup.procs whose PPid is
 * not itself a member; lowest pid on a tie. pid 1 for an empty .socket unit. */
async function mainProcessOf(cgroup: string): Promise<number | null> {
  const procs = ((await readText(`/sys/fs/cgroup${cgroup}/cgroup.procs`)) ?? '').split('\n').filter(Boolean).map(Number)
  if (procs.length === 0) return cgroup.endsWith('.socket') ? 1 : null
  const set = new Set(procs)
  const tops: number[] = []
  for (const pid of procs) {
    const ppid = Number(/^PPid:\s*(\d+)/m.exec((await readText(`/proc/${pid}/status`)) ?? '')?.[1] ?? Number.NaN)
    if (Number.isInteger(ppid) && !set.has(ppid)) tops.push(pid)
  }
  return tops.length ? Math.min(...tops) : null
}

/** Genuine docker-proxies, restated: root in all four uids, in docker.service. */
async function realProxies(): Promise<Array<{ pid: number; proto: string; hostIp: string; hostPort: number }>> {
  const out: Array<{ pid: number; proto: string; hostIp: string; hostPort: number }> = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    if ((await realComm(Number(entry))) !== 'docker-proxy') continue
    const uids = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec((await readText(`/proc/${entry}/status`)) ?? '')
    if (!uids || uids.slice(1).some((u) => u !== '0')) continue
    if (!((await readText(`/proc/${entry}/cgroup`)) ?? '').includes('/docker.service')) continue
    const argv = ((await readText(`/proc/${entry}/cmdline`)) ?? '').split('\0')
    const flag = (f: string) => argv[argv.indexOf(f) + 1] ?? ''
    out.push({ pid: Number(entry), proto: flag('-proto'), hostIp: flag('-host-ip'), hostPort: Number(flag('-host-port')) })
  }
  return out
}

async function dockerNames(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (!DOCKER) return map
  const proc = Bun.spawn([DOCKER, 'ps', '--format', '{{.Names}}\t{{.Ports}}'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  for (const line of text.split('\n')) {
    const [name, col] = line.split('\t')
    if (!name || !col) continue
    for (const m of col.matchAll(/:(\d+)->\d+\/tcp/g)) map.set(Number(m[1]), name)
  }
  return map
}

describe.skipIf(!canRun)('regression: well-known listeners attribute as before', () => {
  test('22, 53, 80, 443, 5432, 6379, 8000, 8100, 55432, 56379', async () => {
    // "As before" = the attribution KIND each port had under the previous
    // design (system-ports-attribution-2.test.ts's regression, plus 53 and the
    // three docker ports); the pid/name/owner/unit/container each row must
    // carry is re-derived independently below.
    const KIND: Record<number, 'socket' | 'docker' | 'service'> = {
      22: 'service', 53: 'service', 80: 'service', 443: 'service', 5432: 'service', 6379: 'service',
      8000: 'socket', 8100: 'docker', 55432: 'docker', 56379: 'docker',
    }
    const snap = await snapshot('listening')
    const proxies = await realProxies()
    const names = await dockerNames()
    const body = await getBody('listening')
    const checked: number[] = []
    const problems: unknown[] = []
    for (const [portText, kind] of Object.entries(KIND)) {
      const port = Number(portText)
      const sockets = snap.sockets.filter((s) => s.localPort === port && (s.state === 'LISTEN' || s.state === 'UNCONN'))
      if (sockets.length === 0) {
        console.log(`[ports-inode] regression: nothing listens on ${port} here — skipped`)
        continue
      }
      checked.push(port)
      for (const s of sockets) {
        const rows = body.ports.filter((r) => keyOf(r) === s.key)
        const holders = snap.holders.get(s.ino) ?? []
        let want: Array<Partial<PortEntry>>
        const owner = s.uid === null ? 'root' : await passwdName(s.uid)
        const unit = (s.cgroup ?? '').split('/').filter(Boolean).reverse().find((x) => /\.(service|socket|scope)$/.test(x)) ?? null
        if (kind === 'socket') {
          want = await Promise.all(holders.map(async (pid) => ({ attribution: 'socket' as const, pid, processName: (await realComm(pid)) as string, owner, unit })))
        } else if (kind === 'docker') {
          const p = proxies.filter((x) => x.proto === s.protocol && x.hostPort === port && (x.hostIp === s.localAddress || (x.hostIp === '::' && s.localAddress === '::')))
          want = [{ attribution: 'docker', pid: p.length === 1 ? (p[0] as { pid: number }).pid : -1, processName: 'docker-proxy', container: names.get(port) ?? null, owner }]
        } else {
          const main = s.cgroup ? await mainProcessOf(s.cgroup) : null
          want = [{ attribution: 'service', pid: main ?? -1, processName: main === null ? '?' : ((await realComm(main)) as string), unit, owner }]
        }
        const got = rows.map((r) => {
          const pick: Partial<PortEntry> = {}
          for (const k of Object.keys(want[0] ?? {}) as Array<keyof PortEntry>) (pick as Record<string, unknown>)[k] = r[k]
          return pick
        })
        if (JSON.stringify(got) !== JSON.stringify(want)) problems.push({ port, key: s.key, got, want })
      }
    }
    console.log(`[ports-inode] regression: checked ${checked.join(', ')}`)
    expect(problems).toEqual([])
    expect(checked.length).toBeGreaterThan(0)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 5. Timing: 20 sequential scope=all requests (reported, not asserted — a
//    wall-clock bound here would measure the machine's load, not the code)
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('timing', () => {
  test('20 sequential scope=all requests: all 200 from ss; p50/p95 logged', async () => {
    const ms: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      const body = await getBody('all')
      ms.push(performance.now() - t0)
      expect(body.ports.length).toBeGreaterThan(0)
    }
    const sorted = [...ms].sort((a, b) => a - b)
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number
    console.log(`[ports-inode] timing scope=all x20: p50 ${pct(50).toFixed(0)}ms, p95 ${pct(95).toFixed(0)}ms, min ${sorted[0]?.toFixed(0)}ms, max ${sorted.at(-1)?.toFixed(0)}ms`)
  }, 120_000)
})
