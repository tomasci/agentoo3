// Independent attack on the THREE attribution passes added to GET
// /api/system/ports (see backend/src/features/system/ports.ts): `socket`,
// `docker` and `service`. The property under attack, stated once:
//
//   The endpoint must never attribute a socket to a process that does not hold
//   it. An honest `none` is acceptable; naming a wrong process — a foreign pid,
//   a fake docker-proxy, or a cgroup's main process when the real holder was
//   readable — is a defect. And a process's own attacker-controlled comm must
//   never let it forge `unit`, `owner` or its `attribution`.
//
// Unit-level cases drive the exported pure helpers (parseSsTailFields,
// parseCgroup, ownerForUid, parseSsOutput) directly. Real-process cases rename
// their own comm (prctl PR_SET_NAME via python ctypes) and/or craft an argv,
// bind a socket on 127.0.0.1:0, and require the endpoint's rows for that port
// to name only a real holder. Real-process cases need Linux + iproute2 `ss` +
// python3; skipped cleanly otherwise. Every spawned pid is force-killed in
// afterAll.

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { readdir, readFile } from 'node:fs/promises'
import { OpenAPIHono } from '@hono/zod-openapi'

const ports = await import('../src/features/system/ports')
const { portsResponseSchema } = await import('../src/features/system/schema')
const { systemRouter } = await import('../src/features/system/routes')
const { openApiValidationHook } = await import('../src/lib/openapi-hook')
const { AppError, errorBody } = await import('../src/lib/errors')

const SS_BIN = process.platform === 'linux' ? Bun.which('ss') : null
const PYTHON = Bun.which('python3')
const canRun = SS_BIN !== null && PYTHON !== null

type Row = {
  protocol: string
  localAddress: string
  localPort: number
  state: string
  pid: number | null
  processName: string
  processKnown: boolean
  attribution: 'socket' | 'docker' | 'service' | 'none'
  unit: string | null
  container: string | null
  owner: string | null
}
type Body = { source: string; ports: Row[] } & Record<string, unknown>

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', systemRouter)
app.onError((error, c) =>
  error instanceof AppError
    ? c.json(errorBody(error), error.status as 400)
    : c.json({ error: 'Internal server error' }, 500),
)

async function getBody(scope = 'listening'): Promise<Body> {
  const res = await app.request(`/api/system/ports?scope=${scope}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Body
  expect(body.source).toBe('ss')
  expect(portsResponseSchema.safeParse(body).success).toBe(true)
  return body
}

const spawned = new Set<number>()
function track(pid: number) {
  spawned.add(pid)
}
afterAll(() => {
  for (const pid of spawned) {
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

async function realComm(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/comm`, 'utf8')
    return raw.endsWith('\n') ? raw.slice(0, -1) : raw
  } catch {
    return null
  }
}

async function myUsername(): Promise<string> {
  const raw = await readFile('/proc/self/status', 'utf8')
  const uid = Number(/^Uid:\s*(\d+)/m.exec(raw)?.[1] ?? '-1')
  for (const line of (await readFile('/etc/passwd', 'utf8')).split('\n')) {
    const f = line.split(':')
    if (Number(f[2]) === uid && f[0]) return f[0]
  }
  return String(uid)
}

// python: prctl(PR_SET_NAME, argv[1]) then bind one TCP listener on
// 127.0.0.1:0, print the port, sleep. argv[2..] are extra argv words the
// process carries (so a fake docker-proxy can carry -host-port etc).
const RENAME_ONE = `
import ctypes, socket, sys, time
name = sys.argv[1].encode()[:15]
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(15, ctypes.c_char_p(name), 0, 0, 0)  # PR_SET_NAME
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0)); s.listen()
print(s.getsockname()[1], flush=True)
time.sleep(45)
`

// python: rename to comm, but bind NOTHING — used to plant a fake docker-proxy
// that claims a host port it does not hold at all. argv carries the proxy flags.
const RENAME_NOBIND = `
import ctypes, sys, time
name = sys.argv[1].encode()[:15]
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(15, ctypes.c_char_p(name), 0, 0, 0)
print("ready", flush=True)
time.sleep(45)
`

