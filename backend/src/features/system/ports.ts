// The host's current port -> process mapping — a structured `ss -tulpn`.
//
// Two readers, tried in order:
//   1. `ss` (fast, structured, gives us the process column when it can).
//   2. `/proc/net/{tcp,tcp6,udp,udp6}` plus a scan of `/proc/*/fd` for
//      attribution, used when `ss` is missing, exits non-zero, or its
//      output does not parse.
// `lsof` is deliberately not a third option: it is not guaranteed installed
// (unlike `ss`, which ships with iproute2 on every box this app targets),
// and on a host with a large process table it is far slower than either
// reader here — this endpoint is polled from a dashboard, not run once by
// hand.
//
// This box runs the backend as a non-root systemd service account (see
// backend/README.md). `ss -p` only resolves a process for sockets owned by
// the calling uid — every other row comes back with no process column at
// all, which is the ordinary result here, not a degraded one. The /proc
// fallback has the identical limit for the identical reason: readdir/readlink
// on another user's /proc/<pid>/fd throws EACCES, which is skipped silently
// rather than treated as a fault.

import { readdir, readFile, readlink } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { serviceUnavailable } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { readBounded } from '@/lib/spawn'

export type PortScope = 'listening' | 'all'
export type Protocol = 'tcp' | 'udp'

export interface PortEntry {
  protocol: Protocol
  localAddress: string
  localPort: number
  peerAddress: string | null
  peerPort: number | null
  state: string
  pid: number | null
  processName: string
  processKnown: boolean
}

export interface PortsResult {
  scope: PortScope
  source: 'ss' | 'proc'
  collectedAt: string
  user: string | null
  runningAsRoot: boolean
  total: number
  truncated: boolean
  unattributedCount: number
  ports: PortEntry[]
}

/** A dashboard renders these as a table; past this, more rows costs more
 * than it tells anyone looking at it. Exported so a test can pin the cap. */
export const MAX_ROWS = 5000

// Read-only by construction: `scope` only ever selects one of these two
// fixed argv arrays — nothing here is built from the request. `-K`/`--kill`
// (closes the socket), `-D`/`--diag` (writes a dump to disk) and `-F` are
// never used, and there is no shell to reinterpret anything even if they were.
export const SS_ARGS: Record<PortScope, string[]> = {
  listening: ['ss', '-H', '-t', '-u', '-n', '-p', '-l'],
  all: ['ss', '-H', '-t', '-u', '-n', '-p', '-a'],
}

const SS_TIMEOUT_MS = 5_000

// --- ss parsing, pure and exported for tests --------------------------------

/**
 * One candidate `("name",pid=N,fd=M)` read out of a `users:((...))` column,
 * before it has been checked against /proc — see `verifyProcesses` below.
 */
interface ProcessCandidate {
  pid: number
  name: string
}

/**
 * `users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))` is comm printed
 * unescaped: the name can itself contain spaces, parens, commas and quotes
 * ('tmux: server', '(sd-pam)', 'Web Content' — or, since any unprivileged
 * process can rewrite its own comm (prctl / /proc/self/comm, capped at 15
 * bytes), a name crafted to look like `"<real name>",pid=<other pid>` and
 * shift where a naive parser thinks the entry ends). Matching up to the
 * first quote, or up to the first `,fd=\d+\)`, both let a hostile comm
 * relabel its own socket onto a pid it does not own — observed on this
 * host: a socket owned by an ordinary process whose comm was set to
 * `a",pid=1` came back attributed to pid 1 (init).
 *
 * The only reading that cannot be steered by the name's own content is
 * tiling: the span between `users:(` and the final `)` must be covered
 * *completely* by `("<0-15 bytes>",pid=<digits>,fd=<digits>)` entries
 * joined by `,`. If no tiling covers the whole span, nothing here is
 * trustworthy and the column is treated as empty (unattributed), same as
 * `users:(())`. This tiling is unique even for a name built to look like
 * more than one entry — see `buildVerifiedEntries`, which cross-checks the
 * winning pid's own /proc/<pid>/comm for exactly the names where that
 * matters: the ones this had to look past an embedded quote to read.
 */
