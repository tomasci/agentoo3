import { expect, test } from 'bun:test'

// See tests/system.test.ts's identical comment: @/env parses process.env
// once, at first import, and this suite never needs a real Redis/Postgres,
// so the shared fake config has to be in place before anything under test
// reaches @/env.
import './setup-env'

const { parseSsOutput, parseProcNet, decodeIPv4Hex, decodeIPv6Hex, verifyProcesses, SS_ARGS, MAX_ROWS } =
  await import('../src/features/system/ports')

// --- parseSsOutput -----------------------------------------------------

test('SS_ARGS never contains a flag able to mutate a socket', () => {
  // The read-only contract this whole feature rests on. -K/--kill closes a
  // socket, -D/--diag and -F write a diagnostic dump to disk; none of that
  // is allowed to reach argv, regardless of scope.
  for (const argv of Object.values(SS_ARGS)) {
    expect(argv).toEqual(expect.not.arrayContaining(['-K', '--kill', '-D', '--diag', '-F']))
  }
  expect(SS_ARGS.listening).toEqual(['ss', '-H', '-t', '-u', '-n', '-p', '-l'])
  expect(SS_ARGS.all).toEqual(['ss', '-H', '-t', '-u', '-n', '-p', '-a'])
})

test('a udp UNCONN line with no process column is unattributed, peer wildcard is null', () => {
  const entries = parseSsOutput('udp   UNCONN 0      0                       127.0.0.54:53    0.0.0.0:*')
  expect(entries).toEqual([
    {
      protocol: 'udp',
      localAddress: '127.0.0.54',
      localPort: 53,
      peerAddress: null,
      peerPort: null,
      state: 'UNCONN',
      pid: null,
      processName: 'unknown',
      processKnown: false,
    },
  ])
})

test('a %iface suffix on the local address is kept as part of the address', () => {
  const entries = parseSsOutput('udp   UNCONN 0      0                    127.0.0.53%lo:53    0.0.0.0:*')
  expect(entries[0]?.localAddress).toBe('127.0.0.53%lo')
  expect(entries[0]?.localPort).toBe(53)
})

test('a %iface suffix survives on a non-loopback interface too', () => {
  const entries = parseSsOutput('udp   UNCONN 0      0                159.69.55.21%eth0:68    0.0.0.0:*')
  expect(entries[0]?.localAddress).toBe('159.69.55.21%eth0')
  expect(entries[0]?.localPort).toBe(68)
})

test('bracketed IPv6 local address and port, peer wildcard [::]:*', () => {
  const entries = parseSsOutput('udp   UNCONN 0      0                            [::1]:323      [::]:*')
  expect(entries).toEqual([
    {
      protocol: 'udp',
      localAddress: '::1',
      localPort: 323,
      peerAddress: null,
      peerPort: null,
      state: 'UNCONN',
      pid: null,
      processName: 'unknown',
      processKnown: false,
    },
  ])
})

test('tcp LISTEN with no process column', () => {
  const entries = parseSsOutput('tcp   LISTEN 0      200                      127.0.0.1:5432  0.0.0.0:*')
  expect(entries).toEqual([
    {
      protocol: 'tcp',
      localAddress: '127.0.0.1',
      localPort: 5432,
      peerAddress: null,
      peerPort: null,
      state: 'LISTEN',
      pid: null,
      processName: 'unknown',
      processKnown: false,
    },
  ])
})

test('a single-process users: column resolves pid and name', () => {
  const entries = parseSsOutput(
    'tcp   LISTEN 0      512                      127.0.0.1:8000  0.0.0.0:* users:(("bun",pid=3337037,fd=9))',
  )
  expect(entries).toEqual([
    {
      protocol: 'tcp',
      localAddress: '127.0.0.1',
      localPort: 8000,
      peerAddress: null,
      peerPort: null,
      state: 'LISTEN',
      pid: 3337037,
      processName: 'bun',
      processKnown: true,
    },
  ])
})

test('a long bracketed IPv6 address with a real port, peer [::]:*', () => {
  const entries = parseSsOutput(
    'tcp   LISTEN 0      4096   [fd7a:115c:a1e0::cd2a:c126]:63958    [::]:*',
  )
  expect(entries[0]).toMatchObject({
    protocol: 'tcp',
    localAddress: 'fd7a:115c:a1e0::cd2a:c126',
    localPort: 63958,
    peerAddress: null,
    peerPort: null,
    state: 'LISTEN',
  })
})

test('a shared socket with multiple processes becomes one row per distinct pid, fds deduped', () => {
  const entries = parseSsOutput(
    'tcp   LISTEN 0      511                        0.0.0.0:80    0.0.0.0:* ' +
      'users:(("nginx",pid=100,fd=6),("nginx",pid=200,fd=6),("nginx",pid=100,fd=8))',
  )
  expect(entries).toHaveLength(2)
  expect(entries.map((e) => e.pid).sort()).toEqual([100, 200])
  expect(entries.every((e) => e.processName === 'nginx' && e.processKnown)).toBe(true)
})