async function spawnRenamed(comm: string, extraArgv: string[] = []): Promise<{ pid: number; port: number }> {
  const proc = Bun.spawn([PYTHON as string, '-c', RENAME_ONE, comm, ...extraArgv], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  track(proc.pid)
  const port = Number((await readFirstLine(proc.stdout)).trim())
  expect(port).toBeGreaterThan(0)
  return { pid: proc.pid, port }
}

async function spawnFakeProxy(comm: string, argv: string[]): Promise<number> {
  const proc = Bun.spawn([PYTHON as string, '-c', RENAME_NOBIND, comm, ...argv], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  track(proc.pid)
  await readFirstLine(proc.stdout) // "ready"
  return proc.pid
}

// ---------------------------------------------------------------------------
// 1. `-e` tail injection through the comm (unit level + real process)
// ---------------------------------------------------------------------------

describe('a comm crafted to look like `-e` tail tokens cannot forge uid/unit/ino', () => {
  // Re-expressed for the inode redesign. These pinned the deleted behaviour
  // "the real rightmost uid/cgroup survive a users:(...) column full of forged
  // tokens". The property — a comm's forged tokens can never set owner=root,
  // a fake unit, or a pid — still holds, now by a stricter rule: any tail
  // carrying a users:( token is dropped whole, so NEITHER the forged nor the
  // genuine facts survive. (The endpoint never passes -p, so a real ss line
  // never carries one; the real-process test below checks the genuine facts
  // still arrive on the argv actually spawned.)
  test('parseSsTailFields: a comm full of forged tokens drops every field, forged and genuine alike', () => {
    const forged = '")) uid:0 ino:1 cgroup:/x'
    const tail = `users:((${forged}",pid=4242,fd=3)) uid:999 ino:5864 sk:300a cgroup:/system.slice/ssh.socket v6only:1 <->`
    expect(ports.parseSsTailFields(tail)).toEqual({ uid: null, ino: null, cgroupPath: null, sawEFields: false })
    // The same tail without the users: column keeps the genuine facts, so the
    // drop above is caused by the column and nothing else.
    const clean = 'uid:999 ino:5864 sk:300a cgroup:/system.slice/ssh.socket v6only:1 <->'
    expect(ports.parseSsTailFields(clean)).toEqual({ uid: 999, ino: 5864, cgroupPath: '/system.slice/ssh.socket', sawEFields: true })
  })

  test('parseSsOutput: a forged uid:0/cgroup in the comm never sets owner=root, a fake unit, or a pid', () => {
    const forged = '")) uid:0 cgroup:/system.slice/evil.service'
    const line = `tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:((${forged}",pid=4242,fd=3)) uid:990 ino:5 sk:6 cgroup:/system.slice/agentoo-api.service <->`
    const rows = ports.parseSsOutput(line)
    expect(rows.map((r) => ({ port: r.localPort, owner: r.owner, unit: r.unit, pid: r.pid, attribution: r.attribution }))).toEqual([
      { port: 80, owner: null, unit: null, pid: null, attribution: 'none' },
    ])
  })

  test.skipIf(!canRun)(
    'real process whose comm is `)) uid:0 ino:1`: owner is the real account, attribution socket, our pid',
    async () => {
      // The brief's exact injection shape. `uid:0`/`ino:1` collide with the
      // real (rightmost) uid:/ino: tokens ss appends, so the repeat-key guard
      // stops the scan before the comm's tokens are consumed.
      const { pid, port } = await spawnRenamed(')) uid:0 ino:1')
      const truth = await realComm(pid)
      const body = await getBody('listening')
      const rows = body.ports.filter((e) => e.localPort === port && e.localAddress === '127.0.0.1')
      const detail = { pid, port, truth, rows }
      expect({ ...detail, len: rows.length }).toMatchObject({ len: 1 })
      const r = rows[0] as Row
      // owner is our real account (uid 999 -> agentoo), never root from `uid:0`.
      expect({ ...detail, owner: r.owner }).toMatchObject({ owner: await myUsername() })
      // The fd is ours and readable, so `socket` must win with our own pid.
      expect({ ...detail, attribution: r.attribution, pid: r.pid, name: r.processName }).toMatchObject({
        attribution: 'socket',
        pid,
        name: truth,
      })
    },
    20_000,
  )
})

// ---------------------------------------------------------------------------
// 2. socket must win when the fd is readable — the tail parser must not
//    discard a genuine users:(...) claim, and a `.service` sibling must not
//    then be able to launder the socket onto its cgroup's main process.
// ---------------------------------------------------------------------------

describe('a readable socket is never laundered off its real holder', () => {
  test.skipIf(!canRun)(
    'a comm whose last word looks like `key:value` still resolves to socket + own pid',
    async () => {
      // A comm containing a space followed by a `word:` token, e.g. `svc log:1`.
      // ss prints it inside users:((...)); the endpoint must still attribute the
      // socket to THIS process (which holds it), not to its cgroup's main
      // process. socket must win whenever the fd is readable.
      const { pid, port } = await spawnRenamed('svc log:1')
      const truth = await realComm(pid)
      const body = await getBody('listening')
      const rows = body.ports.filter((e) => e.localPort === port && e.localAddress === '127.0.0.1')
      const detail = { pid, port, truth, rows }
      expect({ ...detail, len: rows.length }).toMatchObject({ len: 1 })
      const r = rows[0] as Row
      // The security property: the named pid must be a real holder (this pid),
      // never some other process in our cgroup.
      expect({ ...detail, foreignPid: r.pid !== null && r.pid !== pid }).toMatchObject({
        foreignPid: false,
      })
      expect({ ...detail, attribution: r.attribution, name: r.processName }).toMatchObject({ attribution: 'socket', name: truth })
    },
    20_000,
  )
})

// ---------------------------------------------------------------------------
// 3. `docker` attribution: a fake docker-proxy
// ---------------------------------------------------------------------------

describe('docker attribution cannot be forged by a fake docker-proxy', () => {
  test.skipIf(!canRun)(
    'a non-proxy process renamed to docker-proxy claiming -host-port 22 must NOT steal port 22',
    async () => {
      // Port 22 (ssh) is a real, root-owned listener that no docker-proxy holds.
      // A same-account process renames its comm to `docker-proxy` and carries a
      // `-proto tcp -host-ip 0.0.0.0 -host-port 22` argv. It does not — and
      // cannot — hold ssh's socket. The endpoint must not attribute port 22 to
      // this fake pid as `docker`.
      const before = (await getBody('listening')).ports.filter((e) => e.localPort === 22)
      const fakePid = await spawnFakeProxy('docker-proxy', [
        '-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', '22',
        '-container-ip', '10.9.9.9', '-container-port', '1', '-use-listen-fd',
      ])
      const comm = await realComm(fakePid)
      const rows = (await getBody('listening')).ports.filter((e) => e.localPort === 22)
      const detail = { fakePid, comm, before, rows }
      // Real port 22 listeners still exist.
      expect({ ...detail, present: rows.length >= 1 }).toMatchObject({ present: true })
      // NONE of them may be attributed to the fake's pid.
      const stolen = rows.filter((r) => r.pid === fakePid)
      expect({ ...detail, stolen }).toMatchObject({ stolen: [] })
      // And no port-22 row may be `docker` at all — ssh is not a container.
      const asDocker = rows.filter((r) => r.attribution === 'docker')
      expect({ ...detail, asDocker }).toMatchObject({ asDocker: [] })
    },
    20_000,
  )

  test.skipIf(!canRun)(
    'a fake proxy binding its own port cannot make that socket show as docker with a container',
    async () => {
      // The fake binds an ephemeral port P and claims `-host-port P`. Because
      // the fake owns (holds) P, ss resolves it and `socket` should win — the
      // row must name the fake as its own process via the fd table, NOT be
      // promoted to `docker` with someone else's container name.
      const port = 0 // replaced below
      const proc = Bun.spawn(
        [PYTHON as string, '-c', RENAME_ONE, 'docker-proxy'],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      track(proc.pid)
      const p = Number((await readFirstLine(proc.stdout)).trim())
      void port
      const rows = (await getBody('listening')).ports.filter(
        (e) => e.localPort === p && e.localAddress === '127.0.0.1',
      )
      const detail = { pid: proc.pid, port: p, rows }
      expect({ ...detail, len: rows.length }).toMatchObject({ len: 1 })
      const r = rows[0] as Row
      // The fd is ours and readable -> socket wins, no container attached.
      expect({ ...detail, attribution: r.attribution }).toMatchObject({ attribution: 'socket' })
      expect({ ...detail, container: r.container }).toMatchObject({ container: null })
      expect({ ...detail, pid: r.pid }).toMatchObject({ pid: proc.pid })
    },
    20_000,
  )
})

// A real docker-proxy IS attributed correctly — the positive control, so the
// negative cases above aren't just "docker attribution never fires".
describe('real docker-proxy attribution (positive control)', () => {
  test.skipIf(!canRun)('a real published container port comes back attribution docker with a container', async () => {
    // Find a real docker-proxy on this host and its -host-port; skip if none.
    let realPort: number | null = null
    let realPid: number | null = null
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const comm = await realComm(Number(entry))
      if (comm !== 'docker-proxy') continue
      const cmd = (await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).split('\0')
      const i = cmd.indexOf('-host-port')
      const ip = cmd[cmd.indexOf('-host-ip') + 1]
      if (i === -1 || ip !== '0.0.0.0') continue
      realPort = Number(cmd[i + 1])
      realPid = Number(entry)
      break
    }
    if (realPort === null) {
      console.log('[attribution] no real docker-proxy on 0.0.0.0 — skipping positive control')
      return
    }
    const rows = (await getBody('listening')).ports.filter(
      (e) => e.localPort === realPort && e.localAddress === '0.0.0.0',
    )
    expect(rows.length).toBe(1)
    const r = rows[0] as Row
    expect({ port: realPort, attribution: r.attribution, name: r.processName }).toMatchObject({
      port: realPort,
      attribution: 'docker',
      name: 'docker-proxy',
    })
    // The pid the endpoint named really is a docker-proxy holding that port.
    expect(await realComm(r.pid as number)).toBe('docker-proxy')
    expect(r.container).not.toBeNull()
    void realPid
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 4. cgroup path validation (unit level, through parseCgroup)
// ---------------------------------------------------------------------------

describe('parseCgroup rejects every hostile path before it becomes a filesystem read', () => {
  const reject = (p: string) => expect(ports.parseCgroup(p)).toEqual({ unit: null, validPath: null })

  test('a `..` traversal segment is rejected', () => {
    reject('/system.slice/../../etc/passwd')
    reject('/../etc')
    reject('/system.slice/..')
  })
  test('an absolute escape / double slash is rejected (empty segment)', () => {
    reject('//etc/shadow')
    reject('/system.slice//x.service')
  })
  test('a NUL byte anywhere in the path is rejected', () => {
    reject('/system.slice/x.service\0/y')
    reject('/system.slice/\0.service')
  })
  test('a relative (non-/-anchored) path is rejected', () => {
    reject('system.slice/x.service')
    reject('')
  })
  test('characters outside systemd\'s own set are rejected', () => {
    reject('/system.slice/x y.service') // space
    reject('/system.slice/$(rm).service')
    reject('/system.slice/a\tb.service')
  })
  test('a very long path is handled in bounded time and never crashes', () => {
    const t0 = performance.now()
    const long = `/system.slice/${'a'.repeat(200000)}.service`
    const res = ports.parseCgroup(long)
    const dt = performance.now() - t0
    // Valid charset, so it parses to a unit — but that is only a STRING here;
    // reading it would just miss on disk. The point is it does not hang.
    expect(dt).toBeLessThan(1000)
    expect(res.unit === null || res.unit.endsWith('.service')).toBe(true)
  })
  test('a valid systemd path with \\xNN escapes and nested slices is accepted', () => {
    expect(ports.parseCgroup('/system.slice/system-postgresql.slice/postgresql@18\\x2dmain.service')).toEqual({
      unit: 'postgresql@18\\x2dmain.service',
      validPath: '/system.slice/system-postgresql.slice/postgresql@18\\x2dmain.service',
    })
  })
  // A symlink planted UNDER /sys/fs/cgroup would let a validated path resolve
  // elsewhere on read — but /sys/fs/cgroup is a kernel-managed cgroup2 mount
  // this unprivileged account cannot create entries in, so the case is not
  // reachable here. Reported as UNVERIFIED rather than faked with a writable
  // stand-in that would not exercise the real code path.
})

// ---------------------------------------------------------------------------
// 5. uid -> owner mapping
// ---------------------------------------------------------------------------

describe('ownerForUid', () => {
  const empty = new Map<number, string>()
  test('uid 0 is root even with no passwd data (ss omits uid:0)', () => {
    expect(ports.ownerForUid(0, empty)).toBe('root')
    expect(ports.ownerForUid(0, new Map([[0, 'ignored']]))).toBe('root')
  })
  test('a uid with no passwd entry falls back to the numeric string, never a fabricated name', () => {
    expect(ports.ownerForUid(4242, empty)).toBe('4242')
    expect(ports.ownerForUid(4242, new Map([[4242, 'real']]))).toBe('real')
  })
  test('uid null (no -e support) is null owner, not root and not a guess', () => {
    expect(ports.ownerForUid(null, new Map([[0, 'root']]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. orphan sockets (TIME-WAIT etc.) must never be inferred
// ---------------------------------------------------------------------------

describe('orphan sockets stay none', () => {
  // An orphan is keyed on what the kernel says, not on the TCP state: `ss -e`
  // prints `ino:0` (and no cgroup) for a socket no process holds any more.
  // A FIN-WAIT-1/2 socket is NOT necessarily an orphan — one that was only
  // `shutdown(SHUT_WR)` is still held by its process, and `socket` with that
  // pid is the right answer for it. The snapshot is taken BEFORE the request:
  // a socket orphaned then is still orphaned (or gone) when the endpoint's own
  // ss runs, because an orphan never regains an inode — so the check cannot
  // race a socket that gets orphaned mid-request.

  // python: a listener L; pair 1 is accepted and the server side only
  // shutdown(SHUT_WR)s (-> held FIN-WAIT-2); pair 2 closes client-first then
  // server (-> client side orphaned in TIME-WAIT). Prints
  // "<listenPort> <pair1ClientPort> <pair2ClientPort>".
  const HALF_CLOSE = `
import socket, time
l = socket.socket(); l.bind(("127.0.0.1", 0)); l.listen()
addr = l.getsockname()
c1 = socket.create_connection(addr); a1, _ = l.accept()
a1.shutdown(socket.SHUT_WR)
c2 = socket.create_connection(addr); a2, _ = l.accept()
p2 = c2.getsockname()[1]
c2.close(); time.sleep(0.05); a2.close()
print(addr[1], c1.getsockname()[1], p2, flush=True)
time.sleep(40)
`

  /** Raw `addr:port` as ss prints it -> [address, port], unbracketed. */
  function splitRaw(raw: string): [string, string] {
    const m = /^\[(.*)\](%[^:]*)?:(\S+)$/.exec(raw)
    if (m) return [`${m[1]}${m[2] ?? ''}`, m[3] as string]
    const i = raw.lastIndexOf(':')
    return [raw.slice(0, i), raw.slice(i + 1)]
  }

  /** Keys of every `ino:0` socket in a fresh `ss -t -u -e -a` (-u too, so ss
   * prints the Netid column it omits for -t alone), plus whether any
   * such line carried a cgroup (it never should). Orphan lines have no
   * users:(...) column, so a whitespace split is safe for them. */
  async function orphanKeys(): Promise<{ keys: Set<string>; withCgroup: string[] }> {
    const proc = Bun.spawn([SS_BIN as string, '-H', '-t', '-u', '-n', '-e', '-a'], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const keys = new Set<string>()
    const withCgroup: string[] = []
    for (const line of text.split('\n')) {
      if (!/ ino:0( |$)/.test(line)) continue
      if (/ cgroup:/.test(line)) withCgroup.push(line.trim())
      const f = line.trim().split(/\s+/)
      const [la, lp] = splitRaw(f[4] ?? '')
      const [pa, pp] = splitRaw(f[5] ?? '')
      keys.add(`${f[0]}|${la}|${lp}|${pa}|${pp}`)
    }
    return { keys, withCgroup }
  }

  const keyOf = (e: Row & { peerAddress?: string | null; peerPort?: number | null }) =>
    `${e.protocol}|${e.localAddress}|${e.localPort}|${e.peerAddress ?? '*'}|${e.peerPort ?? '*'}`

  test.skipIf(!canRun)(
    'every ino:0 socket is none/null/null; a held shutdown()-only FIN-WAIT-2 keeps its real holder',
    async () => {
      const py = Bun.spawn([PYTHON as string, '-c', HALF_CLOSE], { stdout: 'pipe', stderr: 'ignore' })
      track(py.pid)
      try {
        const [listenPort, heldPeer, twPort] = (await readFirstLine(py.stdout)).trim().split(' ').map(Number)
        const heldKey = `tcp|127.0.0.1|${listenPort}|127.0.0.1|${heldPeer}`
        const twKey = `tcp|127.0.0.1|${twPort}|127.0.0.1|${listenPort}`
        // Wait until the kernel has settled both shapes (FIN acked, TIME-WAIT
        // entered) before the snapshot that defines "orphan".
        let snap = await orphanKeys()
        for (let i = 0; i < 40 && !snap.keys.has(twKey); i++) {
          await Bun.sleep(50)
          snap = await orphanKeys()
        }
        const body = await getBody('all')
        type Full = Row & { peerAddress: string | null; peerPort: number | null }
        const rows = body.ports as Full[]
        const detail = { listenPort, heldPeer, twPort, pyPid: py.pid }

        // Ground truth sanity: ss says our TIME-WAIT is an orphan, our held
        // FIN-WAIT-2 is not, and no orphan line carries a cgroup.
        expect({ ...detail, twOrphan: snap.keys.has(twKey), heldOrphan: snap.keys.has(heldKey), withCgroup: snap.withCgroup }).toEqual({
          ...detail,
          twOrphan: true,
          heldOrphan: false,
          withCgroup: [],
        })

        // Every row whose socket was an orphan before the request: no process,
        // no inference, no owner.
        const orphans = rows.filter((e) => snap.keys.has(keyOf(e)))
        const bad = orphans.filter((e) => e.attribution !== 'none' || e.pid !== null || e.owner !== null)
        expect({ ...detail, orphans: orphans.length, bad }).toMatchObject({ bad: [] })
        expect(orphans.some((e) => keyOf(e) === twKey && e.state === 'TIME-WAIT')).toBe(true)

        // The held half-closed socket is FIN-WAIT-2 and still ours.
        const held = rows.filter((e) => keyOf(e) === heldKey)
        expect({ ...detail, held: held.map((e) => ({ state: e.state, attribution: e.attribution, pid: e.pid })) }).toEqual({
          ...detail,
          held: [{ state: 'FIN-WAIT-2', attribution: 'socket', pid: py.pid }],
        })
      } finally {
        py.kill('SIGKILL')
        await py.exited
      }
    },
    20_000,
  )
})