function parseProcessColumn(column: string): ProcessCandidate[] {
  if (!column.startsWith('users:(') || !column.endsWith(')')) return []
  const span = column.slice('users:('.length, -1)
  return tileProcessEntries(span) ?? []
}

/** One parsed entry at a fixed starting offset in `span`: where it ends, and
 * the pid/name it read. */
interface EntryMatch {
  end: number
  pid: number
  name: string
}

/** `span.charCodeAt(i)` is a decimal digit — checked by code point rather
 * than `span[i]` so a run's end never needs a non-null assertion to index
 * back into the string (charCodeAt is always a number, NaN past the end). */
function isDigitAt(span: string, i: number): boolean {
  const code = span.charCodeAt(i)
  return code >= 48 /* '0' */ && code <= 57 /* '9' */
}

/**
 * Every way to read one `("name",pid=N,fd=M)` entry starting at `span[start]`,
 * in order of increasing name length — the same order a lazy `.{0,15}?` in a
 * backtracking regex tries first. The name's own length is the only
 * ambiguity; pid and fd are each the maximal run of digits at their fixed
 * position, which is never ambiguous.
 */
function entryCandidatesAt(span: string, start: number): EntryMatch[] {
  const candidates: EntryMatch[] = []
  if (span[start] !== '(' || span[start + 1] !== '"') return candidates

  for (let nameLen = 0; nameLen <= 15; nameLen++) {
    const quoteIdx = start + 2 + nameLen
    if (quoteIdx >= span.length || span[quoteIdx] !== '"') continue

    let i = quoteIdx + 1
    if (span.slice(i, i + 5) !== ',pid=') continue
    i += 5
    const pidStart = i
    while (isDigitAt(span, i)) i++
    if (i === pidStart) continue // ',pid=' with no digits after it
    const pidEnd = i

    if (span.slice(i, i + 4) !== ',fd=') continue
    i += 4
    const fdStart = i
    while (isDigitAt(span, i)) i++
    if (i === fdStart) continue // ',fd=' with no digits after it

    if (span[i] !== ')') continue
    candidates.push({
      end: i + 1,
      pid: Number(span.slice(pidStart, pidEnd)),
      name: span.slice(start + 2, quoteIdx),
    })
  }
  return candidates
}

/**
 * A full tiling of `span` (the text between `users:(` and the final `)`)
 * into entries joined by `,`, covering it end to end — or null if no such
 * tiling exists. Memoized on start offset: the same suffix can be reached
 * through more than one choice of an earlier entry's name length, and every
 * recursive call strictly advances `start` (an entry is always at least a
 * few characters), so there is no cycle to guard against, only repeated
 * work to avoid.
 */
function tileProcessEntries(span: string): ProcessCandidate[] | null {
  const memo = new Map<number, ProcessCandidate[] | null>()

  function from(start: number): ProcessCandidate[] | null {
    if (start === span.length) return []
    if (memo.has(start)) return memo.get(start) ?? null

    let result: ProcessCandidate[] | null = null
    for (const candidate of entryCandidatesAt(span, start)) {
      if (candidate.end === span.length) {
        result = [{ pid: candidate.pid, name: candidate.name }]
        break
      }
      if (span[candidate.end] === ',') {
        const rest = from(candidate.end + 1)
        if (rest) {
          result = [{ pid: candidate.pid, name: candidate.name }, ...rest]
          break
        }
      }
    }
    memo.set(start, result)
    return result
  }

  return from(0)
}

/**
 * ss prints the process column unescaped and any process can rewrite its
 * own comm — see `parseProcessColumn` — so a tiling that parses cleanly is
 * still only a claim. The kernel's current `/proc/<pid>/comm` is the
 * tiebreaker: an entry is trusted only if that pid's comm, read right now,
 * is exactly the name ss printed for it. An entry whose pid has already
 * exited (comm unreadable) is dropped for the same reason a mismatch is —
 * there is nothing left to verify it against.
 *
 * `readComm` is injected so a unit test can drive this without a real
 * /proc, and is called at most once per distinct pid per invocation
 * (cached here), because the same pid legitimately recurs across many
 * sockets on one request.
 */
