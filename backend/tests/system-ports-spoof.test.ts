// Independent re-verification of PID attribution in
// backend/src/features/system/ports.ts. Originally written against the
// `ss -p` users:(...) tiler; the endpoint now attributes by inode (`ss -e`'s
// `ino:<n>` plus a /proc/*/fd scan) and reads the name from /proc/<pid>/comm,
// so a comm's bytes never reach a parser at all.
//
// The property under attack, stated once: the endpoint must NEVER attribute a
// socket to a pid that does not actually hold it — and, now that the name
// comes from /proc, a socket this account can see into must come back
// `socket` with every real holder's pid and exact comm (an `unknown` there
// would be a socket hidden by its process name).
//
// Two attack surfaces:
//   * real processes — a process that rewrites its own comm
//     (prctl PR_SET_NAME via python ctypes), binds a listener and sleeps, and
//     two cooperating processes that fork() after bind() so both hold one
//     socket. For each we read the REAL /proc/<pid>/comm and require the
//     endpoint's rows for that port to be exactly the real holders.
//   * unit level — parseSsOutput on hand-built `users:((...))` columns: a line
//     still carrying one (an old capture, a future ss default) keeps its row
//     but yields no pid and no -e facts, whatever the column says.
//
// Real-process cases need Linux + iproute2 `ss` + python3; skipped cleanly
// otherwise. Every spawned pid is force-killed in afterAll.

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { readFile } from 'node:fs/promises'
import { OpenAPIHono } from '@hono/zod-openapi'

const ports = await import('../src/features/system/ports')
const { portsResponseSchema } = await import('../src/features/system/schema')
const { systemRouter } = await import('../src/features/system/routes')
const { openApiValidationHook } = await import('../src/lib/openapi-hook')
const { AppError, errorBody } = await import('../src/lib/errors')

const SS_BIN = process.platform === 'linux' ? Bun.which('ss') : null
const PYTHON = Bun.which('python3')
const canRun = SS_BIN !== null && PYTHON !== null

type PortRow = {
  protocol: string
  localAddress: string
  localPort: number
  state: string
  pid: number | null
  processName: string
  processKnown: boolean
}
type Body = { source: string; ports: PortRow[] } & Record<string, unknown>

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', systemRouter)
app.onError((error, c) =>
  error instanceof AppError
    ? c.json(errorBody(error), error.status as 400)
    : c.json({ error: 'Internal server error' }, 500),
)

async function getPortsBody(scope = 'listening'): Promise<Body> {
  const res = await app.request(`/api/system/ports?scope=${scope}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as Body
  expect(body.source).toBe('ss') // real ss is on PATH here
  expect(portsResponseSchema.safeParse(body).success).toBe(true)
  return body
}

async function runSsListening(): Promise<string> {
  const proc = Bun.spawn([SS_BIN ?? 'ss', '-H', '-t', '-u', '-n', '-p', '-l'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
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

function ssLineFor(rawSs: string, port: number): string {
  return (rawSs.split('\n').find((l) => l.includes(`:${port} `) || l.includes(`:${port}\t`)) ?? '').trim()
}

// python: rename self, bind one TCP listener on 127.0.0.1:0, print the port,
// then sleep. comm is argv[1], truncated to 15 bytes (kernel's own limit).
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

// python: bind+listen, fork, rename parent and child to two different comms —
// both hold the same socket. Prints "PIDS <parent> <child> <port>".
const RENAME_SHARED = `
import ctypes, socket, sys, os, time
nameA = sys.argv[1].encode()[:15]
nameB = sys.argv[2].encode()[:15]
libc = ctypes.CDLL("libc.so.6", use_errno=True)
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0)); s.listen()
port = s.getsockname()[1]
pid = os.fork()
if pid == 0:
    libc.prctl(15, ctypes.c_char_p(nameB), 0, 0, 0)
    time.sleep(45)
else:
    libc.prctl(15, ctypes.c_char_p(nameA), 0, 0, 0)
    sys.stdout.write("PIDS %d %d %d\\n" % (os.getpid(), pid, port)); sys.stdout.flush()
    time.sleep(45)
