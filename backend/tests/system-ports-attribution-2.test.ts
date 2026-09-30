// Second independent attack on the two fixes in
// backend/src/features/system/ports.ts:
//
//   Defect 1 — a same-account process renamed `docker-proxy` with a crafted
//   argv must never be attributed a socket it does not hold. Candidates are
//   now trusted only if root (all four uids), in the socket's own cgroup,
//   confirmed published by Docker (waived when Docker is unreachable), and
//   the only one that verifies.
//
//   Defect 2 — a comm whose words look like `ss -e` tail tokens must never
//   turn our own readable `socket` row into a `service` row with another pid,
//   nor forge `owner`/`unit`.
//
// The property under attack: no socket is ever attributed to a pid that does
// not hold it. `none` is an honest answer; another pid never is.
//
// Every expectation is derived independently of the parser: real docker-proxy
// pids from /proc (comm, cmdline, status, cgroup), container names from the
// real `docker ps`, our own unit from /proc/<pid>/cgroup, our owner from
// userInfo(), and what `ss` actually printed from a raw `ss` run keyed on the
// known pid.
//
// Real-process cases need Linux + iproute2 `ss` + python3, and the docker
// cases additionally need at least one real root docker-proxy on this host.
// They are skipped otherwise. Every spawned pid is SIGKILLed in its own test's
// finally and again in afterAll.

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { readdir, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { OpenAPIHono } from '@hono/zod-openapi'

const ports = await import('../src/features/system/ports')
const { portsResponseSchema } = await import('../src/features/system/schema')
const { systemRouter } = await import('../src/features/system/routes')
const { openApiValidationHook } = await import('../src/lib/openapi-hook')
const { AppError, errorBody } = await import('../src/lib/errors')
type DockerCli = import('../src/features/docker/cli').DockerCli
type PortEntry = import('../src/features/system/ports').PortEntry

const SS_BIN = process.platform === 'linux' ? Bun.which('ss') : null
const PYTHON = Bun.which('python3')
const DOCKER = Bun.which('docker')
const canRun = SS_BIN !== null && PYTHON !== null
const ME = userInfo().username

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
  expect(portsResponseSchema.safeParse(body).success).toBe(true)
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

async function realComm(pid: number): Promise<string | null> {
  const raw = await readText(`/proc/${pid}/comm`)
  if (raw === null) return null
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

async function realCgroup(pid: number): Promise<string | null> {
  const raw = await readText(`/proc/${pid}/cgroup`)
  const line = raw?.split('\n').find((l) => l.startsWith('0::'))
  return line ? line.slice(3) : null
}

async function realUids(pid: number): Promise<number[] | null> {
  const m = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec((await readText(`/proc/${pid}/status`)) ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null
}

/** Deepest .service/.socket/.scope segment — restated here, not imported. */
function unitOf(cgroup: string | null): string | null {
  const segs = (cgroup ?? '').split('/').filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/\.(service|socket|scope)$/.test(segs[i] as string)) return segs[i] as string
  }
  return null
}

interface RealProxy {
  pid: number
  hostIp: string
  hostPort: number
}

/** Genuine docker-proxies: comm docker-proxy, all uids 0, cgroup docker.service. */
async function findRealProxies(): Promise<RealProxy[]> {
  if (process.platform !== 'linux') return []
  const out: RealProxy[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if ((await realComm(pid)) !== 'docker-proxy') continue
    const uids = await realUids(pid)
    if (!uids || uids.some((u) => u !== 0)) continue
    if (unitOf(await realCgroup(pid)) !== 'docker.service') continue
    const argv = ((await readText(`/proc/${pid}/cmdline`)) ?? '').split('\0')
    const flag = (f: string) => argv[argv.indexOf(f) + 1]
    if (flag('-proto') !== 'tcp') continue
    out.push({ pid, hostIp: flag('-host-ip') as string, hostPort: Number(flag('-host-port')) })
  }
  return out
}

/** `docker ps` read with the real CLI: host port -> container name (tcp only). */
async function publishedByDocker(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (!DOCKER) return map
  const proc = Bun.spawn([DOCKER, 'ps', '--format', '{{.Names}}\t{{.Ports}}'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  for (const line of text.split('\n')) {
    const [name, portsCol] = line.split('\t')
    if (!name || !portsCol) continue
    for (const m of portsCol.matchAll(/:(\d+)->\d+\/tcp/g)) map.set(Number(m[1]), name)
  }
  return map
}

const REAL_PROXIES = await findRealProxies()
const PUBLISHED = await publishedByDocker()
/** One real, Docker-confirmed published port with both a v4 and a v6 proxy. */
const TARGET = (() => {
  for (const v4 of REAL_PROXIES.filter((p) => p.hostIp === '0.0.0.0')) {
    const v6 = REAL_PROXIES.find((p) => p.hostIp === '::' && p.hostPort === v4.hostPort)
    const container = PUBLISHED.get(v4.hostPort)
    if (v6 && container) return { port: v4.hostPort, v4Pid: v4.pid, v6Pid: v6.pid, container }
  }
  return null
})()
const canDocker = canRun && TARGET !== null
if (!canDocker) console.log('[attribution-2] no real Docker-published docker-proxy pair — docker cases skipped')

// --- renamed processes -------------------------------------------------------

// argv: <comm as hex> <bind: "none" | "127.0.0.1"> [extra argv words...].
// The comm is passed as hex so trailing spaces, tabs, newlines and partial
// UTF-8 reach prctl byte-for-byte; the kernel truncates to 15 bytes itself.
const RENAMED = `
import ctypes, socket, sys, time
name = bytes.fromhex(sys.argv[1])
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(15, ctypes.c_char_p(name), 0, 0, 0)
port = 0
if sys.argv[2] != "none":
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((sys.argv[2], 0)); s.listen()
    port = s.getsockname()[1]
print("READY %d" % port, flush=True)
time.sleep(60)
`

const spawned = new Set<number>()
afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  return buf.split('\n')[0] ?? ''
}

interface Renamed {
  pid: number
  port: number
  kill(): Promise<void>
}

async function spawnRenamed(comm: Uint8Array | string, bind: 'none' | '127.0.0.1', extra: string[] = []): Promise<Renamed> {
  const bytes = typeof comm === 'string' ? new TextEncoder().encode(comm) : comm
  const proc = Bun.spawn([PYTHON as string, '-c', RENAMED, Buffer.from(bytes).toString('hex'), bind, ...extra], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  spawned.add(proc.pid)
  const line = await readFirstLine(proc.stdout)
  const m = /^READY (\d+)$/.exec(line.trim())
  if (!m) throw new Error(`renamed child did not start: ${JSON.stringify(line)}`)
  return {
    pid: proc.pid,
    port: Number(m[1]),
    async kill() {
      proc.kill('SIGKILL')
      await proc.exited
    },
  }
}

function fakeProxyArgv(proto: string, hostIp: string, hostPort: number | string): string[] {
  return ['-proto', proto, '-host-ip', hostIp, '-host-port', String(hostPort), '-container-ip', '10.9.9.9', '-container-port', '1', '-use-listen-fd']
}

async function withFakes<T>(argvs: string[][], fn: (pids: number[]) => Promise<T>): Promise<T> {
  const fakes: Renamed[] = []
  try {
    for (const argv of argvs) fakes.push(await spawnRenamed('docker-proxy', 'none', argv))
    for (const f of fakes) expect(await realComm(f.pid)).toBe('docker-proxy') // the fake really is named so
    return await fn(fakes.map((f) => f.pid))
  } finally {
    for (const f of fakes) await f.kill()
  }
}

const rowsAt = (body: Body, port: number, addr?: string) =>
  body.ports.filter((e) => e.protocol === 'tcp' && e.localPort === port && (addr === undefined || e.localAddress === addr))

const brief = (rows: PortEntry[]) =>
  rows.map((r) => ({ addr: r.localAddress, state: r.state, pid: r.pid, name: r.processName, attribution: r.attribution, container: r.container }))

/** The real proxy pair must win the TARGET port's two LISTEN rows, with real pids. */
function expectRealProxyWins(body: Body, context: unknown, container: string | null) {
  const t = TARGET as NonNullable<typeof TARGET>
  const v4 = rowsAt(body, t.port, '0.0.0.0').filter((r) => r.state === 'LISTEN')
  const v6 = rowsAt(body, t.port, '::').filter((r) => r.state === 'LISTEN')
  expect({ context, v4: brief(v4) }).toEqual({
    context,
    v4: [{ addr: '0.0.0.0', state: 'LISTEN', pid: t.v4Pid, name: 'docker-proxy', attribution: 'docker', container }],
  })
  expect({ context, v6: brief(v6) }).toEqual({
    context,
    v6: [{ addr: '::', state: 'LISTEN', pid: t.v6Pid, name: 'docker-proxy', attribution: 'docker', container }],
  })
}

/** Port 22 is ssh.socket: pid 1 via `service`, never `docker`, never a fake. */
function expectSshUntouched(body: Body, fakePids: number[]) {
  const rows = rowsAt(body, 22).filter((r) => r.state === 'LISTEN')
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    expect({ addr: r.localAddress, pid: r.pid, attribution: r.attribution, unit: r.unit, owner: r.owner }).toEqual({
      addr: r.localAddress,
      pid: 1,
      attribution: 'service',
      unit: 'ssh.socket',
      owner: 'root',
    })
  }
  expect(body.ports.filter((r) => r.pid !== null && fakePids.includes(r.pid))).toEqual([])
}

// ---------------------------------------------------------------------------
// Defect 1: fake docker-proxy, with real processes
// ---------------------------------------------------------------------------

describe.skipIf(!canDocker)('defect 1: a fake docker-proxy never wins a socket it does not hold', () => {
  test('a fake claiming a REAL Docker-published port: the real proxy still wins with its real pid and container', async () => {
    const t = TARGET as NonNullable<typeof TARGET>
    await withFakes(
      [fakeProxyArgv('tcp', '0.0.0.0', t.port), fakeProxyArgv('tcp', '::', t.port)],
      async (fakePids) => {
        const body = await getBody('listening')
        expectRealProxyWins(body, { port: t.port, fakePids }, t.container)
        expect(body.ports.filter((r) => r.pid !== null && fakePids.includes(r.pid))).toEqual([])
      },
    )
  }, 30_000)

  test('a fake claiming ports no container publishes (22, 5432, 6379, 80, and an unused one) takes none of them', async () => {
    const claims = [22, 5432, 6379, 80, 1]
    await withFakes(
      claims.flatMap((p) => [fakeProxyArgv('tcp', '0.0.0.0', p), fakeProxyArgv('tcp', '127.0.0.1', p), fakeProxyArgv('tcp', '::', p)]),
      async (fakePids) => {
        const body = await getBody('listening')
        expectSshUntouched(body, fakePids)
        for (const p of claims) {
          const docker = rowsAt(body, p).filter((r) => r.attribution === 'docker')
          expect({ port: p, docker: brief(docker) }).toEqual({ port: p, docker: [] })
        }
        expect(rowsAt(body, 1)).toEqual([]) // nothing listens on 1; a claim cannot conjure a row
      },
    )
  }, 30_000)

  test('a bound fake whose port a SECOND fake also claims keeps its own socket as `socket`, no container', async () => {
    const holder = await spawnRenamed('docker-proxy', '127.0.0.1')
    const claimer = await spawnRenamed('docker-proxy', 'none', fakeProxyArgv('tcp', '127.0.0.1', holder.port))
    try {
      const body = await getBody('listening')
      expect(brief(rowsAt(body, holder.port, '127.0.0.1'))).toEqual([
        { addr: '127.0.0.1', state: 'LISTEN', pid: holder.pid, name: 'docker-proxy', attribution: 'socket', container: null },
      ])
      expect(body.ports.filter((r) => r.pid === claimer.pid)).toEqual([])
    } finally {
      await holder.kill()
      await claimer.kill()
    }
  }, 30_000)

  test('a fake whose own bound port is claimed in its OWN argv stays `socket` with its own pid', async () => {
    // Bind first, then learn the port: the only way for one process to carry
    // `-host-port <its own port>` is to pick a free port up front and bind it.
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = probe.port
    probe.stop(true)
    const src = RENAMED.replace('s.bind((sys.argv[2], 0))', `s.bind((sys.argv[2], ${port}))`)
    const proc = Bun.spawn(
      [PYTHON as string, '-c', src, Buffer.from('docker-proxy').toString('hex'), '127.0.0.1', ...fakeProxyArgv('tcp', '127.0.0.1', port)],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    spawned.add(proc.pid)
    try {
      const line = await readFirstLine(proc.stdout)
      if (line.trim() !== `READY ${port}`) throw new Error(`port ${port} was taken before the fake could bind it: ${line}`)
      const body = await getBody('listening')
      expect(brief(rowsAt(body, port, '127.0.0.1'))).toEqual([
        { addr: '127.0.0.1', state: 'LISTEN', pid: proc.pid, name: 'docker-proxy', attribution: 'socket', container: null },
      ])
    } finally {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }, 30_000)

  test('several fakes at once (real port v4+v6, 22, 5432, duplicates of each) change nothing', async () => {
    const t = TARGET as NonNullable<typeof TARGET>
    const claims = [
      fakeProxyArgv('tcp', '0.0.0.0', t.port),
      fakeProxyArgv('tcp', '0.0.0.0', t.port),
      fakeProxyArgv('tcp', '::', t.port),
      fakeProxyArgv('tcp', '::', t.port),
      fakeProxyArgv('tcp', '0.0.0.0', 22),
      fakeProxyArgv('tcp', '::', 22),
      fakeProxyArgv('tcp', '127.0.0.1', 5432),
      fakeProxyArgv('udp', '0.0.0.0', t.port),
    ]
    await withFakes(claims, async (fakePids) => {
      const body = await getBody('listening')
      expectRealProxyWins(body, { port: t.port, fakes: fakePids.length }, t.container)
      expectSshUntouched(body, fakePids)
    })
  }, 30_000)

  test('duplicated or conflicting flags (-host-port 22 -host-port <real>, and the reverse) change nothing', async () => {
    const t = TARGET as NonNullable<typeof TARGET>
    const base = ['-container-ip', '10.9.9.9', '-container-port', '1']
    const claims = [
      ['-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', '22', '-host-port', String(t.port), ...base],
      ['-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', String(t.port), '-host-port', '22', ...base],
      ['-proto', 'udp', '-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', String(t.port), ...base],
      ['-proto', 'tcp', '-host-ip', '::', '-host-ip', '0.0.0.0', '-host-port', '22', ...base],
      ['-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', '22', ...base, '-proto', 'tcp', '-host-port', String(t.port)],
    ]
    await withFakes(claims, async (fakePids) => {
      const body = await getBody('listening')
      expectRealProxyWins(body, { port: t.port, fakes: fakePids.length }, t.container)
      expectSshUntouched(body, fakePids)
    })
  }, 30_000)
})

// Docker unreachable, end to end through getPorts(scope, cli): a real
// DockerCli-shaped fake stands in for each way the daemon can be unavailable.
// The contract (fix 1, check (c)): the published-port check is WAIVED, so a
// genuine root docker-proxy in docker.service still wins with container null —
// and a same-account fake still never does, because (a) and (b) still apply.

const DAEMON_DOWN_STDERR = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
const UNREACHABLE: Array<[string, DockerCli]> = [
  [
    'daemon down (docker exits 1)',
    {
      run: async () => ({ ok: false, stdout: '', stderr: DAEMON_DOWN_STDERR, exitCode: 1 }),
      stream: () => {
        throw new Error('not used')
      },
    },
  ],
  [
    'docker binary missing (spawn ENOENT)',
    {
      run: async () => ({ ok: false, stdout: '', stderr: 'ENOENT: no such file or directory, posix_spawn docker', exitCode: -127 }),
      stream: () => {
        throw new Error('not used')
      },
    },
  ],
  [
    'cli throws',
    {
      run: async () => {
        throw new Error('EACCES /var/run/docker.sock')
      },
      stream: () => {
        throw new Error('not used')
      },
    },
  ],
]

describe.skipIf(!canDocker)('defect 1: Docker unreachable — the real verified proxy still wins, fakes still lose', () => {
  for (const [label, cli] of UNREACHABLE) {
    test(`${label}: real proxy is docker with container null; a fake claiming it and 22 wins nothing`, async () => {
      const t = TARGET as NonNullable<typeof TARGET>
      await withFakes([fakeProxyArgv('tcp', '0.0.0.0', t.port), fakeProxyArgv('tcp', '0.0.0.0', 22)], async (fakePids) => {
        const result = await ports.getPorts('listening', cli)
        const body = { source: result.source, ports: result.ports }
        expect(body.source).toBe('ss')
        expectRealProxyWins(body, { label }, null)
        expectSshUntouched(body, fakePids)
      })
    }, 30_000)
  }

  test('a hung Docker (never answers): the 5s query deadline waives (c) and the real proxy still wins', async () => {
    const t = TARGET as NonNullable<typeof TARGET>
    const hung: DockerCli = {
      run: () => new Promise(() => {}),
      stream: () => {
        throw new Error('not used')
      },
    }
    const t0 = performance.now()
    const result = await ports.getPorts('listening', hung)
    const ms = performance.now() - t0
    expect(ms).toBeGreaterThanOrEqual(4900) // it really waited on the deadline
    expectRealProxyWins({ source: result.source, ports: result.ports }, { hung: true, port: t.port }, null)
  }, 30_000)

  test('unit: with Docker unreachable, [fake, real] and [real, fake] both resolve to the real candidate', async () => {
    const t = TARGET as NonNullable<typeof TARGET>
    const binding = { protocol: 'tcp' as const, hostIp: '0.0.0.0', hostPort: t.port, containerIp: '10.9.9.9', containerPort: 1 }
    const real = { pid: t.v4Pid, binding }
    const fake = { pid: process.pid, binding } // this process: non-root, not docker.service
    const socketCgroupPath = await realCgroup(t.v4Pid)
    for (const candidates of [[fake, real], [real, fake]]) {
      const winner = await ports.resolveDockerProxy(candidates, {
        socketCgroupPath,
        allowMissingCgroupFallback: false, // the ss path's value
        dockerReachable: false,
        isPublished: () => {
          throw new Error('must not be consulted when Docker is unreachable')
        },
        readUids: async (pid) => (await realUids(pid)) as [number, number, number, number] | null,
        readCgroup: realCgroup,
      })
      expect(winner?.pid).toBe(t.v4Pid)
    }
    // A root candidate in the WRONG cgroup (pid 1, init.scope) plus the real
    // one: still exactly one verifies.
    const initFake = { pid: 1, binding }
    const winner = await ports.resolveDockerProxy([initFake, real], {
      socketCgroupPath,
      allowMissingCgroupFallback: false, // the ss path's value
      dockerReachable: false,
      isPublished: () => false,
      readUids: async (pid) => (await realUids(pid)) as [number, number, number, number] | null,
      readCgroup: realCgroup,
    })
    expect(winner?.pid).toBe(t.v4Pid)
  })
})

// ---------------------------------------------------------------------------
// Defect 2: a comm shaped like `-e` tail tokens, on a real readable socket
// ---------------------------------------------------------------------------

/** What `ss` actually printed as the name for `pid`'s entry, read from a raw
 * `ss -e` run by locating the known pid — not by parsing the name. */
async function ssPrintedName(pid: number, port: number): Promise<{ line: string; printed: string | null }> {
  const proc = Bun.spawn([SS_BIN as string, '-H', '-t', '-n', '-p', '-e', '-l', `sport = :${port}`], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  const marker = `",pid=${pid},fd=`
  const at = text.indexOf(marker)
  const start = text.lastIndexOf('users:(("', at)
  const printed = at === -1 || start === -1 ? null : text.slice(start + 'users:(("'.length, at)
  return { line: text.trim(), printed }
}

const enc = (s: string) => new TextEncoder().encode(s)
const COMMS: Array<[string, Uint8Array]> = [
  ['svc log:1', enc('svc log:1')],
  ['x cgroup:/a', enc('x cgroup:/a')],
  ['a)) ino:1 sk:1', enc('a)) ino:1 sk:1')],
  ['a uid:0', enc('a uid:0')],
  ['q v6only:1', enc('q v6only:1')],
  ['z sk:ff', enc('z sk:ff')],
  [')) x:1', enc(')) x:1')],
  ['a:1 b:2 c:3', enc('a:1 b:2 c:3')],
  ['x ino:0 (orphan forgery)', enc('x ino:0')],
  ['uid:0 ino:0', enc('uid:0 ino:0')],
  ['cgroup:/x.svc', enc('cgroup:/x.svc')],
  ['a" uid:0 (quote)', enc('a" uid:0')],
  ['" cgroup:/x (quote)', enc('" cgroup:/x')],
  ['x users:(()) ', enc('x users:(())')],
  ['a <-> uid:0', enc('a <-> uid:0')],
  ['trailing space', enc('svc log:1 ')],
  ['two trailing spaces', enc('svc  ')],
  ['inner double space', enc('a  uid:0')],
  ['tab before a tail token', enc('a\tuid:0')],
  ['UTF-8 é x7', enc('ééééééé')],
  ['UTF-8 日本語 k:v', enc('日本語 k:1')],
  ['UTF-8 split at 15 bytes', enc('éééééééé')],
]

describe.skipIf(!canRun)('defect 2: a tail-shaped comm on a readable socket is still `socket` with its own pid', () => {
  for (const [label, comm] of COMMS) {
    test(`comm ${label}: socket, own pid, exact comm, real owner and unit`, async () => {
      const child = await spawnRenamed(comm, '127.0.0.1')
      try {
        const truth = await realComm(child.pid)
        const unit = unitOf(await realCgroup(child.pid))
        const ss = await ssPrintedName(child.pid, child.port)
        const body = await getBody('listening')
        const rows = rowsAt(body, child.port, '127.0.0.1')
        const detail = { label, pid: child.pid, truth, printed: ss.printed, ssLine: ss.line, rows: brief(rows) }

        expect({ ...detail, n: rows.length }).toMatchObject({ n: 1 })
        const r = rows[0] as PortEntry
        // Never another pid, whatever else happens.
        expect({ ...detail, foreign: r.pid !== null && r.pid !== child.pid }).toMatchObject({ foreign: false })
        // owner/unit are this account's real values, never forged by the comm.
        expect({ ...detail, owner: r.owner, unit: r.unit }).toMatchObject({ owner: ME, unit })

        // Tightened for the inode design: the endpoint no longer depends on
        // what ss printed for the name (ss.printed is kept only as failure
        // detail), so our readable socket is ALWAYS `socket`, our pid, and the
        // byte-exact /proc comm — `none` would be a socket hidden by its name.
        expect({ ...detail, got: { pid: r.pid, name: r.processName, attribution: r.attribution } }).toMatchObject({
          got: { pid: child.pid, name: truth, attribution: 'socket' },
        })
      } finally {
        await child.kill()
      }
    }, 20_000)
  }
})

// ss prints a comm's bytes raw — including '\n' (checked on this host: comm
// `\nudp U 0 0 :9 x` comes back inside users:(("…")) with the newline intact).
// A newline in the comm therefore splits ONE ss line into two: the first ends
// inside users:(("… (an ambiguous claim, correctly rejected), and the second
// starts with text the comm chose and ends with the attacker's own GENUINE
// `-e` tail — but carries no users:(...) column at all, so it reads as an
// ordinary unclaimed socket. Nothing holds that socket: it does not exist.
describe.skipIf(!canRun)('defect 2: a newline in the comm must not fabricate a row attributed to another pid', () => {
  for (const [label, comm] of [
    ['phantom udp :9, peer `x`', enc('\nudp U 0 0 :9 x')],
    ['phantom udp :9, trailing space', enc('\nudp U 0 0 :9 ')],
    ['phantom tcp :9 after a prefix', enc('y\ntcp L 0 0 :9 ')],
  ] as const) {
    test(`comm ${label}: no row names a pid for a socket that does not exist, and ours is never another pid`, async () => {
      const child = await spawnRenamed(comm, '127.0.0.1')
      try {
        const truth = await realComm(child.pid)
        const ss = await ssPrintedName(child.pid, child.port)
        const body = await getBody('listening')
        // Independent truth: no real socket on this host is bound to local
        // port 9 (checked with ss -a before this suite existed), and no real
        // socket ever has an empty local address.
        const phantoms = body.ports.filter((e) => e.localAddress === '' || e.localPort === 9)
        const ours = rowsAt(body, child.port, '127.0.0.1')
        const detail = { label, pid: child.pid, truth, ssLine: ss.line, phantoms: brief(phantoms), ours: brief(ours) }
        expect({ ...detail, n: phantoms.length }).toMatchObject({ n: 0 })
        expect({ ...detail, n: ours.length }).toMatchObject({ n: 1 })
        const r = ours[0] as PortEntry
        // Tightened: no newline can hide our own socket or move its pid now.
        expect({ ...detail, got: { pid: r.pid, name: r.processName, attribution: r.attribution } }).toMatchObject({
          got: { pid: child.pid, name: truth, attribution: 'socket' },
        })
      } finally {
        await child.kill()
      }
    }, 20_000)
  }
})

// ---------------------------------------------------------------------------
// Regression on this host's real listeners. Each port is asserted only when
// `ss -e` shows it in the expected unit's cgroup, so another host skips the
// ports it does not have rather than failing for an unrelated reason.
// ---------------------------------------------------------------------------

async function ssListenCgroups(): Promise<Map<number, Set<string>>> {
  const proc = Bun.spawn([SS_BIN as string, '-H', '-t', '-n', '-e', '-l'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  const out = new Map<number, Set<string>>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    const port = Number((f[3] ?? '').split(':').pop())
    const unit = unitOf(/ cgroup:(\S+)/.exec(line)?.[1] ?? null)
    if (!Number.isInteger(port) || !unit) continue
    if (!out.has(port)) out.set(port, new Set())
    out.get(port)?.add(unit)
  }
  return out
}

describe.skipIf(!canRun)('regression: this host\'s well-known listeners attribute sensibly', () => {
  test('22 ssh.socket -> systemd/1, 80/443 nginx, 5432 postgres, 6379 redis-server (service); 8000 bun (socket); docker ports -> docker-proxy + container', async () => {
    const cgroups = await ssListenCgroups()
    const body = await getBody('listening')
    const expectations: Array<[number, string, Partial<PortEntry>]> = [
      [22, 'ssh.socket', { attribution: 'service', pid: 1, processName: (await realComm(1)) ?? 'systemd', owner: 'root' }],
      [80, 'nginx.service', { attribution: 'service', processName: 'nginx', owner: 'root' }],
      [443, 'nginx.service', { attribution: 'service', processName: 'nginx', owner: 'root' }],
      [5432, 'postgresql@18-main.service', { attribution: 'service', processName: 'postgres' }],
      [6379, 'redis-server.service', { attribution: 'service', processName: 'redis-server' }],
      [8000, 'agentoo-api.service', { attribution: 'socket', processName: 'bun', owner: ME }],
    ]
    let checked = 0
    for (const [port, unit, want] of expectations) {
      if (!cgroups.get(port)?.has(unit)) continue
      const rows = body.ports.filter((e) => e.protocol === 'tcp' && e.localPort === port && e.state === 'LISTEN')
      expect({ port, n: rows.length > 0 }).toEqual({ port, n: true })
      for (const r of rows) {
        expect({ port, ...r }).toMatchObject({ port, unit, ...want })
        // The named pid is really in that unit's cgroup (or is pid 1 for a
        // socket-activated unit with no process of its own yet).
        if (r.pid !== 1) expect({ port, unit: unitOf(await realCgroup(r.pid as number)) }).toEqual({ port, unit })
      }
      checked++
    }
    for (const proxy of REAL_PROXIES) {
      const container = PUBLISHED.get(proxy.hostPort)
      if (!container) continue
      const addr = proxy.hostIp
      const rows = body.ports.filter((e) => e.protocol === 'tcp' && e.localPort === proxy.hostPort && e.localAddress === addr && e.state === 'LISTEN')
      expect({ port: proxy.hostPort, addr, rows: brief(rows) }).toEqual({
        port: proxy.hostPort,
        addr,
        rows: [{ addr, state: 'LISTEN', pid: proxy.pid, name: 'docker-proxy', attribution: 'docker', container }],
      })
      checked++
    }
    console.log(`[attribution-2] host regression: ${checked} port groups checked`)
    expect(checked).toBeGreaterThan(0)
  }, 30_000)

  test('TIME-WAIT rows in scope=all: owner null, attribution none, pid null — including one we create', async () => {
    // Deterministic TIME-WAIT: the CLIENT closes first, so the client side of
    // the connection (ours, port known) enters TIME-WAIT and stays there ~60s.
    let serverSide: { end(): void } | null = null
    const srv = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open(s) { serverSide = s }, data() {}, close() {} } })
    let closed!: () => void
    const clientClosed = new Promise<void>((r) => { closed = r })
    const cli = await Bun.connect({ hostname: '127.0.0.1', port: srv.port, socket: { data() {}, close() { closed() } } })
    const clientPort = cli.localPort
    try {
      cli.end() // client FIN first
      await clientClosed
      await Bun.sleep(100)
      ;(serverSide as { end(): void } | null)?.end() // server FIN: client -> TIME-WAIT
      let tw: PortEntry[] = []
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(100)
        const body = await getBody('all')
        tw = body.ports.filter((e) => e.state === 'TIME-WAIT')
        if (tw.some((e) => e.localPort === clientPort)) break
      }
      const ours = tw.filter((e) => e.localPort === clientPort && e.peerPort === srv.port)
      expect({ clientPort, ours: ours.length }).toEqual({ clientPort, ours: 1 })
      const bad = tw.filter((e) => e.owner !== null || e.attribution !== 'none' || e.pid !== null)
      expect({ count: tw.length, bad }).toEqual({ count: tw.length, bad: [] })
    } finally {
      srv.stop(true)
    }
  }, 30_000)
})
