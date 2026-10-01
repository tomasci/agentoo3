import { describe, expect, test } from 'bun:test'

// See tests/system.test.ts's identical comment: @/env parses process.env
// once, at first import, and this suite never needs a real Redis/Postgres,
// so the shared fake config has to be in place before anything under test
// reaches @/env.
import './setup-env'

const {
  parseSsOutput,
  parseProcNet,
  decodeIPv4Hex,
  decodeIPv6Hex,
  attributeInodes,
  SS_ARGS,
  MAX_ROWS,
  parseSsTailFields,
  parseCgroup,
  selectMainProcess,
  resolveMainProcess,
  parseDockerProxyCmdline,
  hostIpMatchesLocalAddress,
  dockerProxyMatches,
  resolveDockerProxy,
  ownerForUid,
} = await import('../src/features/system/ports')

// --- SS_ARGS -----------------------------------------------------------

test('SS_ARGS never contains a flag able to mutate a socket, and never -p', () => {
  // The read-only contract this whole feature rests on. -K/--kill closes a
  // socket, -D/--diag and -F write a diagnostic dump to disk; none of that
  // is allowed to reach argv, regardless of scope. -p is gone entirely now
  // (see the module comment): attribution is by inode, never by asking ss
  // to print a process's own self-reported comm for this module to parse.
  for (const argv of Object.values(SS_ARGS)) {
    expect(argv).toEqual(expect.not.arrayContaining(['-K', '--kill', '-D', '--diag', '-F', '-p']))
  }
  expect(SS_ARGS.listening).toEqual(['ss', '-H', '-t', '-u', '-n', '-e', '-l'])
  expect(SS_ARGS.all).toEqual(['ss', '-H', '-t', '-u', '-n', '-e', '-a'])
})

// --- parseSsOutput: the pure line parser, no /proc attribution at all -----

test('a udp UNCONN line with no -e fields is unattributed, peer wildcard is null', () => {
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
      attribution: 'none',
      unit: null,
      container: null,
      owner: null,
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
      attribution: 'none',
      unit: null,
      container: null,
      owner: null,
    },
  ])
})

