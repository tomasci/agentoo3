// Final independent verification of GET /api/system/ports
// (backend/src/features/system/ports.ts) after fixes A-D. The property:
//
//   No socket is ever attributed to a pid that does not hold it, and no row is
//   ever fabricated. An honest `none` is fine; a missing, invented or
//   misattributed row is not.
//
// Since the inode redesign the endpoint never runs `ss -p` (SS_ARGS), so none
// of the bytes below reach any parser: attribution is `ino:<n>` plus a
// /proc/*/fd scan, the name is /proc/<pid>/comm. These attacks are kept, and
// re-run, because they are exactly what broke the two earlier designs. What
// the notes below describe is what `ss -p` itself does with a comm — still
// true, and still what the "delivered" checks assert, so each attack is shown
// to be one that WOULD have split ss's own output.
//
// The only attacker-controlled text in `ss -p` output is a process comm: at
// most 15 bytes, printed unescaped. Observed on this host (iproute2 ss): the
// comm is read from /proc/<pid>/stat and cut at its first `)`, so `)` never
// reaches the output, but `"`, spaces, tabs, `\r` and `\n` all do. A socket
// shared by N processes (fork after bind) prints N comms in one record, so an
// attacker controls up to 15*N bytes of a record, not 15.
//
// Ground truth is taken independently of the parser: /proc/<pid>/comm,
// /proc/net/{tcp,udp}[6], the raw `ss` text itself, /proc for real
// docker-proxies, and `docker ps` through the real CLI.
//
// Real-process cases need Linux + iproute2 `ss` + python3 and are skipped
// otherwise; the docker cases also need a real root docker-proxy. Every python
// helper sets PR_SET_PDEATHSIG so it dies with its parent, and every pid is
// SIGKILLed in its own test's finally and again in afterAll.

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'

const ports = await import('../src/features/system/ports')
const { portsResponseSchema } = await import('../src/features/system/schema')
const { systemRouter } = await import('../src/features/system/routes')
const { openApiValidationHook } = await import('../src/lib/openapi-hook')
const { AppError, errorBody } = await import('../src/lib/errors')
const { realDockerCli } = await import('../src/features/docker/cli')
type DockerCli = import('../src/features/docker/cli').DockerCli
type PortEntry = import('../src/features/system/ports').PortEntry

const SS_BIN = process.platform === 'linux' ? Bun.which('ss') : null
const PYTHON = Bun.which('python3')
const DOCKER = Bun.which('docker')
const canRun = SS_BIN !== null && PYTHON !== null
const BACKEND_DIR = join(import.meta.dir, '..')

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', systemRouter)
app.onError((error, c) =>
  error instanceof AppError
    ? c.json(errorBody(error), error.status as 400)
    : c.json({ error: 'Internal server error' }, 500),
)

type Body = { source: string; ports: PortEntry[] }