test('a process comm containing spaces and parens is extracted whole, not split on them', () => {
  const entries = parseSsOutput(
    'tcp   ESTAB  0      0                        127.0.0.1:9222 127.0.0.1:44444 users:(("Web Content",pid=4242,fd=15))',
  )
  expect(entries[0]).toMatchObject({
    state: 'ESTABLISHED',
    peerAddress: '127.0.0.1',
    peerPort: 44444,
    pid: 4242,
    processName: 'Web Content',
    processKnown: true,
  })
})

test('ESTAB is normalised to ESTABLISHED and a real peer is kept, not nulled', () => {
  const entries = parseSsOutput(
    'tcp   ESTAB  0      0                         10.0.0.5:22    203.0.113.9:54321 users:(("sshd",pid=555,fd=3))',
  )
  expect(entries[0]).toMatchObject({
    state: 'ESTABLISHED',
    localAddress: '10.0.0.5',
    localPort: 22,
    peerAddress: '203.0.113.9',
    peerPort: 54321,
    pid: 555,
    processName: 'sshd',
  })
})

test('old un-bracketed IPv6 form (:::PORT) is still parsed', () => {
  const entries = parseSsOutput('tcp   LISTEN 0      5                                :::8080         :::*')
  expect(entries[0]).toMatchObject({
    protocol: 'tcp',
    localAddress: '::',
    localPort: 8080,
    peerAddress: null,
    peerPort: null,
    state: 'LISTEN',
  })
})

test('a malformed line (too few fields) is skipped, not fatal to the rest', () => {
  const goodLine = 'tcp   LISTEN 0      200                      127.0.0.1:5432  0.0.0.0:*'
  const entries = parseSsOutput(['garbage line here', goodLine].join('\n'))
  expect(entries).toHaveLength(1)
  expect(entries[0]?.localPort).toBe(5432)
})

test('a header line is tolerated even though -H should already suppress it', () => {
  const entries = parseSsOutput(
    ['Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port', 'tcp   LISTEN 0      200                      127.0.0.1:5432  0.0.0.0:*'].join(
      '\n',
    ),
  )
  expect(entries).toHaveLength(1)
})

test('empty input parses to no entries, not an error', () => {
  expect(parseSsOutput('')).toEqual([])
  expect(parseSsOutput('\n\n')).toEqual([])
})

// --- /proc hex decoders --------------------------------------------------

test('decodeIPv4Hex reverses the little-endian byte order', () => {
  expect(decodeIPv4Hex('0100007F')).toBe('127.0.0.1')
  expect(decodeIPv4Hex('00000000')).toBe('0.0.0.0')
})

test('decodeIPv6Hex decodes a leading zero run to a leading ::', () => {
  expect(decodeIPv6Hex('00000000000000000000000001000000')).toBe('::1')
})

test('decodeIPv6Hex decodes an all-zero address to ::', () => {
  expect(decodeIPv6Hex('00000000000000000000000000000000')).toBe('::')
})

test('decodeIPv6Hex decodes a trailing zero run to a trailing ::', () => {
  expect(decodeIPv6Hex('000080FE000000000000000000000000')).toBe('fe80::')
})

test('decodeIPv6Hex decodes a middle zero run, matching a real link-local address from this host', () => {
  expect(decodeIPv6Hex('5C117AFD0000E0A10000000026C12ACD')).toBe('fd7a:115c:a1e0::cd2a:c126')
})

// --- parseProcNet ----------------------------------------------------------

const PROC_NET_TCP_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

test('parseProcNet decodes a LISTEN row and its inode', () => {
  const text = [
    PROC_NET_TCP_HEADER,
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55001 1 0000000000000000 100 0 0 10 0',
  ].join('\n')
  const rows = parseProcNet(text, 'tcp')
  expect(rows).toEqual([
    {
      localAddress: '127.0.0.1',
      localPort: 8080,
      peerAddress: '0.0.0.0',
      peerPort: 0,
      state: 'LISTEN',
      inode: 55001,
    },
  ])
})

test('parseProcNet maps udp st=07 to UNCONN, not tcp\'s CLOSED', () => {
  const text = [
    PROC_NET_TCP_HEADER,
    '   0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 12345 2 0000000000000000 0',
  ].join('\n')
  const rows = parseProcNet(text, 'udp')
  expect(rows[0]?.state).toBe('UNCONN')
})

test('parseProcNet maps tcp st=07 to CLOSED', () => {
  const text = [
    PROC_NET_TCP_HEADER,
    '   0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 12345 2 0000000000000000 0',
  ].join('\n')
  const rows = parseProcNet(text, 'tcp')
  expect(rows[0]?.state).toBe('CLOSED')
})