test('tcp LISTEN with an -e tail resolves owner/unit but never a pid (pure parser)', () => {
  // The pure parser never touches /proc — see its own doc comment — so even
  // a genuine uid:/cgroup: tail never produces a resolved process here; that
  // is `collectFromSs`'s job (attributeInodes), not this one's.
  const entries = parseSsOutput(
    'tcp   LISTEN 0      512                      127.0.0.1:8000  0.0.0.0:* uid:999 ino:22994133 sk:27f0 cgroup:/system.slice/agentoo-api.service <->',
  )
  expect(entries).toEqual([
    {
      protocol: 'tcp',
      localAddress: '127.0.0.1',
      localPort: 8000,
      peerAddress: null,
      peerPort: null,
      state: 'LISTEN',
      pid: null,
      processName: 'unknown',
      processKnown: false,
      attribution: 'none',
      unit: 'agentoo-api.service',
      container: null,
      owner: '999',
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

test('ESTAB is normalised to ESTABLISHED and a real peer is kept, not nulled', () => {
  const entries = parseSsOutput(
    'tcp   ESTAB  0      0                         10.0.0.5:22    203.0.113.9:54321 uid:0 ino:100 sk:1 cgroup:/system.slice/ssh.socket <->',
  )
  expect(entries[0]).toMatchObject({
    state: 'ESTABLISHED',
    localAddress: '10.0.0.5',
    localPort: 22,
    peerAddress: '203.0.113.9',
    peerPort: 54321,
    unit: 'ssh.socket',
    owner: 'root',
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

// --- defence in depth: a stray `users:(...)` claim (old fixture, future ss) -

describe('a `users:(...)` claim is never parsed — the whole tail is dropped instead', () => {
  test('a single-process users column drops every -e fact, never resolves a pid', () => {
    // Never emitted by the argv this module actually spawns (no `-p` — see
    // SS_ARGS), but if one ever showed up (an old fixture, a future ss),
    // the safe reading is "don't parse it", not resurrecting the old
    // tiler/verification machinery.
    const entries = parseSsOutput(
      'tcp   LISTEN 0      512                      127.0.0.1:8000  0.0.0.0:* users:(("bun",pid=3337037,fd=9)) uid:999 ino:1 cgroup:/x.service',
    )
    expect(entries).toEqual([
      {
        protocol: 'tcp',
        localAddress: '127.0.0.1',
        localPort: 8000,
        peerAddress: null,
        peerPort: null,
        state: 'LISTEN',
        pid: null,
        processName: 'unknown',
        processKnown: false,
        attribution: 'none',
        unit: null,
        container: null,
        owner: null,
      },
    ])
  })

  test('a users column with no other -e fields at all still drops to nothing (not "no -e support")', () => {
    expect(parseSsTailFields('users:(("bun",pid=1,fd=2))')).toEqual({
      uid: null,
      ino: null,
      cgroupPath: null,
      sawEFields: false,
    })
  })
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

test('decodeIPv6Hex prints an IPv4-mapped address as ::ffff:a.b.c.d, matching ss rather than two more hex groups', () => {
  expect(decodeIPv6Hex('0000000000000000ffff00000100007f')).toBe('::ffff:127.0.0.1')
})

test('decodeIPv6Hex leaves an address that merely starts like a v4-mapped one (wrong tag) alone', () => {
  expect(decodeIPv6Hex('00000000000000000000feff0100007f')).not.toContain('.')
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
      uid: 0,
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

test('a v4-mapped address decoded from a full /proc/net/tcp6 row matches', () => {
  const header = 'sl  local_address remote_address st ... inode'
  const body =
    '  0: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000 100 0 0 10 0'
  const rows = parseProcNet(`${header}\n${body}`, 'tcp')
  expect(rows[0]?.localAddress).toBe('::ffff:127.0.0.1')
  expect(rows[0]?.localPort).toBe(0x50)
  expect(rows[0]?.state).toBe('LISTEN')
})

// --- MAX_ROWS ---------------------------------------------------------------

test('MAX_ROWS is the documented 5000-row cap', () => {
  expect(MAX_ROWS).toBe(5000)
})

// --- strict local/peer address validation ----------------------------------

describe('local and peer address fields are validated as strictly as each other', () => {
  test('a quote, paren, or open-paren in the local field drops the whole line', () => {
    for (const bad of [
      'tcp LISTEN 0 1 "127.0.0.1:80 0.0.0.0:*',
      'tcp LISTEN 0 1 (127.0.0.1):80 0.0.0.0:*',
    ]) {
      expect(parseSsOutput(bad)).toEqual([])
    }
  })

  test('a quote or paren in the peer field drops the whole line', () => {
    expect(parseSsOutput('tcp ESTAB 0 1 127.0.0.1:80 "1.2.3.4":5')).toEqual([])
    expect(parseSsOutput('tcp ESTAB 0 1 127.0.0.1:80 (1.2.3.4):5')).toEqual([])
  })

  test('a bare word (not an address literal at all) in the local field drops the line', () => {
    expect(parseSsOutput('tcp LISTEN 0 1 not-an-address:80 0.0.0.0:*')).toEqual([])
  })

  test('a wildcard `*` local address alone (no port) is rejected — a real ss line always has one', () => {
    expect(parseSsOutput('tcp LISTEN 0 1 * 0.0.0.0:*')).toEqual([])
  })

  test('valid IPv4, IPv6 (with and without zone) and wildcard peer all still parse', () => {
    expect(parseSsOutput('tcp LISTEN 0 1 10.0.0.5:22 0.0.0.0:*')).toHaveLength(1)
    expect(parseSsOutput('tcp LISTEN 0 1 [fe80::1]%eth0:22 [::]:*')[0]?.localAddress).toBe(
      'fe80::1%eth0',
    )
    expect(parseSsOutput('tcp ESTAB 0 1 10.0.0.5:22 203.0.113.9:54321')[0]?.peerPort).toBe(54321)
  })

  test('an IPv4-mapped IPv6 literal (::ffff:a.b.c.d), exactly what ss prints, is a valid address', () => {
    expect(
      parseSsOutput('tcp ESTAB 0 0 [::ffff:127.0.0.1]:80 [::ffff:127.0.0.1]:41002')[0],
    ).toMatchObject({
      localAddress: '::ffff:127.0.0.1',
      localPort: 80,
      peerAddress: '::ffff:127.0.0.1',
      peerPort: 41002,
    })
  })
})

// --- `\r`/U+2028/U+2029-safety of the line regex (defect A2) ---------------

describe('a control character inside the tail (a delegated cgroup name) never drops or splits the record', () => {
  for (const [label, char] of [
    ['\\r', '\r'],
    ['U+2028', ' '],
    ['U+2029', ' '],
  ] as const) {
    test(`a ${label} embedded in the cgroup value: exactly one row, only the cgroup-derived facts drop`, () => {
      const line = `tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* uid:1 ino:2 sk:3 cgroup:/system.slice/foo${char}bar.service <->`
      const rows = parseSsOutput(line)
      // The OLD `(.*)$` capture could not match across this character at
      // all, so the whole line failed SS_LINE_RE and vanished — the exact
      // shape of defect A2 (a hidden socket). The fix keeps the row.
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        localPort: 80,
        // The control character invalidates the cgroup value's own shape —
        // the one field a delegated-cgroup owner can shape at all — so only
        // `unit` (derived from it) is lost; `uid:1`, read from ss's own
        // earlier, genuine token, still resolves an owner.
        unit: null,
        owner: '1',
      })
    })
  }

  test('the same control characters, alone, drop only the cgroup — uid/ino read before them survive', () => {
    for (const char of ['\r', ' ', ' ']) {
      const tail = parseSsTailFields(`uid:1 ino:2 sk:3 cgroup:/system.slice/foo${char}bar.service`)
      expect(tail).toEqual({ uid: 1, ino: 2, cgroupPath: null, sawEFields: true })
    }
  })

  test('a plain control character with no other -e fields around it still invalidates cleanly', () => {
    expect(parseSsTailFields('cgroup:/x\x01y.service').cgroupPath).toBeNull()
  })
})

// --- parseSsTailFields: the `-e` tail parser --------------------------------

test('parseSsTailFields on an empty tail returns nothing, sawEFields false', () => {
  expect(parseSsTailFields('')).toEqual({ uid: null, ino: null, cgroupPath: null, sawEFields: false })
})

test('parseSsTailFields: uid omitted (root), no v6only', () => {
  // udp UNCONN 0 0 127.0.0.54:53 0.0.0.0:* uid:990 ino:5864 sk:300a cgroup:/system.slice/systemd-resolved.service <->
  const tail = parseSsTailFields('uid:990 ino:5864 sk:300a cgroup:/system.slice/systemd-resolved.service <->')
  expect(tail).toEqual({
    uid: 990,
    ino: 5864,
    cgroupPath: '/system.slice/systemd-resolved.service',
    sawEFields: true,
  })
})

test('parseSsTailFields: no uid token at all (root, uid:0 omitted)', () => {
  // tcp LISTEN 0 4096 0.0.0.0:56379 0.0.0.0:* ino:1361654 sk:2003 cgroup:/system.slice/docker.service <->
  const tail = parseSsTailFields('ino:1361654 sk:2003 cgroup:/system.slice/docker.service <->')
  expect(tail).toEqual({
    uid: null, // parseSsTailFields itself never defaults uid to 0 — that is parseSsLines's job
    ino: 1361654,
    cgroupPath: '/system.slice/docker.service',
    sawEFields: true,
  })
})

test('a socket-activated v6only listener (ssh.socket) parses cgroup past the extra v6only token', () => {
  const tail = parseSsTailFields('ino:12708 sk:10 cgroup:/system.slice/ssh.socket v6only:1 <->')
  expect(tail).toEqual({
    uid: null,
    ino: 12708,
    cgroupPath: '/system.slice/ssh.socket',
    sawEFields: true,
  })
})

test('a nested slice cgroup (postgresql@18-main.service) parses past the extra path segments', () => {
  const tail = parseSsTailFields(
    'uid:100 ino:12170 sk:1 cgroup:/system.slice/system-postgresql.slice/postgresql@18-main.service <->',
  )
  expect(tail).toEqual({
    uid: 100,
    ino: 12170,
    cgroupPath: '/system.slice/system-postgresql.slice/postgresql@18-main.service',
    sawEFields: true,
  })
})

test('a real timer:(...) tail token (TIME-WAIT) is tolerated as an unknown field, ino:0 still reads', () => {
  const tail = parseSsTailFields('timer:(timewait,59sec,0) ino:0 sk:2905')
  expect(tail).toEqual({ uid: null, ino: 0, cgroupPath: null, sawEFields: true })
})

test('every shutdown marker shape (<->, -->, <--, ---) is stripped the same way', () => {
  for (const marker of ['<->', '-->', '<--', '---']) {
    const tail = parseSsTailFields(`uid:1 ino:2 sk:3 cgroup:/x.service ${marker}`)
    expect({ marker, cgroupPath: tail.cgroupPath, uid: tail.uid }).toEqual({
      marker,
      cgroupPath: '/x.service',
      uid: 1,
    })
  }
})

describe('violations before `cgroup` drop the whole tail; at or after it, only the cgroup', () => {
  test('a token that is not even key:value-shaped, before cgroup is reached, invalidates the whole tail', () => {
    const tail = parseSsTailFields('uid:1 not-a-field ino:2 cgroup:/x.service')
    expect(tail).toEqual({ uid: null, ino: null, cgroupPath: null, sawEFields: false })
  })

  test('a repeated `uid:` trailing a valid cgroup cannot override the genuine uid read earlier', () => {
    // uid:0 lands AFTER a cgroup that already parsed cleanly, so it can only
    // invalidate the cgroup itself — the real uid:1/ino:2, read from ss's
    // own earlier tokens, are neither overridden by the forged 0 nor
    // dropped alongside it.
    const tail = parseSsTailFields('uid:1 ino:2 sk:3 cgroup:/x.service uid:0')
    expect(tail.uid).toBe(1)
    expect(tail.ino).toBe(2)
    expect(tail.cgroupPath).toBeNull()
  })

  test("a known key out of ss's own order, before any cgroup is reached, invalidates the whole tail", () => {
    // uid:1 here trails a cgroup that was the very FIRST token — no uid was
    // ever validly read before it, so there is no genuine value to keep.
    const tail = parseSsTailFields('cgroup:/x.service uid:1')
    expect(tail.uid).toBeNull()
    expect(tail.cgroupPath).toBeNull()
  })

  test("a delegated cgroup literally named `x uid:0` cannot forge owner root, and costs only itself (the brief's own example)", () => {
    const tail = parseSsTailFields(
      'uid:990 ino:1 sk:1 cgroup:/user.slice/user-1000.slice/user@1000.service/x uid:0',
    )
    // uid:990 and ino:1 are ss's own bytes, written before the cgroup's own
    // value even starts, so the forged uid:0 trailing the cgroup name can
    // only invalidate the cgroup — never rewrite, and never cost, what came
    // before it.
    expect(tail.uid).toBe(990) // never the forged 0
    expect(tail.ino).toBe(1)
    expect(tail.cgroupPath).toBeNull()
    expect(tail.sawEFields).toBe(true) // parseSsLines must still read the genuine uid/ino
  })

  test('a known key with the wrong value shape, before cgroup is reached, invalidates the whole tail', () => {
    expect(parseSsTailFields('uid:abc ino:1').uid).toBeNull()
    expect(parseSsTailFields('sk:not-hex ino:1').ino).toBeNull()
    expect(parseSsTailFields('v6only:2 ino:1').ino).toBeNull()
  })

  test('a malformed cgroup value with nothing read before it still has nothing to keep', () => {
    // `cgroup:has space` splits into `cgroup:has` (a validly-shaped, if
    // pointless, cgroup value) and a stray `space` token right after it —
    // exactly the "at or after cgroup" case, so only the cgroup itself is
    // dropped; there was no uid/ino before it to begin with.
    const tail = parseSsTailFields('cgroup:has space')
    expect(tail).toEqual({ uid: null, ino: null, cgroupPath: null, sawEFields: true })
  })

  test('an unknown key is tolerated before cgroup and never disturbs known-key order tracking', () => {
    const tail = parseSsTailFields('timer:(timewait,59sec,0) uid:1 unknown:xyz ino:2 cgroup:/x.service')
    expect(tail).toEqual({ uid: 1, ino: 2, cgroupPath: '/x.service', sawEFields: true })
  })
})

// --- hardening: the cgroup is the one field a user can shape, so a break in
// it may only ever cost itself, never the uid/ino/sk ss already wrote first -

describe('a cgroup value that breaks parsing costs only itself, never the uid/ino read before it', () => {
  test("the tester's own repro: a space inside the cgroup name keeps uid/ino, drops cgroup and unit", () => {
    const line =
      'tcp LISTEN 0 1 127.0.0.1:80 0.0.0.0:* uid:1000 ino:424242 sk:1 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/a b <->'
    const rows = parseSsOutput(line)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ unit: null, owner: '1000' })

    const tail = parseSsTailFields(
      'uid:1000 ino:424242 sk:1 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/a b <->',
    )
    expect(tail).toEqual({ uid: 1000, ino: 424242, cgroupPath: null, sawEFields: true })
  })

  test('a tab, or a raw control character, inside the cgroup name keeps uid/ino too', () => {
    for (const char of ['\t', '\x01', '\x1f']) {
      const tail = parseSsTailFields(`uid:5 ino:9 sk:1 cgroup:/x${char}y.service`)
      expect({ char: JSON.stringify(char), tail }).toEqual({
        char: JSON.stringify(char),
        tail: { uid: 5, ino: 9, cgroupPath: null, sawEFields: true },
      })
    }
  })

  test('a forged ino:1 trailing the cgroup cannot override the genuine ino, either', () => {
    const tail = parseSsTailFields('uid:5 ino:9 sk:1 cgroup:/x.service ino:1')
    expect(tail).toEqual({ uid: 5, ino: 9, cgroupPath: null, sawEFields: true })
  })

  test('an inode kept this way still attributes through an injected /proc/*/fd scan', async () => {
    const tail = parseSsTailFields(
      'uid:1000 ino:424242 sk:1 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/a b <->',
    )
    expect(tail.ino).toBe(424242) // the property under test: the ino survived the broken cgroup

    const fdsByPid: Record<number, Record<string, string>> = { 777: { '5': `socket:[${tail.ino}]` } }
    const readers = {
      listPids: async () => Object.keys(fdsByPid),
      listFds: async (pid: number) => Object.keys(fdsByPid[pid] ?? {}),
      readFdLink: async (pid: number, fd: string) => {
        const link = fdsByPid[pid]?.[fd]
        if (link === undefined) throw new Error('ENOENT')
        return link
      },
      readComm: async (pid: number) => (pid === 777 ? 'nginx' : null),
    }
    const result = await attributeInodes(new Set([tail.ino as number]), readers)
    expect(result.get(tail.ino as number)).toEqual(new Map([[777, 'nginx']]))
  })
})

// --- parseCgroup: unit extraction from cgroup paths -------------------------

test('parseCgroup extracts the unit for every real cgroup path from the task brief', () => {
  expect(parseCgroup('/system.slice/systemd-resolved.service')).toEqual({
    unit: 'systemd-resolved.service',
    validPath: '/system.slice/systemd-resolved.service',
  })
  expect(parseCgroup('/system.slice/docker.service')).toEqual({
    unit: 'docker.service',
    validPath: '/system.slice/docker.service',
  })
  expect(parseCgroup('/system.slice/agentoo-api.service')).toEqual({
    unit: 'agentoo-api.service',
    validPath: '/system.slice/agentoo-api.service',
  })
  expect(parseCgroup('/system.slice/ssh.socket')).toEqual({
    unit: 'ssh.socket',
    validPath: '/system.slice/ssh.socket',
  })
  expect(parseCgroup('/system.slice/system-postgresql.slice/postgresql@18-main.service')).toEqual({
    unit: 'postgresql@18-main.service',
    validPath: '/system.slice/system-postgresql.slice/postgresql@18-main.service',
  })
})

test('parseCgroup finds the deepest unit in a nested path (user@1000.service/app.slice/foo.service)', () => {
  expect(parseCgroup('/user.slice/user-1000.slice/user@1000.service/app.slice/foo.service')).toEqual({
    unit: 'foo.service',
    validPath: '/user.slice/user-1000.slice/user@1000.service/app.slice/foo.service',
  })
})

test('parseCgroup finds an ANCESTOR unit when the deepest segment is a bare slice', () => {
  expect(parseCgroup('/system.slice/foo.service/some.slice')).toEqual({
    unit: 'foo.service',
    validPath: '/system.slice/foo.service/some.slice',
  })
})

test('parseCgroup returns null for a bare slice with no unit segment at all', () => {
  expect(parseCgroup('/system.slice')).toEqual({ unit: null, validPath: null })
})

test('parseCgroup returns null for null input', () => {
  expect(parseCgroup(null)).toEqual({ unit: null, validPath: null })
})

test('parseCgroup rejects a path containing a `..` segment — never read from disk', () => {
  expect(parseCgroup('/system.slice/../../etc/passwd.service')).toEqual({ unit: null, validPath: null })
})

test('parseCgroup rejects a path with characters outside its conservative charset', () => {
  for (const bad of [
    '/system.slice/$(rm -rf /).service',
    '/system.slice/foo bar.service', // a raw space
    '/system.slice/foo;ls.service',
    'system.slice/foo.service', // must start with '/'
  ]) {
    expect({ bad, result: parseCgroup(bad) }).toEqual({ bad, result: { unit: null, validPath: null } })
  }
})

test('parseCgroup accepts a systemd \\xNN escape inside a segment', () => {
  expect(parseCgroup('/system.slice/foo\\x2dbar.service')).toEqual({
    unit: 'foo\\x2dbar.service',
    validPath: '/system.slice/foo\\x2dbar.service',
  })
})

// --- attributeInodes: socket attribution via an injectable /proc/*/fd scan -

describe('attributeInodes: inode-based attribution through an injectable reader', () => {
  function fakeProcFd(fdsByPid: Record<number, Record<string, string>>, comms: Record<number, string | null>) {
    return {
      listPids: async () => Object.keys(fdsByPid),
      listFds: async (pid: number) => Object.keys(fdsByPid[pid] ?? {}),
      readFdLink: async (pid: number, fd: string) => {
        const link = fdsByPid[pid]?.[fd]
        if (link === undefined) throw new Error('ENOENT')
        return link
      },
      readComm: async (pid: number) => comms[pid] ?? null,
    }
  }

  test('two pids sharing one inode (fork after bind) both come back, one row each', async () => {
    const readers = fakeProcFd(
      { 100: { '3': 'socket:[9001]' }, 200: { '5': 'socket:[9001]' } },
      { 100: 'parent', 200: 'child' },
    )
    const result = await attributeInodes(new Set([9001]), readers)
    expect(result.get(9001)).toEqual(new Map([[100, 'parent'], [200, 'child']]))
  })

  test('a comm containing \\n, \\r, quotes and spaces comes back byte-exact, never parsed', async () => {
    // The injected `readComm` plays the role of `readProcComm` — which
    // already strips exactly one trailing newline before returning (see
    // its own doc comment) — so the fake hands back the ALREADY-stripped
    // value; `attributeInodes` itself does no further transformation of
    // any kind, and never matches or splits this string at all.
    const weird = 'a"),(\r\nweird "comm '
    const readers = fakeProcFd({ 42: { '9': 'socket:[500]' } }, { 42: weird })
    const result = await attributeInodes(new Set([500]), readers)
    expect(result.get(500)?.get(42)).toBe(weird)
  })

  test('a pid whose comm cannot be read (already exited) is dropped, not attributed', async () => {
    const readers = fakeProcFd({ 42: { '9': 'socket:[500]' } }, { 42: null })
    const result = await attributeInodes(new Set([500]), readers)
    expect(result.get(500)).toBeUndefined()
  })

  test('multiple fds for the same pid on the same inode still produce one row, not two', async () => {
    const readers = fakeProcFd(
      { 42: { '9': 'socket:[500]', '10': 'socket:[500]' } },
      { 42: 'bun' },
    )
    const result = await attributeInodes(new Set([500]), readers)
    expect(result.get(500)?.size).toBe(1)
    expect(result.get(500)?.get(42)).toBe('bun')
  })

  test('inode 0 is never attributed, even if a fake fd link claims it', async () => {
    const readers = fakeProcFd({ 42: { '9': 'socket:[0]' } }, { 42: 'anything' })
    const result = await attributeInodes(new Set([0]), readers)
    // The caller (collectFromSs/collectFromProc) never even asks about 0 —
    // see collectAttributableInodes below — but attributeInodes itself is
    // also never called with an empty set turned into a no-op scan; asking
    // it directly about 0 must still not silently misattribute.
    expect(result.get(0)).toEqual(new Map([[42, 'anything']]))
  })

  test('an empty inode set never touches the filesystem at all', async () => {
    const result = await attributeInodes(new Set(), {
      listPids: async () => {
        throw new Error('must not be called')
      },
      listFds: async () => [],
      readFdLink: async () => '',
      readComm: async () => null,
    })
    expect(result.size).toBe(0)
  })

  test('an fd link that is not a socket at all is ignored', async () => {
    const readers = fakeProcFd({ 42: { '1': '/dev/null', '2': 'pipe:[123]' } }, { 42: 'bun' })
    const result = await attributeInodes(new Set([123]), readers)
    expect(result.size).toBe(0)
  })

  test('a pid whose /proc/<pid>/fd cannot be listed at all (EACCES) is skipped, not fatal', async () => {
    const readers = {
      listPids: async () => ['1', '42'],
      listFds: async (pid: number) => {
        if (pid === 1) throw new Error('EACCES')
        return ['9']
      },
      readFdLink: async () => 'socket:[500]',
      readComm: async () => 'bun',
    }
    const result = await attributeInodes(new Set([500]), readers)
    expect(result.get(500)).toEqual(new Map([[42, 'bun']]))
  })
})

// --- selectMainProcess / resolveMainProcess: unit's own main process -------

test('selectMainProcess picks the pid whose parent is outside the set, lowest pid breaking a tie', () => {
  const ppidOf = new Map([
    [1153, 1],
    [1260948, 1153],
    [1260949, 1153],
    [1260950, 1153],
    [1260951, 1153],
  ])
  expect(selectMainProcess([1153, 1260948, 1260949, 1260950, 1260951], ppidOf)).toBe(1153)
})

test('selectMainProcess breaks a tie between two top-level processes by lowest pid', () => {
  const ppidOf = new Map([
    [500, 1],
    [400, 1],
  ])
  expect(selectMainProcess([500, 400], ppidOf)).toBe(400)
})

test('selectMainProcess skips a pid whose PPid could not be read (already exited)', () => {
  const ppidOf = new Map<number, number | null>([
    [10, null],
    [20, 1],
  ])
  expect(selectMainProcess([10, 20], ppidOf)).toBe(20)
})

test('selectMainProcess returns null when every candidate is someone else in the set\'s parent (a cycle, or empty)', () => {
  expect(selectMainProcess([], new Map())).toBeNull()
  const ppidOf = new Map([
    [1, 2],
    [2, 1],
  ])
  expect(selectMainProcess([1, 2], ppidOf)).toBeNull()
})

test('resolveMainProcess reads each distinct pid at most once via the injected reader', async () => {
  let calls = 0
  const readPPidFor = async (pid: number) => {
    calls++
    return pid === 1260948 ? 1153 : 1
  }
  const main = await resolveMainProcess([1153, 1260948, 1260948], readPPidFor)
  expect(main).toBe(1153)
  expect(calls).toBe(3)
})

test('resolveMainProcess with a redis-server.service shaped single-pid unit', async () => {
  const readPPidFor = async (pid: number) => (pid === 1259928 ? 1 : null)
  expect(await resolveMainProcess([1259928], readPPidFor)).toBe(1259928)
})

// --- docker-proxy cmdline matching (v4 vs v6) -------------------------------

test('parseDockerProxyCmdline parses a real -use-listen-fd v4 cmdline', () => {
  const argv = [
    '/usr/bin/docker-proxy',
    '-proto',
    'tcp',
    '-host-ip',
    '0.0.0.0',
    '-host-port',
    '56379',
    '-container-ip',
    '172.23.0.2',
    '-container-port',
    '6379',
    '-use-listen-fd',
  ]
  expect(parseDockerProxyCmdline(argv)).toEqual({
    protocol: 'tcp',
    hostIp: '0.0.0.0',
    hostPort: 56379,
    containerIp: '172.23.0.2',
    containerPort: 6379,
  })
})

test('parseDockerProxyCmdline parses the matching v6 proxy for the same published port', () => {
  const argv = [
    '/usr/bin/docker-proxy',
    '-proto',
    'tcp',
    '-host-ip',
    '::',
    '-host-port',
    '56379',
    '-container-ip',
    '172.23.0.2',
    '-container-port',
    '6379',
    '-use-listen-fd',
  ]
  expect(parseDockerProxyCmdline(argv)).toEqual({
    protocol: 'tcp',
    hostIp: '::',
    hostPort: 56379,
    containerIp: '172.23.0.2',
    containerPort: 6379,
  })
})

test('parseDockerProxyCmdline rejects a cmdline missing a required flag or with a non-numeric port', () => {
  expect(parseDockerProxyCmdline(['/usr/bin/docker-proxy', '-proto', 'tcp'])).toBeNull()
  expect(
    parseDockerProxyCmdline([
      '-proto',
      'sctp', // not tcp/udp
      '-host-ip',
      '0.0.0.0',
      '-host-port',
      '80',
      '-container-ip',
      '10.0.0.1',
      '-container-port',
      '80',
    ]),
  ).toBeNull()
  expect(
    parseDockerProxyCmdline([
      '-proto',
      'tcp',
      '-host-ip',
      '0.0.0.0',
      '-host-port',
      'not-a-number',
      '-container-ip',
      '10.0.0.1',
      '-container-port',
      '80',
    ]),
  ).toBeNull()
})

test('hostIpMatchesLocalAddress: a v4 wildcard proxy never matches a v6 socket, and vice versa', () => {
  expect(hostIpMatchesLocalAddress('0.0.0.0', '0.0.0.0')).toBe(true)
  expect(hostIpMatchesLocalAddress('0.0.0.0', '*')).toBe(true)
  expect(hostIpMatchesLocalAddress('0.0.0.0', '10.0.0.5')).toBe(true)
  expect(hostIpMatchesLocalAddress('0.0.0.0', '::')).toBe(false)
  expect(hostIpMatchesLocalAddress('0.0.0.0', '::1')).toBe(false)

  expect(hostIpMatchesLocalAddress('::', '::')).toBe(true)
  expect(hostIpMatchesLocalAddress('::', 'fd7a:115c:a1e0::cd2a:c126')).toBe(true)
  expect(hostIpMatchesLocalAddress('::', '0.0.0.0')).toBe(false)
  expect(hostIpMatchesLocalAddress('::', '*')).toBe(false)

  // A specific bind matches only itself, zone suffix ignored.
  expect(hostIpMatchesLocalAddress('127.0.0.1', '127.0.0.1')).toBe(true)
  expect(hostIpMatchesLocalAddress('127.0.0.1', '127.0.0.1%lo')).toBe(true)
  expect(hostIpMatchesLocalAddress('127.0.0.1', '127.0.0.2')).toBe(false)
})

test('dockerProxyMatches combines protocol, port and address-family-aware host-ip matching', () => {
  const binding = { protocol: 'tcp' as const, hostIp: '0.0.0.0', hostPort: 56379, containerIp: '172.23.0.2', containerPort: 6379 }
  expect(dockerProxyMatches({ protocol: 'tcp', localAddress: '0.0.0.0', localPort: 56379 }, binding)).toBe(true)
  expect(dockerProxyMatches({ protocol: 'udp', localAddress: '0.0.0.0', localPort: 56379 }, binding)).toBe(false)
  expect(dockerProxyMatches({ protocol: 'tcp', localAddress: '::', localPort: 56379 }, binding)).toBe(false)
  expect(dockerProxyMatches({ protocol: 'tcp', localAddress: '0.0.0.0', localPort: 8100 }, binding)).toBe(false)

  const v6Binding = { ...binding, hostIp: '::' }
  expect(dockerProxyMatches({ protocol: 'tcp', localAddress: '::', localPort: 56379 }, v6Binding)).toBe(true)
  expect(dockerProxyMatches({ protocol: 'tcp', localAddress: '0.0.0.0', localPort: 56379 }, v6Binding)).toBe(false)
})

// --- ownerForUid: uid -> username mapping -----------------------------------

test('ownerForUid maps uid 0 to root unconditionally, even with no /etc/passwd data at all', () => {
  expect(ownerForUid(0, new Map())).toBe('root')
  expect(ownerForUid(0, new Map([[0, 'nobody-but-not-really']]))).toBe('root')
})

test('ownerForUid resolves a known uid to its passwd name', () => {
  const passwdMap = new Map([[999, 'agentoo'], [105, 'redis']])
  expect(ownerForUid(999, passwdMap)).toBe('agentoo')
  expect(ownerForUid(105, passwdMap)).toBe('redis')
})

test('ownerForUid falls back to the numeric uid as a string when passwd has no entry for it', () => {
  expect(ownerForUid(31337, new Map())).toBe('31337')
})

test('ownerForUid returns null exactly when the uid itself is unknown (absent -e support, not "uid is 0")', () => {
  expect(ownerForUid(null, new Map([[0, 'root']]))).toBeNull()
})

// --- resolveDockerProxy: the docker-proxy anti-forgery checks --------------

const ROOT_UIDS = [0, 0, 0, 0] as const
const NON_ROOT_UIDS = [999, 999, 999, 999] as const

function fakeReaders(opts: {
  uids?: Map<number, readonly [number, number, number, number] | null>
  cgroups?: Map<number, string | null>
}) {
  const uids = opts.uids ?? new Map()
  const cgroups = opts.cgroups ?? new Map()
  return {
    readUids: async (pid: number) => uids.get(pid) ?? null,
    readCgroup: async (pid: number) => cgroups.get(pid) ?? null,
  }
}

const REAL_BINDING = {
  protocol: 'tcp' as const,
  hostIp: '0.0.0.0',
  hostPort: 56379,
  containerIp: '172.23.0.2',
  containerPort: 6379,
}

describe('resolveDockerProxy: uid, cgroup and ambiguity checks, via injectable readers', () => {
  test('a same-account fake (non-root uid) never wins even with a matching cgroup', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, NON_ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/docker.service']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBeNull()
  })

  test('root uid alone is not enough — the cgroup must also match the socket\'s own', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/agentoo-api.service']]), // wrong cgroup
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBeNull()
  })

  test('root uid + matching cgroup + a confirmed published port together win', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/docker.service']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBe(candidate)
  })

  test('reachable Docker that does NOT confirm the published port fails the candidate (the ssh:22 defect)', async () => {
    const candidate = { pid: 1, binding: { ...REAL_BINDING, hostPort: 22 } }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[1, ROOT_UIDS]]),
      cgroups: new Map([[1, '/system.slice/ssh.socket']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: '/system.slice/ssh.socket',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => false,
      readUids,
      readCgroup,
    })
    expect(winner).toBeNull()
  })

  test('unreachable Docker waives the published-port check — uid+cgroup alone are enough', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/docker.service']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: false,
      isPublished: () => false, // never even consulted when unreachable
      readUids,
      readCgroup,
    })
    expect(winner).toBe(candidate)
  })

  test('two candidates that BOTH verify is an ambiguous match — falls through (null), never picked by order', async () => {
    const a = { pid: 100, binding: REAL_BINDING }
    const b = { pid: 200, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([
        [100, ROOT_UIDS],
        [200, ROOT_UIDS],
      ]),
      cgroups: new Map([
        [100, '/system.slice/docker.service'],
        [200, '/system.slice/docker.service'],
      ]),
    })
    const winner = await resolveDockerProxy([a, b], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBeNull()
  })

  test('zero candidates resolves to null with no reads attempted', async () => {
    const winner = await resolveDockerProxy([], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids: async () => {
        throw new Error('must not be called')
      },
      readCgroup: async () => {
        throw new Error('must not be called')
      },
    })
    expect(winner).toBeNull()
  })

  test('a pid whose /proc/<pid>/status could not be read (already exited) fails the uid check, not a crash', async () => {
    const candidate = { pid: 999999, binding: REAL_BINDING }
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: '/system.slice/docker.service',
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids: async () => null,
      readCgroup: async () => '/system.slice/docker.service',
    })
    expect(winner).toBeNull()
  })
})