async function getBody(scope: 'listening' | 'all' = 'listening'): Promise<Body> {
  const res = await app.request(`/api/system/ports?scope=${scope}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Body
  expect(body.source).toBe('ss')
  const parsed = portsResponseSchema.safeParse(body)
  expect(parsed.success ? null : parsed.error.issues.slice(0, 3)).toBeNull()
  return body
}

const brief = (rows: PortEntry[]) =>
  rows.map((r) => ({
    proto: r.protocol,
    addr: r.localAddress,
    port: r.localPort,
    state: r.state,
    pid: r.pid,
    name: r.processName,
    attribution: r.attribution,
    container: r.container,
  }))

// --- independent ground truth ----------------------------------------------

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function realComm(pid: number): Promise<string | null> {
  const raw = await readText(`/proc/${pid}/comm`)
  if (raw === null) return null
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

async function realUids(pid: number): Promise<number[] | null> {
  const m = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec((await readText(`/proc/${pid}/status`)) ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null
}

async function realCgroup(pid: number): Promise<string | null> {
  const line = ((await readText(`/proc/${pid}/cgroup`)) ?? '').split('\n').find((l) => l.startsWith('0::'))
  return line ? line.slice(3) : null
}

/** Local ports with ANY socket in /proc/net/{tcp,udp}[6], per protocol —
 * parsed here directly (hex port of the local-address column), not via the
 * module's own parseProcNet. */
async function procNetPorts(): Promise<{ tcp: Set<number>; udp: Set<number> }> {
  const out = { tcp: new Set<number>(), udp: new Set<number>() }
  for (const [file, proto] of [
    ['/proc/net/tcp', 'tcp'],
    ['/proc/net/tcp6', 'tcp'],
    ['/proc/net/udp', 'udp'],
    ['/proc/net/udp6', 'udp'],
  ] as const) {
    for (const line of ((await readText(file)) ?? '').split('\n').slice(1)) {
      const local = line.trim().split(/\s+/)[1]
      if (!local) continue
      out[proto].add(Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16))
    }
  }
  return out
}

async function rawSs(flag: '-l' | '-a' = '-l'): Promise<string> {
  const proc = Bun.spawn([SS_BIN as string, '-H', '-t', '-u', '-n', '-p', '-e', flag], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
}

interface RealProxy {
  pid: number
  hostIp: string
  hostPort: number
}

/** Genuine docker-proxies: comm docker-proxy, all four uids 0, cgroup docker.service. */
async function findRealProxies(): Promise<RealProxy[]> {
  if (process.platform !== 'linux') return []
  const out: RealProxy[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if ((await realComm(pid)) !== 'docker-proxy') continue
    const uids = await realUids(pid)
    if (!uids || uids.some((u) => u !== 0)) continue
    if (!(await realCgroup(pid))?.endsWith('/docker.service')) continue
    const argv = ((await readText(`/proc/${pid}/cmdline`)) ?? '').split('\0')
    const flag = (f: string) => argv[argv.indexOf(f) + 1]
    if (flag('-proto') !== 'tcp') continue
    out.push({ pid, hostIp: flag('-host-ip') as string, hostPort: Number(flag('-host-port')) })
  }
  return out
}

/** Host ports `docker ps` reports published (tcp), via the real CLI. */
async function dockerPublishedTcp(): Promise<Set<number>> {
  const set = new Set<number>()
  if (!DOCKER) return set
  const proc = Bun.spawn([DOCKER, 'ps', '--format', '{{.Ports}}'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  for (const m of text.matchAll(/:(\d+)->\d+\/tcp/g)) set.add(Number(m[1]))
  return set
}

const REAL_PROXIES = canRun ? await findRealProxies() : []
const PUBLISHED = canRun ? await dockerPublishedTcp() : new Set<number>()
/** A real v4-wildcard proxy for a port Docker really publishes, or null. */
const TARGET = REAL_PROXIES.find((p) => p.hostIp === '0.0.0.0' && PUBLISHED.has(p.hostPort)) ?? null

// --- attacker processes -----------------------------------------------------

// python: bind ONE tcp listener on 127.0.0.1:0, fork one child per extra comm
// (so every process holds the same socket), rename each process to its comm
// (argv hex; comm i goes to process i, process 0 is the parent), then print
// "<port> <pid0> <pid1> ...". PR_SET_PDEATHSIG(SIGKILL) everywhere, so nothing
// outlives the test runner.
const ATTACKER = `
import ctypes, os, socket, sys, time
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(1, 9, 0, 0, 0)
names = [bytes.fromhex(h) for h in sys.argv[1:]]
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0)); s.listen()
r, w = os.pipe()
pids = [os.getpid()]
for name in names[1:]:
    pid = os.fork()
    if pid == 0:
        libc.prctl(1, 9, 0, 0, 0)
        libc.prctl(15, ctypes.c_char_p(name), 0, 0, 0)
        os.write(w, b"x")
        time.sleep(60); os._exit(0)
    pids.append(pid)