test('parseProcNet skips a malformed row rather than failing the whole file', () => {
  const text = [
    PROC_NET_TCP_HEADER,
    'not enough fields here',
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55001 1',
  ].join('\n')
  const rows = parseProcNet(text, 'tcp')
  expect(rows).toHaveLength(1)
  expect(rows[0]?.inode).toBe(55001)
})

// --- MAX_ROWS ---------------------------------------------------------------

test('MAX_ROWS is the documented 5000-row cap', () => {
  expect(MAX_ROWS).toBe(5000)
})

// --- IPv4-mapped IPv6 (defect 3) --------------------------------------------

test('decodeIPv6Hex prints an IPv4-mapped address as ::ffff:a.b.c.d, matching ss rather than two more hex groups', () => {
  // Same 16 bytes /proc/net/tcp6 would carry for ::ffff:127.0.0.1: 10 zero
  // bytes, ffff, then the v4 octets 127.0.0.1 — see the module comment on
  // formatIPv6 for why this shape is special-cased rather than compressed
  // the way every other address is.
  expect(decodeIPv6Hex('0000000000000000ffff00000100007f')).toBe('::ffff:127.0.0.1')
})

test('decodeIPv6Hex leaves an address that merely starts like a v4-mapped one (wrong tag) alone', () => {
  // groups[5] is 0xfffe, not 0xffff, so this must NOT take the v4-mapped
  // branch — it is an ordinary address with a run of leading zero groups.
  expect(decodeIPv6Hex('00000000000000000000feff0100007f')).not.toContain('.')
})

// --- process-column tiling, the adversarial shape from the task spec -------

test('a 15-byte name built to look like a second, unrelated entry still tiles to exactly one row', () => {
  // `users:(("",pid=1,fd=2),(",pid=999,fd=9))` — the only way to tile the
  // span completely is one entry: name '",pid=1,fd=2),(' (15 bytes,
  // comm's own cap), pid 999. A left-to-right, non-backtracking read would
  // stop at the first `,fd=\d+)` and misattribute this to pid 1 instead.
  const line = 'tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(("",pid=1,fd=2),(",pid=999,fd=9))'
  expect(parseSsOutput(line).map((r) => [r.pid, r.processName])).toEqual([[999, '",pid=1,fd=2),(']])
})

test('a process column with no valid tiling at all is one unknown row, not a guess', () => {
  // Missing the outer wrapper's own closing paren (real ss output always
  // has one past the last entry's) — nothing tiles the span completely, so
  // this must fall back exactly like an empty users:(()).
  const line = 'tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* users:(("a",pid=1,fd=2),("b",pid=2,fd=3)'
  expect(parseSsOutput(line)).toEqual([
    {
      protocol: 'tcp',
      localAddress: '127.0.0.1',
      localPort: 80,
      peerAddress: null,
      peerPort: null,
      state: 'LISTEN',
      pid: null,
      processName: 'unknown',
      processKnown: false,
    },
  ])
})

// --- verifyProcesses (defect 1b) --------------------------------------------

test('verifyProcesses keeps an entry whose pid still has that exact comm', async () => {
  const readComm = async (pid: number) => (pid === 42 ? 'bun' : null)
  const kept = await verifyProcesses([{ pid: 42, name: 'bun' }], readComm)
  expect(kept).toEqual([{ pid: 42, name: 'bun' }])
})

test('verifyProcesses drops an entry whose pid is now running under a different comm', async () => {
  // Exactly defect 1's attack shape: ss printed a name for this pid, but the
  // kernel's own comm for that pid right now says otherwise.
  const readComm = async () => 'init'
  const kept = await verifyProcesses([{ pid: 1, name: 'a",pid=1' }], readComm)
  expect(kept).toEqual([])
})

test('verifyProcesses drops an entry whose pid cannot be read at all (already exited)', async () => {
  const readComm = async () => null
  const kept = await verifyProcesses([{ pid: 999999, name: 'anything' }], readComm)
  expect(kept).toEqual([])
})

test('verifyProcesses reads each distinct pid at most once, even across many entries', async () => {
  let calls = 0
  const readComm = async (pid: number) => {
    calls++
    return pid === 7 ? 'nginx' : null
  }
  const kept = await verifyProcesses(
    [
      { pid: 7, name: 'nginx' },
      { pid: 7, name: 'nginx' },
      { pid: 7, name: 'nginx' },
      { pid: 8, name: 'nginx' },
    ],
    readComm,
  )
  expect(kept).toEqual([
    { pid: 7, name: 'nginx' },
    { pid: 7, name: 'nginx' },
    { pid: 7, name: 'nginx' },
  ])
  expect(calls).toBe(2) // one read for pid 7, one for pid 8 — never three and never four
})

test('verifyProcesses preserves extra fields on the objects it keeps (filters, does not rebuild)', async () => {
  const tagged = { pid: 1, name: 'bun', lineIndex: 3 }
  const kept = await verifyProcesses([tagged], async () => 'bun')
  expect(kept[0]).toBe(tagged) // same reference, not a copy
})