export async function verifyProcesses<T extends ProcessCandidate>(
  entries: T[],
  readComm: (pid: number) => Promise<string | null>,
): Promise<T[]> {
  const commCache = new Map<number, string | null>()
  const verified: T[] = []

  for (const entry of entries) {
    let comm = commCache.get(entry.pid)
    if (comm === undefined) {
      comm = await readComm(entry.pid)
      commCache.set(entry.pid, comm)
    }
    if (comm !== null && comm === entry.name) verified.push(entry)
  }

  return verified
}

/** A real comm can end in a space, so only the one trailing newline `comm`
 * files are terminated with is stripped — a full `.trim()` would also eat
 * that space and make a legitimate comm fail to match itself. */
function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

async function readCommForVerification(pid: number): Promise<string | null> {
  try {
    return stripTrailingNewline(await readFile(`/proc/${pid}/comm`, 'utf8'))
  } catch {
    return null // exited between ss's snapshot and this read, or unreadable
  }
}

/**
 * Splits an `address:port` field on the LAST colon, so an IPv6 address's own
 * colons are never mistaken for the port separator. Handles both ss's normal
 * bracketed form (`[::1]:323`, `[fe80::1]%eth0:546`) and the old un-bracketed
 * form some ss builds still print for a bare address (`:::22`), where the
 * generic last-colon split already does the right thing on its own.
 */
function splitHostPort(raw: string): { address: string; port: string } | null {
  if (!raw) return null

  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']')
    if (closeIdx === -1) return null
    const bracketed = raw.slice(1, closeIdx)
    const rest = raw.slice(closeIdx + 1)
    if (rest.startsWith('%')) {
      const colonIdx = rest.indexOf(':')
      if (colonIdx === -1) return null
      const zone = rest.slice(1, colonIdx)
      return { address: `${bracketed}%${zone}`, port: rest.slice(colonIdx + 1) }
    }
    if (!rest.startsWith(':')) return null
    return { address: bracketed, port: rest.slice(1) }
  }

  const lastColon = raw.lastIndexOf(':')
  if (lastColon === -1) return null
  return { address: raw.slice(0, lastColon), port: raw.slice(lastColon + 1) }
}

/** ss's own vocabulary, uppercased and with ESTAB normalised to the longer
 * form both /proc's decoder and the OpenAPI description use. */
function normalizeState(raw: string): string {
  const upper = raw.toUpperCase()
  return upper === 'ESTAB' ? 'ESTABLISHED' : upper
}

/**
 * A peer of '*' , or of '0.0.0.0'/'::' with no specific port, is not a real
 * peer — it is how ss and /proc both spell "unconnected" — so both fields
 * collapse to null rather than a client having to know that convention.
 */
function normalizePeer(
  address: string,
  port: number | null,
): { address: string | null; port: number | null } {
  const isWildcardAddress = address === '*' || address === '0.0.0.0' || address === '::'
  if (address === '*' || (isWildcardAddress && (port === null || port === 0))) {
    return { address: null, port: null }
  }
  return { address, port }
}

/** One socket row parsed out of `ss` output, before its process candidates
 * (if any) have been checked against /proc. */
interface ParsedSsLine {
  protocol: Protocol
  localAddress: string
  localPort: number
  peerAddress: string | null
  peerPort: number | null
  state: string
  processes: ProcessCandidate[]
}

function toUnknownEntry(line: ParsedSsLine): PortEntry {
  return {
    protocol: line.protocol,
    localAddress: line.localAddress,
    localPort: line.localPort,
    peerAddress: line.peerAddress,
    peerPort: line.peerPort,
    state: line.state,
    pid: null,
    processName: 'unknown',
    processKnown: false,
  }
}

function toKnownEntry(line: ParsedSsLine, proc: ProcessCandidate): PortEntry {
  return {
    protocol: line.protocol,
    localAddress: line.localAddress,
    localPort: line.localPort,
    peerAddress: line.peerAddress,
    peerPort: line.peerPort,
    state: line.state,
    pid: proc.pid,
    processName: proc.name,
    processKnown: true,
  }
}