for _ in names[1:]: os.read(r, 1)
libc.prctl(15, ctypes.c_char_p(names[0]), 0, 0, 0)
print(s.getsockname()[1], *pids, flush=True)
time.sleep(60)
`

// python: rename to argv[1] and bind nothing; argv[2..] is the fake proxy argv.
const FAKE_PROXY = `
import ctypes, sys, time
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(1, 9, 0, 0, 0)
libc.prctl(15, ctypes.c_char_p(sys.argv[1].encode()), 0, 0, 0)
print("ready", flush=True)
time.sleep(60)
`

const live = new Set<number>()
afterAll(() => {
  for (const pid of live) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return buf.split('\n')[0] ?? ''
}

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')

interface Attacker {
  label: string
  comms: string[]
  port: number
  pids: number[]
  proc: ReturnType<typeof Bun.spawn>
}

async function spawnAttacker(label: string, comms: string[]): Promise<Attacker> {
  for (const c of comms) expect({ label, c, bytes: Buffer.byteLength(c) <= 15 }).toEqual({ label, c, bytes: true })
  const proc = Bun.spawn([PYTHON as string, '-c', ATTACKER, ...comms.map(hex)], { stdout: 'pipe', stderr: 'ignore' })
  live.add(proc.pid)
  const [port, ...pids] = (await readFirstLine(proc.stdout as ReadableStream<Uint8Array>)).trim().split(' ').map(Number)
  for (const pid of pids) live.add(pid)
  expect({ label, port: (port ?? 0) > 0, n: pids.length }).toEqual({ label, port: true, n: comms.length })
  return { label, comms, port: port as number, pids, proc }
}

async function killAll(attackers: Attacker[]): Promise<void> {
  for (const a of attackers) {
    for (const pid of a.pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await a.proc.exited
  }
}

// --- the property, checked row by row ---------------------------------------

const STATES = new Set([
  'LISTEN', 'UNCONN', 'ESTABLISHED', 'SYN-SENT', 'SYN-RECV', 'FIN-WAIT-1', 'FIN-WAIT-2',
  'TIME-WAIT', 'CLOSE-WAIT', 'LAST-ACK', 'CLOSING', 'CLOSED', 'UNKNOWN',
])

/** A real local address: an IP literal (optionally %zone) or ss's `*`. */
function isRealAddress(addr: string): boolean {
  return addr === '*' || isIP(addr.replace(/%[^%]*$/, '')) !== 0
}

/**
 * Every violation of the property this body shows, for the given attackers:
 *   - a row whose local address is not an address at all (fabricated record);
 *   - a row for a port in `phantomPorts` that no socket on the host uses;
 *   - a row naming an attacker pid for anything but that attacker's own socket;
 *   - an attacker's own socket that is missing, or whose rows are not EXACTLY
 *     one `socket` row per real holder, each with that pid's real comm.
 *     (Tightened for the inode design: the holders are this account's own
 *     processes, so `none` for their socket — accepted when the name came from
 *     ss -p — would now be a socket hidden by its process name.)
 */
async function violations(
  body: Body,
  attackers: Attacker[],
  phantomPorts: Array<{ proto: 'tcp' | 'udp'; port: number }> = [],
): Promise<unknown[]> {
  const out: unknown[] = []
  for (const r of body.ports) {
    if (!isRealAddress(r.localAddress) || !STATES.has(r.state)) out.push({ fabricated: brief([r])[0] })
  }
  const netBefore = await procNetPorts()
  for (const { proto, port } of phantomPorts) {
    if (netBefore[proto].has(port)) continue // a real socket uses it; only the address check applies
    const rows = body.ports.filter((r) => r.protocol === proto && r.localPort === port)
    if (rows.length > 0) out.push({ phantomPort: `${proto}/${port}`, rows: brief(rows) })
  }
  for (const a of attackers) {
    for (const r of body.ports) {
      if (r.pid !== null && a.pids.includes(r.pid) && !(r.localPort === a.port && r.localAddress === '127.0.0.1')) {
        out.push({ attacker: a.label, pidOnForeignRow: brief([r])[0] })
      }
    }
    const own = body.ports.filter((r) => r.protocol === 'tcp' && r.localAddress === '127.0.0.1' && r.localPort === a.port)
    if (own.length === 0) out.push({ attacker: a.label, comms: a.comms, ownRowMissing: a.port })
    for (const r of own) {
      const ok = r.attribution === 'socket' && r.pid !== null && a.pids.includes(r.pid) && r.processName === (await realComm(r.pid))
      if (!ok) out.push({ attacker: a.label, comms: a.comms, badOwnRow: brief([r])[0] })
    }
    const ownPids = own.map((r) => r.pid).sort((x, y) => (x ?? 0) - (y ?? 0))
    const wantPids = [...a.pids].sort((x, y) => x - y)
    if (own.length > 0 && JSON.stringify(ownPids) !== JSON.stringify(wantPids)) {
      out.push({ attacker: a.label, comms: a.comms, ownPids, wantPids })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// A. newline (and friends) in a comm, single process
// ---------------------------------------------------------------------------

const BASE = 'abcdefghijklmn' // 14 bytes; + one inserted byte = the 15-byte cap
const SINGLE: Array<[string, string]> = []
for (let i = 0; i <= BASE.length; i++) SINGLE.push([`\\n at ${i}`, `${BASE.slice(0, i)}\n${BASE.slice(i)}`])
for (const c of ['\rabc', 'abc\rdef', 'abc\r', '\r\n', '\n\r', '\n\n', 'a\n\nb', '\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n'])
  SINGLE.push([JSON.stringify(c), c])
for (const netid of ['tcp', 'udp']) {
  for (const state of ['ESTAB', 'LISTEN', 'UNCONN', 'CLOSED', 'SYN-SENT', 'SYN-RECV', 'TIME-WAIT', 'CLOSE-WAIT', 'LAST-ACK', 'CLOSING', 'UNKNOWN', 'FIN-WAIT-1']) {
    const c = Buffer.from(`\n${netid} ${state} 0 0 `).subarray(0, 15).toString()
    SINGLE.push([JSON.stringify(c), c])
  }
}
for (const c of [
  '\ntcp ESTAB 0 0',
  '\nESTAB 0 0 a:1 ',
  '\n0 0 a:1 *:* ',
  '\na:1 *:* ',
  '\n:1 *:* ',
  '\n*:* ',
  '\n0.0.0.0:1 *:* ',
  '\n1.1.1.1:9 1:1 ',
  '\n*:9 *:* uid:0 ',
  '\nusers:(("x',
  '\n uid:0 ino:1 ',
  // Shapes that try to make the attacker's own line look complete before the
  // newline. ss cuts the comm at its first `)`, so the ones with `)` are
  // delivered truncated — still worth sending as-is.
  '",pid=1,fd=2))\n',
  '",pid=1,fd=2\n',
  'x",pid=1\n',
  'a",pid=1,fd=2)\n',
  '"),("a",pid=1\n',
  '",pid=1,fd=2 \n',
])
  SINGLE.push([JSON.stringify(c), c])

describe.skipIf(!canRun)('A: a newline/CR in a single comm fabricates nothing and hides nothing', () => {
  // Batched: one attacker per comm, all alive at once, one request. Records
  // are independent (a split never crosses into another record), and the
  // failure detail names the comm.
  const BATCH = 24
  for (let start = 0; start < SINGLE.length; start += BATCH) {
    const batch = SINGLE.slice(start, start + BATCH)
    test(`comms ${start}..${start + batch.length - 1}: ${batch.map(([l]) => l).join(' | ')}`, async () => {
      const attackers: Attacker[] = []
      try {
        for (const [label, comm] of batch) attackers.push(await spawnAttacker(label, [comm]))
        // Delivered as intended: /proc/<pid>/comm is the comm we asked for.
        for (const a of attackers) {
          expect({ label: a.label, comm: await realComm(a.pids[0] as number) }).toEqual({ label: a.label, comm: a.comms[0] as string })
        }
        const body = await getBody('listening')
        const phantomPorts = [1, 9].flatMap((port) => [{ proto: 'tcp' as const, port }, { proto: 'udp' as const, port }])
        expect(await violations(body, attackers, phantomPorts)).toEqual([])
      } finally {
        await killAll(attackers)
      }
    }, 60_000)
  }
})

// ---------------------------------------------------------------------------
// A. the same attack with two processes holding one socket
// ---------------------------------------------------------------------------
//
// ss prints `users:(("<c0>",pid=P0,fd=4),("<c1>",pid=P1,fd=4))`. With c0 =
// `\ntcp ESTAB 0 0 ` (exactly 15 bytes) the second physical line reads
// `tcp ESTAB 0 0 ",pid=P0,fd=4),("<c1>",pid=P1,fd=4)) uid:... cgroup:...` —
// netid, state and both queues valid, and the LOCAL field is ss's own
// `",pid=P0,fd=4),("` followed by whatever c1 starts with. c1 = `:<port> *:* `
// completes a local `addr:port` and a valid peer. Which process ss lists first
// is not ours to choose, so each pair is sent in both orders and at least one
// order must actually deliver the split line (asserted on the raw ss text).