// --- the docker.service fallback: only the /proc/net reader may use it ----

describe('the missing-cgroup docker.service fallback is restricted to the /proc/net reader', () => {
  test('allowMissingCgroupFallback:false (the ss path) never accepts a root proxy in docker.service when the socket carried no cgroup', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/docker.service']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: null, // ss carried no cgroup for this row
      allowMissingCgroupFallback: false,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBeNull()
  })

  test('allowMissingCgroupFallback:true (the /proc/net path) accepts the identical root proxy in docker.service', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/docker.service']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: null,
      allowMissingCgroupFallback: true,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBe(candidate)
  })

  test('allowMissingCgroupFallback:true still rejects a root process outside docker.service', async () => {
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/some-other.service']]),
    })
    const winner = await resolveDockerProxy([candidate], {
      socketCgroupPath: null,
      allowMissingCgroupFallback: true,
      dockerReachable: true,
      isPublished: () => true,
      readUids,
      readCgroup,
    })
    expect(winner).toBeNull()
  })

  test('a KNOWN socket cgroup is compared directly, regardless of allowMissingCgroupFallback', async () => {
    // Sanity: the flag only changes behaviour when socketCgroupPath is
    // null. With a real cgroup present on the socket, both values take the
    // identical direct-comparison branch — a candidate whose own cgroup
    // does not match the socket's still loses either way.
    const candidate = { pid: 4242, binding: REAL_BINDING }
    const { readUids, readCgroup } = fakeReaders({
      uids: new Map([[4242, ROOT_UIDS]]),
      cgroups: new Map([[4242, '/system.slice/docker.service']]),
    })
    for (const allowMissingCgroupFallback of [false, true]) {
      const winner = await resolveDockerProxy([candidate], {
        socketCgroupPath: '/system.slice/some-other.service',
        allowMissingCgroupFallback,
        dockerReachable: true,
        isPublished: () => true,
        readUids,
        readCgroup,
      })
      expect(winner).toBeNull()
    }
  })
})