/**
 * Parses `ss -H -t -u -n -p {-l|-a}` output into one row per socket line,
 * process candidates included but not yet checked against /proc (that step
 * needs to be async and is done separately — see `verifyProcesses` and
 * `collectFromSs` — so this stays synchronous and easy to unit test). A
 * line this cannot make sense of is skipped rather than failing the whole
 * request — one odd row (a future ss adding a netid, a truncated line)
 * should not cost every other one.
 */
function parseSsLines(text: string): ParsedSsLine[] {
  const lines: ParsedSsLine[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // -H should already suppress this, but an old ss ignoring the flag is
    // cheap to tolerate.
    if (/^(Netid|State)\b/.test(line)) continue

    const fields = line.split(/\s+/)
    if (fields.length < 6) continue

    const netidRaw = fields[0] ?? ''
    const stateRaw = fields[1] ?? ''
    const localRaw = fields[4] ?? ''
    const peerRaw = fields[5] ?? ''
    const rest = fields.slice(6)
    const netid = netidRaw.toLowerCase()
    if (netid !== 'tcp' && netid !== 'udp') continue // -t -u already restrict this; defensive only
    const protocol: Protocol = netid

    const local = splitHostPort(localRaw)
    if (!local || !/^\d+$/.test(local.port)) continue
    const localPort = Number(local.port)
    if (localPort > 65535) continue

    const peerRawSplit = splitHostPort(peerRaw)
    const peerPortRaw = peerRawSplit
      ? peerRawSplit.port === '*'
        ? null
        : /^\d+$/.test(peerRawSplit.port)
          ? Number(peerRawSplit.port)
          : null
      : null
    const peer = peerRawSplit
      ? normalizePeer(peerRawSplit.address, peerPortRaw)
      : { address: null, port: null }

    const state = normalizeState(stateRaw)
    const processes = parseProcessColumn(rest.join(' '))

    const seenPids = new Set<number>()
    const dedupedProcesses = processes.filter((proc) => {
      if (seenPids.has(proc.pid)) return false // multiple fds, same process — one row
      seenPids.add(proc.pid)
      return true
    })

    lines.push({
      protocol,
      localAddress: local.address,
      localPort,
      peerAddress: peer.address,
      peerPort: peer.port,
      state,
      processes: dedupedProcesses,
    })
  }

  return lines
}

/**
 * Pure parser for `ss -H -t -u -n -p {-l|-a}` output, with no /proc
 * verification: the shape a unit test drives directly. `collectFromSs` — the
 * only real caller — never uses this: it calls `parseSsLines` itself so it
 * can verify each line's process candidates before turning them into rows.
 * Returns [] (not a throw) for input with nothing parseable; the caller
 * decides whether that means "no sockets" or "this output didn't parse".
 */
export function parseSsOutput(text: string): PortEntry[] {
  const entries: PortEntry[] = []
  for (const line of parseSsLines(text)) {
    if (line.processes.length === 0) {
      entries.push(toUnknownEntry(line))
      continue
    }
    for (const proc of line.processes) entries.push(toKnownEntry(line, proc))
  }
  return entries
}

type SsAttempt = { ok: true; entries: PortEntry[] } | { ok: false; reason: string }

/**
 * Verifies every line's process candidates against /proc (see
 * `verifyProcesses`) and turns the result into rows, one per line unless
 * every candidate for that line failed verification — in which case, same
 * as a line with no process column at all, it becomes one unknown row
 * rather than silently disappearing.
 */
/**
 * A legitimate comm never contains a raw `"` — that character is only ever
 * in an extracted name at all because `parseProcessColumn`'s tiling had to
 * look past an embedded quote to find where the entry really ends (see its
 * own comment), which is exactly the shape a comm crafted to spoof its pid
 * takes. Tiling's own uniqueness already recovers the right pid even for
 * that shape, so this is not what stands between an attacker and a wrong
 * answer — but it is where trusting the parse the same way every ordinary
 * entry is trusted would mean trusting the same string the attack is built
 * from, so it is the one case that gets the extra /proc round trip before
 * being believed. An ordinary name — the overwhelming majority of entries,
 * every one of them in the common case where this backend owns none of the
 * sockets a request happens to see — never pays for it.
 */