const PAIRS: Array<{ label: string; head: string; rest: string; phantom: { proto: 'tcp' | 'udp'; port: number } }> = [
  { label: 'tcp phantom on unused port 1', head: '\ntcp ESTAB 0 0 ', rest: ':1 *:* ', phantom: { proto: 'tcp', port: 1 } },
  { label: 'udp phantom on unused port 9', head: '\nudp ESTAB 0 0 ', rest: ':9 *:* ', phantom: { proto: 'udp', port: 9 } },
  { label: 'tcp phantom on 8000 (a real bun listener)', head: '\ntcp ESTAB 0 0 ', rest: ':8000 *:* ', phantom: { proto: 'tcp', port: 8000 } },
  { label: 'tcp phantom opening a users:(( claim', head: '\ntcp ESTAB 0 0 ', rest: ':1 *:* users:((', phantom: { proto: 'tcp', port: 1 } },
  { label: 'tcp phantom with a tab separator', head: '\ntcp\tESTAB\t0\t0\t', rest: ':1\t*:*\t', phantom: { proto: 'tcp', port: 1 } },
]
if (TARGET) {
  PAIRS.push({
    label: `tcp phantom on docker-published ${TARGET.hostPort}`,
    head: '\ntcp ESTAB 0 0 ',
    rest: `:${TARGET.hostPort} *:* `,
    phantom: { proto: 'tcp', port: TARGET.hostPort },
  })
}