`

// The candidate comms from the task brief, plus extras. Each is set as a
// process's own comm; the kernel truncates to 15 bytes. (ss -p used to cut
// the printed name at the first ')'; the endpoint no longer reads that.)
const CANDIDATE_NAMES = [
  '",pid=1,fd=2),(',
  'a",pid=1',
  'x),("y',
  '",pid=1,fd=3)',
  'evil"',
  'pid=1,fd=2)',
  '1234567890,()"',
  ',()"=)(",pid=1)',
  'trailing space ',
  'ééééééé', // 14 bytes UTF-8 (7x é)
  'ééééééééé', // 18 bytes -> truncated to 15 -> splits a multibyte char
]

describe.skipIf(!canRun)('PID spoofing: single renamed process', () => {
  for (const name of CANDIDATE_NAMES) {
    test(`comm ${JSON.stringify(name)}: socket, own pid, exact comm — never a foreign pid`, async () => {
      const proc = Bun.spawn([PYTHON as string, '-c', RENAME_ONE, name], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      track(proc.pid)
      try {
        const port = Number((await readFirstLine(proc.stdout)).trim())
        expect(port).toBeGreaterThan(0)
        const truthComm = await realComm(proc.pid)
        const ssLine = ssLineFor(await runSsListening(), port)

        const body = await getPortsBody('listening')
        const rows = body.ports.filter(
          (e) => e.localPort === port && e.protocol === 'tcp' && e.localAddress === '127.0.0.1',
        )
        const detail = {
          name,
          realPid: proc.pid,
          truthComm,
          ssLine,
          rows: rows.map((r) => ({ pid: r.pid, name: r.processName })),
        }
        console.log(`[spoof-one] ${JSON.stringify(detail)}`)

        // The socket is ours, so it must appear (at least one row).
        expect({ ...detail, present: rows.length >= 1 }).toMatchObject({ present: true })

        // THE security property: every row is honest — null, or our real pid.
        // A spoof would surface as a row with some other non-null pid (e.g. 1).
        const foreign = rows.filter((r) => r.pid !== null && r.pid !== proc.pid)
        expect({ ...detail, foreign }).toMatchObject({ foreign: [] })

        // Tightened for the inode design: the fd is ours and readable, so the
        // ONLY right answer is one row, our pid, and the byte-exact comm the
        // kernel holds — ss's own sanitising of the printed name no longer
        // matters, and `unknown` would be a socket hidden by its name.
        expect({ ...detail, got: rows.map((r) => ({ pid: r.pid, name: r.processName, known: r.processKnown })) }).toMatchObject({
          got: [{ pid: proc.pid, name: truthComm, known: true }],
        })
      } finally {
        proc.kill('SIGKILL')
        await proc.exited
      }
    }, 20_000)
  }
})

describe.skipIf(!canRun)('PID spoofing: fork-shared socket, two renamed processes', () => {
  // commA crafts a boundary aimed at pid 1; commB is a second real name. A
  // wrong tiling would hand one of these sockets a pid that is neither holder.
  const PAIRS: Array<[string, string]> = [
    ['",pid=1,fd=2),(', 'real'],
    [',pid=1,fd=2),("', 'real'],
    ['x",pid=1,fd=3)', 'y",pid=1,fd=3)'],
    ['",pid=1', '",pid=2'],
    ['",pid=1,fd=2', 'a'],
  ]
  for (const [nameA, nameB] of PAIRS) {
    test(`shared [${nameA}] + [${nameB}]: exactly the two real pids, each its own comm`, async () => {
      const proc = Bun.spawn([PYTHON as string, '-c', RENAME_SHARED, nameA, nameB], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      track(proc.pid)
      let childPid = 0
      try {
        const first = await readFirstLine(proc.stdout) // "PIDS <parent> <child> <port>"
        const parts = first.trim().split(/\s+/)
        expect(parts[0]).toBe('PIDS')
        const parentPid = Number(parts[1])
        childPid = Number(parts[2])
        const port = Number(parts[3])
        track(childPid)
        expect(port).toBeGreaterThan(0)

        // Let the forked child finish its own prctl rename before we read its
        // comm, so ground truth is stable.
        await Bun.sleep(200)
        // Ground truth learned directly, independent of the parser: the two
        // real holders and each one's real comm.
        const holders = new Map<number, string | null>()
        holders.set(parentPid, await realComm(parentPid))
        holders.set(childPid, await realComm(childPid))

        const ssLine = ssLineFor(await runSsListening(), port)
        const body = await getPortsBody('listening')
        const rows = body.ports.filter(
          (e) => e.localPort === port && e.protocol === 'tcp' && e.localAddress === '127.0.0.1',
        )
        const detail = {
          nameA,
          nameB,
          holders: [...holders],
          ssLine,
          rows: rows.map((r) => ({ pid: r.pid, name: r.processName })),
        }
        console.log(`[spoof-shared] ${JSON.stringify(detail)}`)

        // Every returned pid must be a real holder or null — never a foreign
        // pid, and never one holder relabelled with the other's crafted name.
        const foreign = rows.filter((r) => r.pid !== null && !holders.has(r.pid))
        expect({ ...detail, foreign }).toMatchObject({ foreign: [] })
        // Tightened for the inode design: both holders are this account's, so
        // the rows are EXACTLY the two real pids, each with its own fresh
        // /proc comm — not `unknown`, and never the other process's name.
        const want = await Promise.all(
          [...holders.keys()].sort((a, b) => a - b).map(async (pid) => ({ pid, name: await realComm(pid), known: true })),
        )
        const got = rows
          .map((r) => ({ pid: r.pid, name: r.processName, known: r.processKnown }))
          .sort((a, b) => (a.pid ?? -1) - (b.pid ?? -1))
        expect({ ...detail, got }).toMatchObject({ got: want })
      } finally {
        proc.kill('SIGKILL')
        await proc.exited
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {}
        }
      }
    }, 20_000)
  }
})

// --- unit level: a users:(...) column is never parsed ------------------------
// These used to pin the deleted tiler's answer (the real pid survives a
// forged entry). The parser no longer reads that column at all: a line
// carrying one keeps its row, and loses every -e fact, so no pid can come out
// of it — neither the forged pid 1 nor the genuine one printed there. The
// real-process tests above check the genuine holder is still named, by inode.

describe('parser attribution on adversarial process columns (unit)', () => {
  const q = String.fromCharCode(34)
  const TAIL = 'uid:999 ino:171946 sk:1 cgroup:/system.slice/a.service <->'
  const line = (col: string) => `tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* ${col} ${TAIL}`
  const attr = (col: string) =>
    ports.parseSsOutput(line(col)).map((r) => ({ pid: r.pid, name: r.processName, known: r.processKnown, owner: r.owner, unit: r.unit }))
  const NOTHING = { pid: null, name: 'unknown', known: false, owner: null, unit: null }

  test('single process whose comm embeds a full fake entry: one row, no pid (neither fake nor printed)', () => {
    // comm = ",pid=1,fd=2" printed as ("",pid=1,fd=2",pid=<real>,fd=4)
    expect(attr(`users:((${q}${q},pid=1,fd=2${q},pid=987654,fd=4))`)).toEqual([NOTHING])
    // comm = ",pid=1,fd=2) (ends in a paren)
    expect(attr(`users:((${q}${q},pid=1,fd=2)${q},pid=987654,fd=4))`)).toEqual([NOTHING])
  })

  test('two-process shared socket with a boundary-forging commA: one row, no pid, -e facts dropped', () => {
    // ("",pid=1,fd=2),(",pid=A,fd=4),("real",pid=B,fd=5) with LARGE real pids.
    const col = `users:((${q}${q},pid=1,fd=2),(${q},pid=171946,fd=4),(${q}real${q},pid=171947,fd=5))`
    expect(attr(col)).toEqual([NOTHING])
  })

  test('the SAME shape with tiny real pids still never yields the forged pid 1', () => {
    const col = `users:((${q}${q},pid=1,fd=2),(${q},pid=7,fd=4),(${q}real${q},pid=8,fd=5))`
    const got = attr(col)
    expect(got.some((r) => r.pid === 1)).toBe(false)
    expect(got).toEqual([NOTHING])
  })

  test('a genuinely empty users:(()) column is one unknown row', () => {
    expect(attr('users:(())')).toEqual([NOTHING])
  })
})

// --- a huge users: column cannot stall the parser ----------------------------
// The tiler these used to time is gone; what still matters is that an
// adversarially long line (a future ss, a captured fixture) is rejected in
// bounded time and still yields exactly its one row.

describe('tiler stays fast on adversarial input', () => {
  test('a long column of quote-heavy near-entries that never fully tiles parses fast', () => {
    const q = String.fromCharCode(34)
    const inner = `(${q}${q.repeat(15)}${q},pid=1,fd=2),`.repeat(4000)
    const line = `tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(${inner}Z)`
    const t0 = performance.now()
    const rows = ports.parseSsOutput(line)
    const dt = performance.now() - t0
    console.log(`[tiler] quote-heavy len=${line.length} -> ${rows.length} rows in ${dt.toFixed(1)}ms`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.processKnown).toBe(false)
    expect(dt).toBeLessThan(1000)
  })

  test('thousands of fd-entries for one pid: one row, no pid, fast', () => {
    // Was "dedupe to a single (pid 42) row" — the dedup it pinned was the
    // tiler's; per-pid dedup is now attributeInodes', checked on a real
    // process with dup()'d fds in system-ports-verify.test.ts. CPU time, min
    // of 3, for the reason the original comment gave (wall time measured the
    // machine's load, not the parser).
    const inner = Array.from({ length: 4000 }, (_, i) => `("bun",pid=42,fd=${i})`).join(',')
    const line = `tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(${inner}) uid:999 ino:5 sk:1 cgroup:/system.slice/a.service <->`
    let rows = ports.parseSsOutput(line)
    expect(rows.map((r) => [r.pid, r.processName, r.owner, r.unit])).toEqual([[null, 'unknown', null, null]])

    let cpuMs = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i++) {
      const c0 = process.cpuUsage()
      rows = ports.parseSsOutput(line)
      const c = process.cpuUsage(c0)
      cpuMs = Math.min(cpuMs, (c.user + c.system) / 1000)
    }
    console.log(`[tiler] valid-entries len=${line.length} -> ${rows.length} rows in ${cpuMs.toFixed(1)}ms CPU (min of 3)`)
    expect(rows).toHaveLength(1)
    expect(cpuMs).toBeLessThan(1000)
  }, 60_000)
})

// --- IPv4-mapped IPv6 from /proc decodes the way ss prints it (fix 3) -----------
// /proc/net/*6 stores an address as four 32-bit words in host (little-endian)
// byte order; decodeIPv6Hex byte-swaps each word back to network order.

describe('IPv4-mapped IPv6 decoding (fix 3)', () => {
  test('::ffff:a.b.c.d is printed as a dotted quad, not as hex groups', () => {
    expect(ports.decodeIPv6Hex('0000000000000000FFFF00000100007F')).toBe('::ffff:127.0.0.1')
    expect(ports.decodeIPv6Hex('0000000000000000FFFF0000020000FA')).toBe('::ffff:250.0.0.2')
  })

  test('a non-mapped IPv6 address still compresses normally', () => {
    expect(ports.decodeIPv6Hex('00000000000000000000000001000000')).toBe('::1')
    expect(ports.decodeIPv6Hex('B80D0120000000000000000000000000')).toBe('2001:db8::')
  })

  test('ffff outside the v4-mapped position is NOT turned into a dotted quad', () => {
    expect(ports.decodeIPv6Hex('000000000000000000000000FFFF0000')).toBe('::ffff')
    expect(ports.decodeIPv6Hex('0120000000000000FFFF0000AABBCCDD')).not.toContain('.')
  })

  test('a v4-mapped address decoded from a full /proc/net/tcp6 row matches', () => {
    const header = 'sl  local_address remote_address st ... inode'
    const body =
      '  0: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000 100 0 0 10 0'
    const rows = ports.parseProcNet(`${header}\n${body}`, 'tcp')
    expect(rows[0]?.localAddress).toBe('::ffff:127.0.0.1')
    expect(rows[0]?.localPort).toBe(0x50)
    expect(rows[0]?.state).toBe('LISTEN')
  })
})