function needsVerification(proc: ProcessCandidate): boolean {
  return proc.name.includes('"')
}

async function buildVerifiedEntries(
  lines: ParsedSsLine[],
  readComm: (pid: number) => Promise<string | null>,
): Promise<PortEntry[]> {
  const trustedByLine = new Map<number, ProcessCandidate[]>()
  const suspicious: Array<ProcessCandidate & { lineIndex: number }> = []

  lines.forEach((line, lineIndex) => {
    for (const proc of line.processes) {
      if (needsVerification(proc)) {
        suspicious.push({ ...proc, lineIndex })
        continue
      }
      const forLine = trustedByLine.get(lineIndex)
      if (forLine) forLine.push(proc)
      else trustedByLine.set(lineIndex, [proc])
    }
  })

  const verified = await verifyProcesses(suspicious, readComm)
  for (const { lineIndex, ...proc } of verified) {
    const forLine = trustedByLine.get(lineIndex)
    if (forLine) forLine.push(proc)
    else trustedByLine.set(lineIndex, [proc])
  }

  const entries: PortEntry[] = []
  lines.forEach((line, lineIndex) => {
    const procs = trustedByLine.get(lineIndex)
    if (!procs || procs.length === 0) {
      entries.push(toUnknownEntry(line))
      return
    }
    for (const proc of procs) entries.push(toKnownEntry(line, proc))
  })
  return entries
}

async function collectFromSs(scope: PortScope): Promise<SsAttempt> {
  const argv = SS_ARGS[scope]

  // Local, non-generic function so `ReturnType<typeof spawnSs>` captures the
  // literal stdout/stderr pipe pair this call asks for — same reason
  // docker/hosts.ts's runTailscaleStatus does this instead of inlining spawn.
  const spawnSs = () =>
    Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })

  let proc: ReturnType<typeof spawnSs>
  try {
    proc = spawnSs()
  } catch (error) {
    return { ok: false, reason: `\`ss\` is not installed (${String(error)})` }
  }

  const [stdout, stderr] = await Promise.all([
    readBounded(proc.stdout, proc.exited),
    readBounded(proc.stderr, proc.exited),
    proc.exited,
  ])

  if (proc.exitCode !== 0) {
    const detail = stderr.trim()
    const detailSuffix = detail ? `: ${detail}` : ''
    // By this point `proc.exited` has settled, so `exitCode` is null only
    // when the process was killed by a signal rather than exiting on its
    // own — never leave that as a bare "code null". `killSignal: 'SIGKILL'`
    // above is what our own SS_TIMEOUT_MS uses to stop a hung `ss`, and
    // nothing else here ever signals it, so a SIGKILL means the timeout
    // fired; any other signal is reported by name instead of guessed at.
    const reason =
      proc.signalCode === 'SIGKILL'
        ? `\`ss\` timed out after ${SS_TIMEOUT_MS / 1000}s`
        : proc.signalCode
          ? `\`ss\` was killed by ${proc.signalCode}`
          : `\`ss\` exited with code ${proc.exitCode}`
    return { ok: false, reason: `${reason}${detailSuffix}` }
  }

  const lines = parseSsLines(stdout)
  // Clean exit with empty output is a real answer ("no sockets"), not a
  // parse failure. Non-empty output that yields nothing means the format
  // changed under us — trust /proc instead of reporting zero rows as fact.
  if (lines.length === 0 && stdout.trim().length > 0) {
    return { ok: false, reason: '`ss` output did not match the expected format' }
  }

  const entries = await buildVerifiedEntries(lines, readCommForVerification)
  return { ok: true, entries }
}

// --- /proc fallback, pure parts exported for tests --------------------------

export interface ProcNetRow {
  localAddress: string
  localPort: number
  peerAddress: string
  peerPort: number
  state: string
  inode: number
}