describe.skipIf(!canRun)('A: two processes sharing a socket (30 attacker bytes) fabricate nothing', () => {
  for (const pair of PAIRS) {
    test(pair.label, async () => {
      const attackers: Attacker[] = []
      try {
        attackers.push(await spawnAttacker(`${pair.label} [head,rest]`, [pair.head, pair.rest]))
        attackers.push(await spawnAttacker(`${pair.label} [rest,head]`, [pair.rest, pair.head]))
        const before = await rawSs('-l')
        const body = await getBody('listening')
        // The attack really reached the parser: some raw line starts with the
        // head's own text followed by ss's `",pid=` for one of our pids.
        const headLine = pair.head.slice(1)
        const delivered = attackers.some((a) =>
          a.pids.some((pid) => before.includes(`\n${headLine}",pid=${pid},fd=`)),
        )
        expect({ label: pair.label, delivered }).toEqual({ label: pair.label, delivered: true })
        const found = await violations(body, attackers, [pair.phantom])
        // Also: no row at the phantom port may be attributed to anything when
        // its address is not a real one (docker/service promotion of a phantom).
        expect({ label: pair.label, violations: found }).toEqual({ label: pair.label, violations: [] })
      } finally {
        await killAll(attackers)
      }
    }, 60_000)
  }
})

// The same two shapes, pinned on the pure parser with the exact bytes ss
// printed on this host, so they fail the same way on any machine.
describe('A (pure): the exact records ss printed for the two attacks above', () => {
  const TAIL = ' uid:999 ino:26563424 sk:f50 cgroup:/system.slice/agentoo-worker.service <->'
  test('two comms `\\ntcp ESTAB 0 0 ` + `:55432 *:* ` on one socket: one row, the real one', () => {
    const text = `tcp LISTEN 0 128 127.0.0.1:39491 0.0.0.0:* users:(("\ntcp ESTAB 0 0 ",pid=2127375,fd=4),(":55432 *:* ",pid=2127365,fd=4))${TAIL}`
    const rows = ports.parseSsOutput(text)
    // Only 127.0.0.1:39491 exists. Its claim is unverifiable (split
    // mid-comm), so `none` is the honest answer for it.
    expect(brief(rows)).toEqual([
      { proto: 'tcp', addr: '127.0.0.1', port: 39491, state: 'LISTEN', pid: null, name: 'unknown', attribution: 'none', container: null },
    ])
  })
  test('a comm containing \\r (printed raw by ss) does not make the socket vanish', () => {
    const text = `tcp LISTEN 0 128 127.0.0.1:47593 0.0.0.0:* users:(("abc\rdef",pid=2184791,fd=4))${TAIL}`
    const rows = ports.parseSsOutput(text)
    expect(rows.map((r) => [r.localAddress, r.localPort, r.state])).toEqual([['127.0.0.1', 47593, 'LISTEN']])
    // Whatever it is attributed to, it is the real pid or nobody.
    expect(rows.every((r) => r.pid === null || r.pid === 2184791)).toBe(true)
  })
  test('U+2028 / U+2029 in a comm (3 UTF-8 bytes each) do not make the socket vanish either', () => {
    for (const c of ['a\u2028b', 'a\u2029b']) {
      const rows = ports.parseSsOutput(`tcp LISTEN 0 128 127.0.0.1:5 0.0.0.0:* users:(("${c}",pid=42,fd=4))${TAIL}`)
      expect({ c: JSON.stringify(c), rows: rows.map((r) => r.localPort) }).toEqual({ c: JSON.stringify(c), rows: [5] })
    }
  })
})

// ---------------------------------------------------------------------------
// C. whitespace inside a comm is kept byte-exact, and padding can't forge
// ---------------------------------------------------------------------------

const WHITESPACE: Array<[string, string]> = [
  ['trailing spaces', 'x   '],
  ['runs of spaces', 'a  b  c   d'],
  ['leading spaces', '   lead'],
  ['only spaces', '               '],
  ['tab inside', 'a\tb'],
  ['tabs and spaces', '\t a \t b \t'],
  ['space then key-looking text', 'svc  uid:1'],
  ['forged close + space (15 bytes; ss cuts at `)`)', '",pid=1,fd=2)) '],
  ['forged close + space + key (15 bytes; ss cuts at `)`)', '",pid=1,fd=2) k'],
  ['forged entry without close + spaces + key', '",pid=1,fd=2  k:'.slice(0, 15)],
  ['quote + spaces + ino key', '"  ino:0 uid:0'],
]