/** Decodes one little-endian hex IPv4 address, e.g. '0100007F' -> '127.0.0.1'. */
export function decodeIPv4Hex(hex: string): string {
  const bytes = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)]
  return bytes
    .reverse()
    .map((b) => Number.parseInt(b, 16))
    .join('.')
}

/** RFC 5952-ish compression: the longest run of >=2 zero groups becomes '::',
 * leftmost run wins a tie. Good enough for a diagnostics table, not a
 * canonicalising library. */
function formatIPv6(bytes: number[]): string {
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
  }

  // IPv4-mapped (`::ffff:a.b.c.d`): the first 80 bits are zero and the next
  // 16 are `ffff`. ss always prints this shape as a dotted quad, never as
  // two more hex groups, so the generic compression below has to be skipped
  // for exactly this case or the same socket would print two different ways
  // depending on which reader answered.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${bytes.slice(12, 16).join('.')}`
  }

  let bestStart = -1
  let bestLen = 0
  let i = 0
  while (i < 8) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen) {
      bestLen = j - i
      bestStart = i
    }
    i = j
  }
  if (bestLen < 2) bestStart = -1

  const hexGroups = groups.map((g) => g.toString(16))
  if (bestStart === -1) return hexGroups.join(':')
  const before = hexGroups.slice(0, bestStart).join(':')
  const after = hexGroups.slice(bestStart + bestLen).join(':')
  return `${before}::${after}`
}

/**
 * Decodes 32 hex chars into an IPv6 address: four little-endian 32-bit words
 * (each byte-swapped back to network order), concatenated into 16 bytes and
 * then compressed for display.
 */
export function decodeIPv6Hex(hex: string): string {
  const bytes: number[] = []
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8)
    for (let b = 3; b >= 0; b--) {
      bytes.push(Number.parseInt(word.slice(b * 2, b * 2 + 2), 16))
    }
  }
  return formatIPv6(bytes)
}

function decodeAddressHex(hex: string): string {
  if (hex.length === 8) return decodeIPv4Hex(hex)
  if (hex.length === 32) return decodeIPv6Hex(hex)
  throw new Error(`unexpected address hex length ${hex.length}`)
}

function splitHexAddrPort(raw: string): { address: string; port: number } | null {
  const idx = raw.lastIndexOf(':')
  if (idx === -1) return null
  const port = Number.parseInt(raw.slice(idx + 1), 16)
  if (!Number.isFinite(port)) return null
  try {
    return { address: decodeAddressHex(raw.slice(0, idx)), port }
  } catch {
    return null
  }
}

// /proc/net/{tcp,udp}[6]'s `st` column. 07 is the one code that means two
// different things depending on the table it came from: an unconnected UDP
// socket is normally "closed" in the same enum tcp uses, but ss reports it
// as UNCONN, which is the vocabulary this endpoint promises everywhere else.
const PROC_TCP_STATE: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN-SENT',
  '03': 'SYN-RECV',
  '04': 'FIN-WAIT-1',
  '05': 'FIN-WAIT-2',
  '06': 'TIME-WAIT',
  '07': 'CLOSED',
  '08': 'CLOSE-WAIT',
  '09': 'LAST-ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
}
const PROC_UDP_STATE: Record<string, string> = { ...PROC_TCP_STATE, '07': 'UNCONN' }

/** Pure parser for one /proc/net/{tcp,tcp6,udp,udp6} file's body. */
export function parseProcNet(text: string, protocol: Protocol): ProcNetRow[] {
  const stateTable = protocol === 'udp' ? PROC_UDP_STATE : PROC_TCP_STATE
  const rows: ProcNetRow[] = []

  for (const rawLine of text.split('\n').slice(1)) {
    const line = rawLine.trim()
    if (!line) continue
    const fields = line.split(/\s+/)
    if (fields.length < 10) continue

    const localRaw = fields[1] ?? ''
    const remRaw = fields[2] ?? ''
    const stateRaw = fields[3] ?? ''
    const inodeRaw = fields[9] ?? ''
    const local = splitHexAddrPort(localRaw)
    const peer = splitHexAddrPort(remRaw)
    if (!local || !peer) continue

    const inode = Number(inodeRaw)
    if (!Number.isFinite(inode)) continue

    rows.push({
      localAddress: local.address,
      localPort: local.port,
      peerAddress: peer.address,
      peerPort: peer.port,
      state: stateTable[stateRaw.toUpperCase()] ?? 'UNKNOWN',
      inode,
    })
  }

  return rows
}