describe.skipIf(!canRun)('C: whitespace in a comm on a readable socket stays socket/own pid/exact comm', () => {
  test(WHITESPACE.map(([l]) => l).join(' | '), async () => {
    const attackers: Attacker[] = []
    try {
      for (const [label, comm] of WHITESPACE) attackers.push(await spawnAttacker(label, [comm]))
      const body = await getBody('listening')
      expect(await violations(body, attackers)).toEqual([])
      // Tightened for the inode design: the name now comes from /proc, not
      // from what ss printed, so EVERY one of these (including the `)`-bearing
      // ones ss used to cut) must be `socket`, our pid, byte-exact comm — and
      // that comm must be the one we asked for, or the check proves nothing.
      const notExact: unknown[] = []
      for (const a of attackers) {
        const pid = a.pids[0] as number
        const truth = (await realComm(pid)) as string
        if (truth !== a.comms[0]) notExact.push({ label: a.label, truth, asked: a.comms[0], notDelivered: true })
        const rows = body.ports.filter((r) => r.localAddress === '127.0.0.1' && r.localPort === a.port)
        const got = rows.map((r) => ({ pid: r.pid, name: r.processName, attribution: r.attribution }))
        if (JSON.stringify(got) !== JSON.stringify([{ pid, name: truth, attribution: 'socket' }])) {
          notExact.push({ label: a.label, truth, got })
        }
      }
      expect(notExact).toEqual([])
    } finally {
      await killAll(attackers)
    }
  }, 60_000)
})

// Pure parser, beyond what real ss can emit (it can't print `)` inside a
// comm): a seeded fuzz of comms <= 15 bytes built from the pieces a forged
// `users:` split needs, with 0-5 spaces of padding after the genuine close
// (fix C strips all of it). Property: every row names a genuine pid or none,
// a genuine pid with a name other than its own comm carries a `"` (so the
// endpoint re-checks it against /proc/<pid>/comm and drops it), and the
// genuine uid/cgroup are never replaced by forged ones.
describe('C: a forged users: close cannot be accepted because padding is stripped (pure, fuzz)', () => {
  const PIECES = ['"', ',pid=1', ',fd=2', ')', '))', '(', ' ', '  ', 'k:', 'uid:0', ',', 'x', '),(', ' ino:0', 'cgroup:/e.service', ':', '<->']
  let seed = 0x5eed1234
  const rand = (n: number) => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0
    return seed % n
  }
  const makeComm = () => {
    let s = ''
    while (s.length < 15 && rand(8) !== 0) s += PIECES[rand(PIECES.length)]
    return Buffer.from(s).subarray(0, 15).toString('latin1')
  }
  const TAIL = 'uid:999 ino:77 sk:1 cgroup:/system.slice/a.service <->'

  test('20,000 single- and two-entry columns: no forged pid, name, uid or unit', () => {
    const bad: unknown[] = []
    for (let i = 0; i < 20_000 && bad.length < 5; i++) {
      const pad = ' '.repeat(1 + rand(5))
      const c1 = makeComm()
      const two = rand(2) === 1
      const c2 = makeComm()
      const genuine = new Map<number, string>([[4242, c1]])
      if (two) genuine.set(4343, c2)
      const column = two ? `users:(("${c1}",pid=4242,fd=3),("${c2}",pid=4343,fd=5))` : `users:(("${c1}",pid=4242,fd=3))`
      const line = `tcp LISTEN 0 128 127.0.0.1:5 0.0.0.0:* ${column}${pad}${TAIL}`
      const rows = ports.parseSsOutput(line)
      for (const r of rows) {
        const forgedPid = r.pid !== null && !genuine.has(r.pid)
        const forgedName = r.pid !== null && genuine.get(r.pid) !== r.processName && !r.processName.includes('"')
        const forgedOwner = r.owner !== null && r.owner !== '999'
        const forgedUnit = r.unit !== null && r.unit !== 'a.service'
        const wrongRow = r.localPort !== 5 || r.localAddress !== '127.0.0.1'
        if (forgedPid || forgedName || forgedOwner || forgedUnit || wrongRow) bad.push({ line, row: r })
      }
      if (rows.length === 0) bad.push({ line, rows: 'none at all — the socket vanished' })
    }
    expect(bad).toEqual([])
  }, 60_000)

  // Re-expressed: this pinned the deleted tiler keeping pid 4242 past a forged
  // close. The forgery-can't-win property is now stronger — no pid, uid or
  // unit comes out of a users: line at all.
  test('the targeted shape `",pid=1,fd=2))` + spaces (15 bytes) + 1-5 pad spaces forges nothing', () => {
    for (let pad = 0; pad <= 5; pad++) {
      const comm = '",pid=1,fd=2)) '
      const line = `tcp LISTEN 0 1 127.0.0.1:5 0.0.0.0:* users:(("${comm}",pid=4242,fd=3))${' '.repeat(1 + pad)}${TAIL}`
      const got = ports.parseSsOutput(line).map((r) => [r.localPort, r.pid, r.processName, r.owner, r.unit])
      expect({ pad, got }).toEqual({ pad, got: [[5, null, 'unknown', null, null]] })
    }
  })

  // Re-expressed: "padding between the users column and the tail still
  // parses" is a property of a line the endpoint no longer reads. The same
  // concern on the argv it does spawn: ss -e pads between the peer column and
  // the tail (seen on this host: 5 spaces after `0.0.0.0:*`) — any amount of
  // it must still yield the genuine -e facts.
  test('padding between the peer column and the -e tail still parses (real ss -e pads)', () => {
    for (const pad of [' ', '  ', '     ', '\t', ' '.repeat(80)]) {
      const line = `tcp LISTEN 0 1 127.0.0.1:5 0.0.0.0:*${pad}${TAIL}${' '.repeat(40)}`
      const got = ports.parseSsOutput(line).map((r) => [r.pid, r.processName, r.owner, r.unit])
      expect({ pad: JSON.stringify(pad), got }).toEqual({ pad: JSON.stringify(pad), got: [[null, 'unknown', '999', 'a.service']] })
    }
  })
})

// ---------------------------------------------------------------------------
// B. Docker unreachable, for real: a child bun whose PATH has only `ss`, plus
// either a `docker` that exits 1 or no `docker` at all.
// ---------------------------------------------------------------------------

describe.skipIf(!canRun || TARGET === null)('B: Docker unreachable (real child process, real host proxy)', () => {
  let scratch = ''
  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

  async function pathDir(name: string, docker: 'exit1' | 'absent'): Promise<string> {
    if (!scratch) scratch = await mkdtemp(join(tmpdir(), 'agentoo-ports-final-'))
    const dir = join(scratch, name)
    await Bun.write(join(dir, '.keep'), '')
    await symlink(SS_BIN as string, join(dir, 'ss'))
    if (docker === 'exit1') {
      await writeFile(join(dir, 'docker'), "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n")
      await chmod(join(dir, 'docker'), 0o755)
    }
    return dir
  }

  async function runChild(dir: string): Promise<{ status: number; body: Body }> {
    const out = join(scratch, `${dir.split('/').pop()}-out.json`)
    const proc = Bun.spawn([process.execPath, 'test', './tests/system-ports-verify-child.ts'], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PATH: dir,
        PORTS_VERIFY_PLAN: JSON.stringify({ batches: [['/api/system/ports?scope=listening']] }),
        PORTS_VERIFY_OUT: out,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ exit: proc.exitCode, stderr: proc.exitCode === 0 ? '' : stderr.slice(-2000) }).toEqual({ exit: 0, stderr: '' })
    const result = JSON.parse(await readFile(out, 'utf8'))
    return result.batches[0].responses[0]
  }

  for (const docker of ['exit1', 'absent'] as const) {
    test(`docker ${docker === 'exit1' ? 'exits 1' : 'not on PATH'}: every real proxy wins with its real pid and container null; a fake wins nothing`, async () => {
      const t = TARGET as RealProxy
      const fake = Bun.spawn(
        [PYTHON as string, '-c', FAKE_PROXY, 'docker-proxy', '-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', String(t.hostPort), '-container-ip', '10.9.9.9', '-container-port', '1', '-use-listen-fd'],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      live.add(fake.pid)
      try {
        expect(await readFirstLine(fake.stdout as ReadableStream<Uint8Array>)).toBe('ready')
        expect(await realComm(fake.pid)).toBe('docker-proxy')
        const res = await runChild(await pathDir(`path-${docker}`, docker))
        expect(res.status).toBe(200)
        expect(res.body.source).toBe('ss')
        expect(portsResponseSchema.safeParse(res.body).success).toBe(true)

        // Every real, published proxy's own listener: docker, its own pid,
        // container null (Docker could not be asked).
        const checked: unknown[] = []
        for (const p of REAL_PROXIES.filter((p) => PUBLISHED.has(p.hostPort))) {
          const addr = p.hostIp === '::' ? '::' : p.hostIp
          const rows = res.body.ports.filter((r) => r.protocol === 'tcp' && r.localPort === p.hostPort && r.localAddress === addr && r.state === 'LISTEN')
          checked.push({ port: p.hostPort, addr, rows: brief(rows) })
          expect({ port: p.hostPort, addr, rows: brief(rows) }).toEqual({
            port: p.hostPort,
            addr,
            rows: [{ proto: 'tcp', addr, port: p.hostPort, state: 'LISTEN', pid: p.pid, name: 'docker-proxy', attribution: 'docker', container: null }],
          })
        }
        expect(checked.length).toBeGreaterThan(0)
        const stolen = res.body.ports.filter((r) => r.pid === fake.pid)
        expect(brief(stolen)).toEqual([])
      } finally {
        fake.kill('SIGKILL')
        await fake.exited
        live.delete(fake.pid)
      }
    }, 60_000)
  }
})