interface RawProcRow extends ProcNetRow {
  protocol: Protocol
}

const PROC_NET_FILES: Array<{ path: string; protocol: Protocol }> = [
  { path: '/proc/net/tcp', protocol: 'tcp' },
  { path: '/proc/net/tcp6', protocol: 'tcp' },
  { path: '/proc/net/udp', protocol: 'udp' },
  { path: '/proc/net/udp6', protocol: 'udp' },
]

async function readProcNetFiles(): Promise<{
  rows: RawProcRow[]
  failures: { path: string; code: string }[]
}> {
  const rows: RawProcRow[] = []
  const failures: { path: string; code: string }[] = []

  for (const file of PROC_NET_FILES) {
    try {
      const text = await readFile(file.path, 'utf8')
      for (const row of parseProcNet(text, file.protocol)) {
        rows.push({ ...row, protocol: file.protocol })
      }
    } catch (error) {
      // tcp6/udp6 missing on an IPv6-disabled box is normal — only fatal
      // (below) if every one of the four failed to read.
      failures.push({ path: file.path, code: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' })
    }
  }

  return { rows, failures }
}

/** How long the /proc/<pid>/fd scan is allowed to run. A box with an enormous
 * process table must not turn one GET into a multi-second hang — past this,
 * whatever rows are left unattributed just stay that way. */
const PROC_SCAN_BUDGET_MS = 2_000

const SOCKET_FD_RE = /^socket:\[(\d+)\]$/

/**
 * inode -> (pid -> comm), for exactly the inodes asked for. Scans
 * /proc/<pid>/fd, which throws EACCES on every pid this service account
 * does not own — the normal case on this deployment (see the module
 * comment), skipped silently rather than logged, since it would otherwise
 * log on almost every pid on every request.
 */
async function attributeInodes(inodes: Set<number>): Promise<Map<number, Map<number, string>>> {
  const result = new Map<number, Map<number, string>>()
  if (inodes.size === 0) return result

  let pidDirs: string[]
  try {
    pidDirs = await readdir('/proc')
  } catch {
    return result
  }

  const deadline = Date.now() + PROC_SCAN_BUDGET_MS
  const commCache = new Map<number, string | null>()

  for (const entry of pidDirs) {
    if (Date.now() > deadline) break
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)

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
        continue // fd closed between the readdir and this readlink
      }
      const match = SOCKET_FD_RE.exec(link)
      if (!match) continue
      const inode = Number(match[1])
      if (!inodes.has(inode)) continue

      let name = commCache.get(pid)
      if (name === undefined) {
        // Strip only the one trailing newline `comm` is terminated with — a
        // real comm can end in a space, which a plain `.trim()` would eat.
        name = await readCommForVerification(pid)
        commCache.set(pid, name)
      }
      if (name === null) continue

      let byPid = result.get(inode)
      if (!byPid) {
        byPid = new Map()
        result.set(inode, byPid)
      }
      byPid.set(pid, name) // Map, so a second fd for the same pid never duplicates the row
    }
  }

  return result
}