// ---------------------------------------------------------------------------
// D. the tiler: 30,000 entries, roughly linear CPU time
// ---------------------------------------------------------------------------

// The tiler is gone; its "every entry accounted for" property no longer
// exists (no entry is read). What remains worth pinning: a huge users: line
// neither throws nor stalls, still yields its one row, and costs linear time.
describe('D: a huge users: column is rejected in linear time', () => {
  const lineWith = (n: number, distinctPids: boolean) => {
    const entries: string[] = []
    for (let i = 0; i < n; i++) entries.push(`("w${i % 10}",pid=${distinctPids ? 100000 + i : 4242},fd=${i + 3})`)
    return `tcp ESTAB 0 0 127.0.0.1:5 127.0.0.1:6 users:(${entries.join(',')}) uid:999 ino:77 sk:1 cgroup:/system.slice/a.service <->`
  }

  test('30,000 entries (one pid, and 30,000 pids) parse without throwing: one row, no pid, no facts', () => {
    for (const distinctPids of [false, true]) {
      const rows = ports.parseSsOutput(lineWith(30_000, distinctPids))
      expect({ distinctPids, rows: rows.map((r) => [r.localPort, r.peerPort, r.pid, r.owner, r.unit]) }).toEqual({
        distinctPids,
        rows: [[5, 6, null, null, null]],
      })
    }
  }, 60_000)

  test('CPU time per entry at 30k is within 4x of at 4k (quadratic would be ~7.5x)', () => {
    // Per-call CPU time (user+system, so other load on the box matters far
    // less than for wall time), each sample doing ~30k entries of work — the
    // small sizes are parsed repeatedly per sample — and the MIN of 7
    // samples, i.e. the least-disturbed one. 4k is the baseline: a single 1k
    // parse is too short to time reliably.
    const perEntryUs = (n: number) => {
      const text = lineWith(n, false)
      const reps = Math.max(1, Math.round(30_000 / n))
      let best = Number.POSITIVE_INFINITY
      for (let k = 0; k < 7; k++) {
        const t0 = process.cpuUsage()
        for (let r = 0; r < reps; r++) ports.parseSsOutput(text)
        const d = process.cpuUsage(t0)
        best = Math.min(best, (d.user + d.system) / reps / n)
      }
      return best
    }
    perEntryUs(1_000) // warm up the JIT
    const sizes = [1_000, 4_000, 16_000, 30_000]
    const us = sizes.map(perEntryUs)
    console.log(`[ports-final] tiler cpu us/entry: ${sizes.map((n, i) => `${n}=${(us[i] as number).toFixed(2)}`).join(' ')}`)
    const ratio = (us[3] as number) / (us[1] as number)
    expect({ us, ratio, linear: ratio < 4 }).toMatchObject({ linear: true })
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 5. regression: every docker call is a read, and argv is what it should be
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('regression: docker calls made by one real request are read-only', () => {
  test('a recording DockerCli over the real one sees only `ps -aq`-style and `inspect` reads', async () => {
    const calls: string[][] = []
    const recording: DockerCli = {
      run: async (args, options) => {
        calls.push([...args])
        return realDockerCli.run(args, options)
      },
      stream: () => {
        throw new Error('the ports endpoint must never stream from docker')
      },
    }
    const result = await ports.getPorts('listening', recording)
    expect(result.source).toBe('ss')
    if (REAL_PROXIES.length > 0) expect(calls.length).toBeGreaterThan(0)
    // Exactly the two read-only shapes: one `ps -aq` listing, then
    // `inspect --type container --format {{json .}} <ids>` (in <=200-id chunks).
    const bad = calls.filter(
      (a, i) =>
        !(i === 0 && JSON.stringify(a) === JSON.stringify(['ps', '-aq'])) &&
        !(i > 0 && JSON.stringify(a.slice(0, 5)) === JSON.stringify(['inspect', '--type', 'container', '--format', '{{json .}}']) && a.length > 5 && a.length <= 205),
    )
    expect({ calls: calls.map((a) => a.slice(0, 6)), bad }).toMatchObject({ bad: [] })
    console.log(`[ports-final] docker calls: ${JSON.stringify(calls.map((a) => a.slice(0, 4)))}`)
  }, 30_000)
})