async function collectFromProc(scope: PortScope): Promise<PortEntry[]> {
  const { rows, failures } = await readProcNetFiles()
  if (failures.length === PROC_NET_FILES.length) {
    const codes = [...new Set(failures.map((f) => f.code))].join(', ')
    throw new Error(`/proc/net/{tcp,tcp6,udp,udp6} could not be read (${codes})`)
  }

  const filtered = rows.filter((row) =>
    scope === 'all'
      ? true
      : row.protocol === 'tcp'
        ? row.state === 'LISTEN'
        : row.state === 'UNCONN',
  )

  const inodes = new Set(filtered.map((row) => row.inode).filter((inode) => inode !== 0))
  const attribution = await attributeInodes(inodes)

  const entries: PortEntry[] = []
  for (const row of filtered) {
    const peer = normalizePeer(row.peerAddress, row.peerPort)
    const byPid = row.inode !== 0 ? attribution.get(row.inode) : undefined

    if (!byPid || byPid.size === 0) {
      entries.push({
        protocol: row.protocol,
        localAddress: row.localAddress,
        localPort: row.localPort,
        peerAddress: peer.address,
        peerPort: peer.port,
        state: row.state,
        pid: null,
        processName: 'unknown',
        processKnown: false,
      })
      continue
    }

    for (const [pid, name] of byPid) {
      entries.push({
        protocol: row.protocol,
        localAddress: row.localAddress,
        localPort: row.localPort,
        peerAddress: peer.address,
        peerPort: peer.port,
        state: row.state,
        pid,
        processName: name,
        processKnown: true,
      })
    }
  }

  return entries
}

// --- assembly ----------------------------------------------------------

function safeUsername(): string | null {
  try {
    return userInfo().username
  } catch {
    // Documented to be able to throw when the current uid has no /etc/passwd
    // entry — a plausible state for a service account, so worth guarding
    // rather than letting the whole request 500 over a display field.
    return null
  }
}

/** LISTEN/UNCONN first, then by port, protocol, address, pid — deterministic
 * so truncation at MAX_ROWS always drops the same rows for the same input. */
function comparePorts(a: PortEntry, b: PortEntry): number {
  const aFirst = a.state === 'LISTEN' || a.state === 'UNCONN'
  const bFirst = b.state === 'LISTEN' || b.state === 'UNCONN'
  if (aFirst !== bFirst) return aFirst ? -1 : 1
  if (a.localPort !== b.localPort) return a.localPort - b.localPort
  if (a.protocol !== b.protocol) return a.protocol < b.protocol ? -1 : 1
  if (a.localAddress !== b.localAddress) return a.localAddress < b.localAddress ? -1 : 1
  return (a.pid ?? -1) - (b.pid ?? -1)
}

function buildResult(
  scope: PortScope,
  source: PortsResult['source'],
  collectedAt: string,
  ports: PortEntry[],
): PortsResult {
  const sorted = [...ports].sort(comparePorts)
  const total = sorted.length
  const truncated = total > MAX_ROWS
  const truncatedPorts = sorted.slice(0, MAX_ROWS)

  return {
    scope,
    source,
    collectedAt,
    user: safeUsername(),
    runningAsRoot: process.geteuid?.() === 0,
    total,
    truncated,
    unattributedCount: truncatedPorts.filter((p) => !p.processKnown).length,
    ports: truncatedPorts,
  }
}

async function collectPorts(scope: PortScope): Promise<PortsResult> {
  const collectedAt = new Date().toISOString()
  const ssAttempt = await collectFromSs(scope)

  if (ssAttempt.ok) {
    return buildResult(scope, 'ss', collectedAt, ssAttempt.entries)
  }

  logger.warn(`ss unavailable for the ports endpoint (${ssAttempt.reason}) — falling back to /proc`)
  try {
    const procPorts = await collectFromProc(scope)
    return buildResult(scope, 'proc', collectedAt, procPorts)
  } catch (procError) {
    throw serviceUnavailable(
      `Could not read the port table: ${ssAttempt.reason}, and ${String((procError as Error)?.message ?? procError)}`,
    )
  }
}

// Deduped per scope, not TTL-cached: a manual "Refresh" on the dashboard must
// see the current table, not a stale one, but several requests landing in
// the same tick (e.g. two browser tabs) should still share one read.
const inFlight: Partial<Record<PortScope, Promise<PortsResult>>> = {}

export async function getPorts(scope: PortScope): Promise<PortsResult> {
  const existing = inFlight[scope]
  if (existing) return existing

  const promise = collectPorts(scope)
  inFlight[scope] = promise
  try {
    return await promise
  } finally {
    inFlight[scope] = undefined
  }
}
