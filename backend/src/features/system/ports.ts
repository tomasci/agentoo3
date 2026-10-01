// The host's current port -> process mapping — a structured `ss -tuln`.
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
// backend/README.md), with no-new-privileges set and no sudo, setuid helper
// or file capability available to it — a socket only ever attributes to a
// process this account's own uid can see into `/proc/<pid>/fd` for, and the
// /proc fallback hits the identical EACCES wall on another user's
// `/proc/<pid>/fd`. That used to mean most rows on this deployment came back
// `unknown`, which the operator reads as a bug rather than the expected
// result of running unprivileged. The three passes below (`socket`,
// `docker`, `service` — see `Attribution`) do not change any of that: they
// add no privilege at all, only read facts the kernel and systemd already
// expose to any account — `ss -e`'s own uid/cgroup columns,
// `/sys/fs/cgroup/**/cgroup.procs` and `/proc/<pid>/{comm,cmdline,status,fd}`
// (all world-readable), and a read-only Docker query over the socket this
// account's `docker` group membership already grants. A privileged reader
// (CAP_SYS_PTRACE, a setuid helper, `sudo ss`) would see every socket
// resolved for free; that is out of scope here on purpose, not an oversight.
//
// Neither reader ever asks `ss` (or anything else) to name a process for a
// socket. `ss -p` prints the holding process's `comm` unescaped inside a
// `users:((...))` column — and `comm` is entirely self-reported (any
// unprivileged process can rewrite its own via `prctl`/`/proc/self/comm`).
// Two cooperating processes sharing one socket (fork after bind) can pick
// comms that, printed back to back in that one column, read as a SECOND,
// wholly fictitious socket line — an attacker-controlled newline in a comm
// can just as easily make ss's own real line for that socket fail to parse
// and vanish instead. No amount of parsing that text can be made safe: a
// process is always free to pick the exact bytes a parser is looking for.
// So this module never reads it at all — `-p` is not even in the argv (see
// `SS_ARGS`). Attribution is by inode instead: `ss -e` prints `ino:<n>` for
// every socket, kernel-assigned and never chosen by any process; a scan of
// `/proc/[pid]/fd/*` for a `socket:[<inode>]` readlink (`attributeInodes`)
// finds every pid holding that inode, exactly the set `ss -p` itself could
// ever have resolved (identical uid-scoped permissions), and `comm` is then
// read as a plain, byte-exact file — never matched against, never split on,
// just displayed. Zero attacker-controlled bytes ever enter a parse step.

import { readdir, readFile, readlink } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { type DockerCli, realDockerCli } from '@/features/docker/cli'
import {
  inspectContainersRawAll,
  listAllContainerIdsResult,
  type PublishedPort,
  toDockerContainer,
} from '@/features/docker/inspect'
import { serviceUnavailable } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { readBounded, sleep } from '@/lib/spawn'

export type PortScope = 'listening' | 'all'
export type Protocol = 'tcp' | 'udp'

/**
 * How `pid`/`processName` were determined, in the order they are tried (see
 * `enrichUnattributed`) — first match wins, and every entry that reaches
 * `'none'` keeps `pid: null, processName: 'unknown'` exactly as before this
 * field existed.
 *
 *   - `'socket'`  — a direct `/proc/*\/fd` scan for the socket's own inode
 *     (`attributeInodes`), fed by `ss -e`'s `ino:<n>` column in the ss
 *     reader or `/proc/net`'s own inode field in the fallback. Only ever
 *     resolves a socket this service account itself owns — see the module
 *     comment for why this reads the fd table directly rather than any text
 *     `ss` prints about the process.
 *   - `'docker'`  — a `docker-proxy` process whose cmdline's proto/host-ip/
 *     host-port matches this socket (`matchDockerProxy`), cross-checked
 *     against a live, read-only Docker query for the publishing container.
 *     Works for a socket owned by any uid, because `docker-proxy`'s cmdline
 *     is process-table metadata, not something only its own uid can read.
 *   - `'service'` — the systemd unit implied by the socket's own cgroup
 *     (`cgroup:<path>` from `ss -e`), attributed to that unit's main
 *     process. Reliable for the *name*; the pid is the unit's main process,
 *     which in practice is the listener itself for a single-process unit
 *     (nginx's master, postgres's postmaster) but is not guaranteed to be
 *     the specific worker that owns any one connection.
 *   - `'none'`    — nothing above resolved a process for this socket.
 */
export type Attribution = 'socket' | 'docker' | 'service' | 'none'

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
  attribution: Attribution
  unit: string | null
  container: string | null
  owner: string | null
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
  inferredCount: number
  ports: PortEntry[]
}

/** A dashboard renders these as a table; past this, more rows costs more
 * than it tells anyone looking at it. Exported so a test can pin the cap. */
export const MAX_ROWS = 5000

// Read-only by construction: `scope` only ever selects one of these two
// fixed argv arrays — nothing here is built from the request. `-K`/`--kill`
// (closes the socket), `-D`/`--diag` (writes a dump to disk) and `-F` are
// never used, and there is no shell to reinterpret anything even if they
// were. There is also no `-p` — see the module comment: attribution is by
// inode (`ss -e`'s own `ino:<n>` plus a `/proc/*/fd` scan), never by asking
// `ss` to print a process's self-reported `comm` for us to parse. `-e`
// ("show detailed socket information": uid, inode, cgroup) is the one flag
// added for the `docker`/`service` attribution passes and the inode itself;
// it is exactly as read-only as every flag already here — ss prints more
// about a socket, it changes nothing about one.
export const SS_ARGS: Record<PortScope, string[]> = {
  listening: ['ss', '-H', '-t', '-u', '-n', '-e', '-l'],
  all: ['ss', '-H', '-t', '-u', '-n', '-e', '-a'],
}

const SS_TIMEOUT_MS = 5_000

// --- ss parsing, pure and exported for tests --------------------------------

/** A real comm can end in a space, so only the one trailing newline `comm`
 * files are terminated with is stripped — a full `.trim()` would also eat
 * that space and make a legitimate comm fail to match itself. This is the
 * ONLY transformation ever applied to a comm anywhere in this module: no
 * escaping, no splitting, no matching against it — see the module comment
 * on why any parse of process-reported text is inherently unsafe. */
function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/** Reads one pid's `comm`, byte-exact past the one trailing newline strip
 * above. Never fails the caller: an already-exited pid (a race between
 * whatever snapshot named it and this read) or a genuinely unreadable file
 * both degrade to `null`, which every caller treats as "nothing to attribute
 * here" rather than a crafted answer. */
async function readProcComm(pid: number): Promise<string | null> {
  try {
    return stripTrailingNewline(await readFile(`/proc/${pid}/comm`, 'utf8'))
  } catch {
    return null
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

// --- `ss -e`'s own tail: uid/ino/sk/cgroup/v6only, and the shutdown marker --
//
// With `-p` never passed (see SS_ARGS), everything past the peer column on a
// real `ss -e` line is ss's own output — never a process's own comm — with
// exactly one exception: `cgroup:<path>`'s own value, which a user with a
// delegated cgroup subtree can still choose. `parseSsTailFields` is written
// to that one exception: strict left-to-right parsing, ss's own field order
// enforced (`TAIL_KEY_ORDER`), and every field trusted exactly as far as
// ss's own fixed print order lets it be genuine. `uid`/`ino`/`sk` are always
// written by ss BEFORE `cgroup`'s own bytes even begin, so a violation before
// `cgroup` is reached still drops every field for the whole tail — it means
// this text does not look like ss's own tail at all, not a cgroup playing
// tricks, and there is no genuine prefix to trust in that case. A violation
// AT or AFTER `cgroup` — its own value's shape, a space inside a delegated
// name splitting off a stray token, or a forged trailing `uid:`/`ino:` meant
// to be misread as a real one — can only ever be that one user-controlled
// field misbehaving, so only the cgroup-derived facts are dropped; the
// genuine uid/ino/sk already read off the earlier, ss-written tokens are
// kept (see `parseSsTailFields`'s own comment for why that split is safe).

const SHUTDOWN_MARKERS: ReadonlySet<string> = new Set(['<->', '-->', '<--', '---'])

/** One recognised `key:value`-shaped tail token's key, or null if `token`
 * does not even look like `word:value`. */
function tailTokenKey(token: string): string | null {
  const m = /^([a-z0-9_]+):\S*$/.exec(token)
  return m ? (m[1] as string) : null
}

/** ss's own field order — the sequence `parseSsTailFields`'s repeat/order
 * check enforces among whichever of these actually appear on a line. */
const TAIL_KEY_ORDER = ['uid', 'ino', 'sk', 'cgroup', 'v6only'] as const
type TailKey = (typeof TAIL_KEY_ORDER)[number]

/** Strict value shape for each key ss itself ever emits. `cgroup`'s own
 * shape excludes whitespace (not just the quote/parens a `users:(...)`
 * entry needed to guard against) — a delegated cgroup name is the one
 * value here a user can still pick. A raw C0/DEL control byte (a literal
 * `\r`, or one of the Unicode line separators) is rejected separately, by
 * `hasControlCharacter` below rather than by this regex — biome disallows a
 * literal control-character range inside a regex literal, on the reasonable
 * assumption that one is usually a typo; here it is the opposite, so a
 * plain char-code scan says the same thing without tripping that rule. */
const TAIL_VALUE_SHAPE: Record<TailKey, RegExp> = {
  uid: /^\d+$/,
  ino: /^\d+$/,
  sk: /^[0-9a-f]+$/,
  cgroup: /^[^"()\s]+$/,
  v6only: /^[01]$/,
}

/** Whether `text` contains a C0 control character or DEL (U+0000-U+001F,
 * U+007F) — anything a real systemd-chosen path segment never contains
 * (see `CGROUP_SEGMENT_RE` below, which independently rejects the same
 * bytes for the exact same reason), but a delegated cgroup's own directory
 * name is not guaranteed to respect. `\s` in `TAIL_VALUE_SHAPE.cgroup`
 * already excludes whitespace, including U+2028/U+2029; this covers every
 * other control byte the regex leaves alone (`\x00`-`\x1F` minus the
 * whitespace ones, plus `\x7F`). */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export interface SsTailFields {
  /** From `uid:<n>`. Null when that token was never seen — old ss with no
   * `-e` output at all, ss's own shorthand for uid 0, or a tail rejected
   * outright (see `sawEFields`, which is what tells the first of those from
   * the other two). */
  uid: number | null
  /** From `ino:<n>` — the same three-way ambiguity as `uid`. See
   * `ownerForLine`'s own ino-0-means-orphan rule, the one place this is
   * used, and `collectAttributableInodes`, which is why an `ino` here is
   * never itself the string `0` treated specially — the caller does that. */
  ino: number | null
  /** From `cgroup:<path>`, verbatim and unvalidated — ss's own output, so
   * every caller treats it as data (see `parseCgroup`, which does the
   * actual validation before any filesystem path is built from it). */
  cgroupPath: string | null
  /** True once at least one `-e` field was recognised — either because the
   * whole tail parsed cleanly end to end, or because uid/ino/sk parsed
   * cleanly before a violation at or after `cgroup` dropped only the
   * cgroup-derived facts (see `parseSsTailFields`). Never true for a tail
   * rejected before `cgroup` was ever reached. */
  sawEFields: boolean
}

const NO_TAIL_FIELDS: SsTailFields = { uid: null, ino: null, cgroupPath: null, sawEFields: false }

/**
 * Whether `text` contains an old `users:(...)` claim at all. The argv this
 * module actually runs never passes `-p` (see `SS_ARGS`), so a real `ss`
 * invocation from this endpoint never prints one — but an old captured
 * fixture, or a future `ss` that changes its own defaults, still might. The
 * safe reading is not to parse it (see the module comment on why any parse
 * of a `users:(...)` column is inherently ambiguous — a process controls
 * its own comm), never to resurrect the tiling/verification machinery that
 * used to make sense of it: a tail carrying one is simply invalid.
 */
function containsUsersColumn(text: string): boolean {
  return /(^|\s)users:\(/.test(text)
}

/**
 * Parses the text after the peer-address column of one `ss -e` line — uid,
 * inode, socket hash, cgroup path, the v6only flag, and the one shutdown-
 * state marker ss ever appends last — strictly left to right: every KNOWN
 * key must match its own value shape (`TAIL_VALUE_SHAPE`) and appear in
 * ss's own order (`TAIL_KEY_ORDER`), at most once. An unknown `key:value`
 * token — a future ss field this module has never seen, or one of ss's own
 * extras like `timer:(...)` — is tolerated wherever it falls BEFORE
 * `cgroup`, and never disturbs that order check.
 *
 * A violation before `cgroup` is reached — a token that isn't even
 * `key:value`-shaped, a known key repeated or out of ss's own order, a known
 * key whose value doesn't match its own shape, or the defensive
 * `users:(...)` check above — drops every field for the WHOLE tail, exactly
 * as before this function's own hardening: `uid`/`ino`/`sk` are ss's own
 * bytes, always written before the user's own cgroup value even starts, so
 * a violation there means this text does not look like ss's own tail at
 * all — there is no genuine prefix to salvage.
 *
 * A violation AT or AFTER `cgroup`'s own key, though, drops only the
 * cgroup-derived facts — `cgroupPath` (hence `unit`) goes null, but the
 * `uid`/`ino` already read survive — because a delegated cgroup can be
 * named anything its owner likes, including literally `x uid:0`, which ss
 * then prints verbatim as `cgroup:/…/x uid:0`: a SECOND `uid` token sitting
 * after the genuine one, or (a plain space in the name) a stray fragment
 * that is not even `key:value`-shaped. Either way, ss itself already wrote
 * the genuine `uid`/`ino`/`sk` tokens earlier in this same left-to-right
 * scan, strictly before the cgroup value's own bytes begin: the user can
 * shape their OWN field however they like, but they cannot rewrite what ss
 * already emitted before it. So a forged or malformed token can only ever
 * land at or after `cgroup`'s own position, never earlier, which is why only
 * what comes at or after it needs to be distrusted — dropping the earlier,
 * genuinely-ss-written facts too would just turn "my socket is visible" into
 * "my socket shows as unknown" by naming a single space in a cgroup nobody
 * else can even create.
 */
export function parseSsTailFields(tailText: string): SsTailFields {
  if (tailText.length === 0) return NO_TAIL_FIELDS
  if (containsUsersColumn(tailText)) return NO_TAIL_FIELDS

  const tokens = tailText.split(' ')
  if (SHUTDOWN_MARKERS.has(tokens[tokens.length - 1] as string)) tokens.pop()

  let uid: number | null = null
  let ino: number | null = null
  let cgroupPath: string | null = null
  let lastOrder = -1
  const seen = new Set<TailKey>()
  let sawAnyField = false
  // Set the moment `cgroup:<path>` itself parses cleanly — from here on,
  // every further token is either ss's own optional `v6only:<0|1>` or a
  // symptom of the cgroup value misbehaving (see the function's own doc
  // comment), never a reason to distrust the uid/ino already read above.
  let cgroupSeen = false

  for (const token of tokens) {
    if (cgroupSeen) {
      // Only ss's own optional `v6only:<0|1>` may follow a valid cgroup
      // value. Anything else here — a fragment of the cgroup's own name
      // that a literal space split off, or a token shaped like a real key
      // chosen to read as one — is the one user-controlled field
      // misbehaving, not evidence the rest of the tail is untrustworthy:
      // keep the uid/ino already read from the earlier, ss-written tokens,
      // and drop only the cgroup-derived facts.
      if (token.startsWith('v6only:') && !seen.has('v6only')) {
        const value = token.slice('v6only:'.length)
        if (TAIL_VALUE_SHAPE.v6only.test(value)) {
          seen.add('v6only')
          continue
        }
      }
      return { uid, ino, cgroupPath: null, sawEFields: sawAnyField }
    }

    // `cgroup:<path>`'s own value is the one field a user can shape freely,
    // and it can contain internal whitespace/control bytes that a real
    // `key:value` token never does — which is exactly why it is recognised
    // by its own literal prefix here, BEFORE the generic `tailTokenKey`
    // check below: that check requires the whole value to be `\S*` (no
    // embedded whitespace at all), so a tab or a control character inside
    // a delegated cgroup name would otherwise make this token fail to look
    // like `key:value` at ALL — landing in the "not even key:value-shaped"
    // branch below, which (correctly, for every OTHER field) drops the
    // whole tail. A whitespace/control byte inside `cgroup:`'s own value is
    // instead exactly the "cgroup value misbehaving" case this function's
    // own doc comment describes, so it is handled with the same softer rule.
    if (token.startsWith('cgroup:')) {
      const order = TAIL_KEY_ORDER.indexOf('cgroup')
      if (order < lastOrder) return NO_TAIL_FIELDS // out of order before cgroup ever cleanly parsed
      sawAnyField = true
      const value = token.slice('cgroup:'.length)
      if (!TAIL_VALUE_SHAPE.cgroup.test(value) || hasControlCharacter(value)) {
        return { uid, ino, cgroupPath: null, sawEFields: true }
      }
      seen.add('cgroup')
      lastOrder = order
      cgroupPath = value
      cgroupSeen = true
      continue
    }

    const key = tailTokenKey(token)
    if (key === null) return NO_TAIL_FIELDS // not even key:value-shaped: not ss's own tail
    sawAnyField = true

    const order = TAIL_KEY_ORDER.indexOf(key as TailKey)
    if (order === -1) continue // unknown key: tolerated, ignored for ordering and value

    if (seen.has(key as TailKey) || order < lastOrder) return NO_TAIL_FIELDS // repeat, or out of order
    const value = token.slice(key.length + 1)
    if (!TAIL_VALUE_SHAPE[key as TailKey].test(value)) return NO_TAIL_FIELDS

    seen.add(key as TailKey)
    lastOrder = order
    if (key === 'uid') uid = Number(value)
    else if (key === 'ino') ino = Number(value)
  }

  return { uid, ino, cgroupPath, sawEFields: sawAnyField }
}

/** One socket row parsed out of `ss` output. */
interface ParsedSsLine {
  protocol: Protocol
  localAddress: string
  localPort: number
  peerAddress: string | null
  peerPort: number | null
  state: string
  /** From `ss -e`'s `uid:<n>` — 0 when `-e` fields are present but the
   * token itself was omitted (ss's own shorthand for uid 0), null when no
   * `-e` fields are present at all (this socket's uid is simply unknown). */
  uid: number | null
  /** From `ss -e`'s `ino:<n>` — see `ownerForLine`'s ino-0-means-orphan
   * rule and `collectAttributableInodes`, the two places this is read. */
  ino: number | null
  /** From `ss -e`'s `cgroup:<path>`, verbatim and unvalidated. */
  cgroupPath: string | null
}

// --- owner: uid -> username, read once per request --------------------------

/**
 * `/etc/passwd` is world-readable and this maps every uid it lists, once —
 * shared by both readers (ss's own `uid:` column, and, in the /proc
 * fallback, `/proc/net/*`'s `uid` field) rather than a `getent` spawn per
 * row. A caller with no real passwd data at all (the pure `parseSsOutput`
 * path this module also exports for tests) passes an empty map instead of
 * calling this, which degrades `ownerForUid` to its own numeric-string
 * fallback — never a fabricated name.
 */
async function loadPasswdOwners(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  let text: string
  try {
    text = await readFile('/etc/passwd', 'utf8')
  } catch {
    return map // unusual, but degrade to the numeric/'root' fallback rather than fail the request
  }
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const fields = line.split(':')
    const name = fields[0]
    const uid = Number(fields[2])
    if (name && Number.isInteger(uid) && !map.has(uid)) map.set(uid, name) // first entry for a uid wins
  }
  return map
}

/**
 * `'root'` for uid 0 unconditionally (ss omits the `uid:` token for it
 * rather than printing `uid:0`, so this never even needs `/etc/passwd` to
 * say so), the numeric uid as a string when `passwdMap` has no entry for
 * it, and null only when the uid itself is unknown — an old ss with no `-e`
 * output, or an unattributed `/proc/net` row.
 */
export function ownerForUid(
  uid: number | null,
  passwdMap: ReadonlyMap<number, string>,
): string | null {
  if (uid === null) return null
  if (uid === 0) return 'root'
  return passwdMap.get(uid) ?? String(uid)
}

// --- unit: the systemd unit implied by a socket's own cgroup ---------------

/** Conservative on purpose: `ss -e`'s `cgroup:<path>` is data, not a path
 * this module chose, and it is about to be joined onto `/sys/fs/cgroup` and
 * read from disk (see `readCgroupProcs`) — so a value that does not look
 * exactly like a systemd cgroup path (no `..` segment, no character outside
 * the set systemd itself ever emits for a slice/unit name, plus its own
 * `\xNN` escape for a byte that isn't) is rejected outright rather than
 * given the benefit of the doubt. */
const CGROUP_SEGMENT_RE = /^(?:[A-Za-z0-9@._:-]|\\x[0-9a-fA-F]{2})+$/

function isValidCgroupPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  const segments = path.split('/').slice(1)
  return segments.every(
    (segment) => segment.length > 0 && segment !== '..' && CGROUP_SEGMENT_RE.test(segment),
  )
}

const UNIT_SUFFIX_RE = /\.(service|socket|scope)$/

/** The deepest (rightmost) path segment that names a systemd unit rather
 * than a slice — e.g. `/system.slice/user@1000.service/app.slice/foo.service`
 * is `foo.service`, and `/system.slice/ssh.socket` is `ssh.socket`. Null when
 * no segment qualifies (a bare slice, or nothing at all). */
function deepestUnitSegment(path: string): string | null {
  const segments = path.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i] as string
    if (UNIT_SUFFIX_RE.test(segment)) return segment
  }
  return null
}

export interface CgroupInfo {
  /** The unit name for display — see `deepestUnitSegment`. */
  unit: string | null
  /** `rawPath` itself, once validated — the only form of it this module
   * will ever join onto `/sys/fs/cgroup` and read (see `readCgroupProcs`).
   * Null whenever `unit` is, and also whenever the path failed validation
   * even if it happened to contain something that looked unit-shaped. */
  validPath: string | null
}

/** Pure: validates and interprets one `cgroup:<path>` value. Never touches
 * the filesystem — see `readCgroupProcs` for the one place that does, using
 * `validPath` from here. */
export function parseCgroup(rawPath: string | null): CgroupInfo {
  if (rawPath === null || !isValidCgroupPath(rawPath)) return { unit: null, validPath: null }
  const unit = deepestUnitSegment(rawPath)
  // No unit at all (a bare slice) means there is nothing for `service`
  // attribution to read `cgroup.procs` FOR — see applyServiceAttribution's
  // own gate — so `validPath` stays null right alongside `unit` rather than
  // exposing a path nothing will ever use.
  return unit === null ? { unit: null, validPath: null } : { unit, validPath: rawPath }
}

/**
 * `ownerForUid`, with one extra rule on top: `ino:0` is ss's own sentinel
 * for an orphan socket (TIME-WAIT and similar — held by the kernel itself,
 * not by any process), and for exactly those sockets `-e` also omits
 * `uid:` — the SAME shorthand it uses for a genuine uid of 0. Without this
 * check that omission is indistinguishable from "owned by root", which is
 * how an orphan socket was wrongly reported as root-owned. `ino:0` is the
 * one signal available to tell the two apart, so it wins outright: an
 * orphan's owner is unknown, never inferred.
 */
function ownerForLine(line: ParsedSsLine, passwdMap: ReadonlyMap<number, string>): string | null {
  if (line.ino === 0) return null
  return ownerForUid(line.uid, passwdMap)
}

function toUnknownEntry(line: ParsedSsLine, passwdMap: ReadonlyMap<number, string>): PortEntry {
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
    attribution: 'none',
    unit: parseCgroup(line.cgroupPath).unit,
    container: null,
    owner: ownerForLine(line, passwdMap),
  }
}

function toKnownEntry(
  line: ParsedSsLine,
  pid: number,
  name: string,
  passwdMap: ReadonlyMap<number, string>,
): PortEntry {
  return {
    protocol: line.protocol,
    localAddress: line.localAddress,
    localPort: line.localPort,
    peerAddress: line.peerAddress,
    peerPort: line.peerPort,
    state: line.state,
    pid,
    processName: name,
    processKnown: true,
    attribution: 'socket',
    unit: parseCgroup(line.cgroupPath).unit,
    container: null,
    owner: ownerForLine(line, passwdMap),
  }
}

/** No real passwd data behind the pure parsers (`parseSsOutput`, and every
 * hand-built fixture in system-ports.test.ts) — `ownerForUid` degrades to
 * its own numeric-string fallback against this rather than a caller having
 * to special-case "no map". */
const NO_PASSWD_DATA: ReadonlyMap<number, string> = new Map()

/** ss's own state vocabulary (iproute2's `sstate_name[]`), in the RAW form
 * ss itself ever prints — `ESTAB`, never `normalizeState`'s own normalised
 * `ESTABLISHED`. A second column that is not one of these was never
 * emitted by any real `ss` at all. */
const SS_STATE_NAMES: ReadonlySet<string> = new Set([
  'LISTEN',
  'UNCONN',
  'ESTAB',
  'SYN-SENT',
  'SYN-RECV',
  'FIN-WAIT-1',
  'FIN-WAIT-2',
  'TIME-WAIT',
  'CLOSE-WAIT',
  'LAST-ACK',
  'CLOSING',
  'CLOSED',
  'UNKNOWN',
])

/**
 * The six leading columns of one `ss -H ...` line — Netid, State, Recv-Q,
 * Send-Q, Local Address:Port, Peer Address:Port — found strictly by
 * POSITION (a run of `\S+`, `\d+` for the two queue columns). Group 7
 * (`rest`, optional) is everything after the sixth field's own separator —
 * ss's own `-e` tail, since `-p` is never in the argv (see `SS_ARGS`) there
 * is no process-controlled text left in a real line at all.
 *
 * That capture is `[^\n]*`, not `.*`: JavaScript's `.` excludes not just
 * `\n` but `\r` and the Unicode line separators U+2028/U+2029 as well, and
 * a delegated cgroup name (see `TAIL_VALUE_SHAPE`'s own comment) could
 * contain one. `text.split('\n')` above already guarantees `line` itself
 * never contains a literal `\n`, so `[^\n]*` matches every remaining
 * character `.` would have refused — without that, a `\r` anywhere in the
 * tail made the WHOLE line fail to match at all, silently dropping a real
 * socket's own record rather than merely failing to trust its cgroup.
 */
const SS_LINE_RE =
  /^(\S+)[ \t]+(\S+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\S+)[ \t]+(\S+)(?:[ \t]+([^\n]*))?$/

/**
 * Recognises exactly the address literals ss ever prints for either the
 * local or peer column: an IPv4 dotted quad, a bare IPv6 literal (already
 * unwrapped from its bracket form by `splitHostPort`) optionally suffixed
 * with the `%zone` ss appends for a link-local address, or the wildcard
 * `*`. Shared by both columns so each is validated exactly as strictly as
 * the other — with `-p` gone (see `SS_ARGS`), neither one is ever
 * process-controlled text in the first place, but there is no reason to
 * trust either any further than the kernel's own vocabulary requires.
 */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
// A pure hex/colon IPv6 literal, OR one whose last group is an embedded
// IPv4 dotted quad — valid IPv6 syntax generally (`::a.b.c.d`), and exactly
// the form ss itself prints for an IPv4-mapped address (`::ffff:127.0.0.1`,
// see decodeIPv6Hex's own comment on why ss never prints that as two more
// hex groups instead).
const IPV6_RE = /^[0-9a-fA-F:]+$/
const IPV6_V4_MAPPED_RE = /^[0-9a-fA-F:]*:(?:\d{1,3}\.){3}\d{1,3}$/

function isValidAddressLiteral(address: string): boolean {
  if (address === '*') return true
  const bare = address.replace(/%[^%]*$/, '')
  if (IPV4_RE.test(bare)) return true
  if (!bare.includes(':')) return false
  return IPV6_RE.test(bare) || IPV6_V4_MAPPED_RE.test(bare)
}

/** `addr:port` for either the local or peer column: rejects `"`, `(`, `)`
 * outright (never any part of a real address or port), then requires the
 * address half to be one of the literal shapes `isValidAddressLiteral`
 * recognises. The port half is returned as text — its own digit-or-`*`
 * check differs slightly between local (never `*`) and peer (`*` means
 * unconnected), so each caller in `parseSsLines` checks that itself. */
function parseAddressPortField(raw: string): { address: string; port: string } | null {
  if (raw.includes('"') || raw.includes('(') || raw.includes(')')) return null
  const split = splitHostPort(raw)
  if (!split || !isValidAddressLiteral(split.address)) return null
  return split
}

function parseValidPeerField(raw: string): { address: string; port: string } | null {
  const split = parseAddressPortField(raw)
  if (!split) return null
  if (split.port !== '*' && !/^\d+$/.test(split.port)) return null
  return split
}

/**
 * Parses `ss -H -t -u -n -e {-l|-a}` output into one row per socket line.
 * Attribution needs an async `/proc/*\/fd` scan (`attributeInodes`), done
 * separately by the one real caller (`collectFromSs`) — this stays
 * synchronous and easy to unit test. A line this cannot make sense of is
 * skipped rather than failing the whole request — one odd row (a future ss
 * adding a netid, a truncated line) should not cost every other one.
 */
function parseSsLines(text: string): ParsedSsLine[] {
  const lines: ParsedSsLine[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // -H should already suppress this, but an old ss ignoring the flag is
    // cheap to tolerate.
    if (/^(Netid|State)\b/.test(line)) continue

    const m = SS_LINE_RE.exec(line)
    if (!m) continue

    const netid = (m[1] as string).toLowerCase()
    if (netid !== 'tcp' && netid !== 'udp') continue // -t -u already restrict this; defensive only
    const protocol: Protocol = netid

    if (!SS_STATE_NAMES.has((m[2] as string).toUpperCase())) continue

    const local = parseAddressPortField(m[5] as string)
    if (!local || local.address.length === 0 || !/^\d+$/.test(local.port)) continue
    const localPort = Number(local.port)
    if (localPort > 65535) continue

    const peerField = parseValidPeerField(m[6] as string)
    if (!peerField) continue
    const peerPortRaw = peerField.port === '*' ? null : Number(peerField.port)
    const peer = normalizePeer(peerField.address, peerPortRaw)

    const state = normalizeState(m[2] as string)
    const tail = parseSsTailFields(m[7] ?? '')
    // ss omits `uid:` for uid 0 rather than printing it — so an absent uid
    // means root only once we know `-e` fields are present AND parsed
    // cleanly; `sawEFields` is false both for an ss with no `-e` support at
    // all and for a tail `parseSsTailFields` rejected outright, so neither
    // one can default to root either.
    const uid = tail.uid !== null ? tail.uid : tail.sawEFields ? 0 : null

    lines.push({
      protocol,
      localAddress: local.address,
      localPort,
      peerAddress: peer.address,
      peerPort: peer.port,
      state,
      uid,
      ino: tail.ino,
      cgroupPath: tail.cgroupPath,
    })
  }

  return lines
}

/**
 * Pure parser for `ss -H -t -u -n -e {-l|-a}` output, with no `/proc` scan
 * and no `docker`/`service` enrichment: the shape a unit test drives
 * directly. `collectFromSs` — the only real caller of the full pipeline —
 * never uses this: it calls `parseSsLines` itself so it can attribute each
 * line's inode via `attributeInodes` and enrich whatever is still
 * unattributed afterwards, before turning them into rows. `unit` here is
 * still derived from `cgroup:<path>` (pure, no I/O needed for that), but
 * `owner` never resolves past its own numeric-uid/`'root'` fallback (no
 * `/etc/passwd` behind this path — see `NO_PASSWD_DATA`), `pid`/
 * `processName` never resolve at all (no `/proc/*\/fd` scan here either —
 * every row comes back `attribution: 'none'`), and `container` stays null.
 * Returns `[]` (not a throw) for input with nothing parseable; the caller
 * decides whether that means "no sockets" or "this output didn't parse".
 */
export function parseSsOutput(text: string): PortEntry[] {
  return parseSsLines(text).map((line) => toUnknownEntry(line, NO_PASSWD_DATA))
}

type SsAttempt = { ok: true; entries: PortEntry[] } | { ok: false; reason: string }

/** `PortEntry`s that carry a validated cgroup path, keyed by object identity
 * — the one piece of state the `service` enrichment pass
 * (`applyServiceAttribution`) needs that isn't already sitting on the public
 * entry itself (its derived `unit`, yes; the raw path a `cgroup.procs` read
 * is built from, no — see `parseCgroup`). A `Map` rather than a field on
 * `PortEntry` so the wire shape stays exactly the documented fields, nothing
 * extra riding along for internal use. */
type CgroupPathByEntry = ReadonlyMap<PortEntry, string>

/** Same idea as `CgroupPathByEntry`, but the RAW (unvalidated) `cgroup:`
 * text ss printed for this entry's own socket, kept even when `parseCgroup`
 * would reject it for a `cgroup.procs` read. Used for exactly one thing —
 * a plain string comparison against a candidate `docker-proxy`'s own
 * `/proc/<pid>/cgroup` (see `verifyDockerProxyCandidate`) — which needs no
 * filesystem-safety validation at all, since nothing here is ever joined
 * onto a path and read. */
type RawCgroupPathByEntry = ReadonlyMap<PortEntry, string>

// --- `docker` attribution: a docker-proxy process's own cmdline -------------

export interface DockerProxyBinding {
  protocol: Protocol
  hostIp: string
  hostPort: number
  containerIp: string
  containerPort: number
}

/**
 * Pure: `docker-proxy`'s cmdline is plain flag/value pairs (`-use-listen-fd`
 * is the one bare flag) — no shell, nothing to shell-split, just an argv
 * this module never spawned itself, so every field is validated shape
 * before use rather than trusted outright.
 */
export function parseDockerProxyCmdline(argv: readonly string[]): DockerProxyBinding | null {
  const flagValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }

  const proto = flagValue('-proto')
  const hostIp = flagValue('-host-ip')
  const hostPort = Number(flagValue('-host-port'))
  const containerIp = flagValue('-container-ip')
  const containerPort = Number(flagValue('-container-port'))

  if (proto !== 'tcp' && proto !== 'udp') return null
  if (!hostIp || !containerIp) return null
  if (!Number.isInteger(hostPort) || !Number.isInteger(containerPort)) return null

  return { protocol: proto, hostIp, hostPort, containerIp, containerPort }
}

function isV6Shaped(address: string): boolean {
  return address.includes(':')
}

/**
 * Whether a docker-proxy bound to `hostIp` could be the process behind a
 * socket whose local address ss/`` proc reports as `localAddress` — address
 * family aware, so a v4 wildcard proxy (`-host-ip 0.0.0.0`) can never match
 * a v6 socket and vice versa, even though both are "any address" in their
 * own family. `%zone` suffixes are stripped first: docker never publishes
 * to a link-local zoned address, so a socket's own zone is irrelevant to
 * whether this is the same bind.
 */
export function hostIpMatchesLocalAddress(hostIp: string, localAddress: string): boolean {
  const bareLocal = localAddress.replace(/%.*$/, '')
  if (hostIp === '0.0.0.0') return !isV6Shaped(bareLocal)
  if (hostIp === '::') return isV6Shaped(bareLocal)
  return bareLocal === hostIp
}

export function dockerProxyMatches(
  entry: Pick<PortEntry, 'protocol' | 'localAddress' | 'localPort'>,
  binding: DockerProxyBinding,
): boolean {
  return (
    entry.protocol === binding.protocol &&
    entry.localPort === binding.hostPort &&
    hostIpMatchesLocalAddress(binding.hostIp, entry.localAddress)
  )
}

const DOCKER_PROXY_COMM = 'docker-proxy'

/** One `docker-proxy`-shaped process found in `/proc` — a CANDIDATE only:
 * its comm and cmdline are self-reported, and this by itself proves
 * nothing about whether the process is trustworthy — see
 * `verifyDockerProxyCandidate`, the gate every one of these has to pass
 * before `applyDockerAttribution` acts on it. */
export interface DockerProxyCandidate {
  pid: number
  binding: DockerProxyBinding
}

/**
 * Scans `/proc/[pid]/comm` for every `docker-proxy`-NAMED process and
 * parses its `/proc/[pid]/cmdline` — the same `/proc` this account already
 * reads for the fd-attribution scan (`attributeInodes`), just looking at a
 * different two files per pid, and bounded by the identical time budget
 * for the identical reason: a huge process table must not turn one GET
 * into a multi-second hang. `docker-proxy`'s own comm and cmdline are
 * readable regardless of which uid owns it — see the module comment on why
 * this pass exists at all.
 *
 * Deliberately trusts nothing about what it finds beyond "shaped like a
 * proxy claim" — comm and cmdline are both self-reported (`prctl`/`execve`,
 * either one entirely under the process's own control), so ANY process can
 * produce a hit here just by asking to. That's exactly why this function's
 * output is a list of CANDIDATES, and why `applyDockerAttribution` runs
 * every one of them through `verifyDockerProxyCandidate` (uid, cgroup
 * membership, a live Docker query — none of them self-reported) before
 * trusting any of it.
 */
async function scanDockerProxyBindings(budgetMs: number): Promise<DockerProxyCandidate[]> {
  const out: DockerProxyCandidate[] = []

  let pidDirs: string[]
  try {
    pidDirs = await readdir('/proc')
  } catch {
    return out
  }

  const deadline = Date.now() + budgetMs
  for (const entry of pidDirs) {
    if (Date.now() > deadline) break
    if (!/^\d+$/.test(entry)) continue

    const comm = await readProcComm(Number(entry))
    if (comm !== DOCKER_PROXY_COMM) continue

    let cmdlineRaw: string
    try {
      cmdlineRaw = await readFile(`/proc/${entry}/cmdline`, 'utf8')
    } catch {
      continue
    }
    const argv = cmdlineRaw.split('\0').filter((arg) => arg.length > 0)
    const binding = parseDockerProxyCmdline(argv)
    if (binding) out.push({ pid: Number(entry), binding })
  }

  return out
}

// --- `docker` attribution's own anti-forgery checks -------------------------
//
// `scanDockerProxyBindings`'s cmdline match is necessary but never
// sufficient: comm and argv are set by the process itself, so any
// unprivileged process can rename itself `docker-proxy` and carry a
// `-proto`/`-host-ip`/`-host-port` cmdline claiming ANY port at all — see
// the module's own security note on this. What follows checks the three
// things a process cannot fake about itself: the uid the kernel actually
// runs it as, which cgroup the kernel actually placed it in, and whether a
// live Docker daemon actually agrees a container publishes the claimed
// port.

/** `/proc/<pid>/status`'s `Uid:` line: real, effective, saved, filesystem —
 * in that order, whitespace-separated. World-readable, like every other
 * `/proc/<pid>/*` file this module reads for `docker`/`service`
 * attribution (see the module comment). */
const STATUS_UID_RE = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m

/** All four of a pid's uids, or null if the file could not be read
 * (already exited, or genuinely unreadable) or carried no `Uid:` line at
 * all. */
async function readProcUids(
  pid: number,
): Promise<readonly [number, number, number, number] | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8')
    const m = STATUS_UID_RE.exec(text)
    if (!m) return null
    return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  } catch {
    return null
  }
}

/** The cgroup v2 unified-hierarchy line of `/proc/<pid>/cgroup` (always
 * `0::<path>` — the only kind of cgroup hierarchy this module's other
 * cgroup read, `readCgroupProcs`, already assumes). Null if the file
 * could not be read or carried no such line. */
async function readProcCgroupPath(pid: number): Promise<string | null> {
  try {
    const text = await readFile(`/proc/${pid}/cgroup`, 'utf8')
    for (const line of text.split('\n')) {
      if (line.startsWith('0::')) return line.slice(3)
    }
    return null
  } catch {
    return null
  }
}

const DOCKER_SERVICE_UNIT = 'docker.service'

/**
 * The three checks one `docker-proxy` candidate must ALL pass before its
 * cmdline match is trusted — see the section comment above for why comm
 * and argv alone never are:
 *
 *   (a) `/proc/<pid>/status` shows real, effective, saved AND filesystem
 *       uid all 0. The real proxy runs as root; a same-account fake
 *       cannot become root just by asking.
 *   (b) `/proc/<pid>/cgroup` equals the SOCKET's own `cgroup:` path from
 *       `ss -e` (`socketCgroupPath`) — a socket's cgroup is set from its
 *       creating process's cgroup at `socket()` time, so the genuine
 *       proxy's own cgroup is always identical to the one ss reports for
 *       the socket it holds; an unprivileged process cannot move itself
 *       into `docker.service`'s cgroup to fake that. When the socket's own
 *       cgroup is unknown (`socketCgroupPath === null`) AND
 *       `allowMissingCgroupFallback` is true, the fallback is that the
 *       candidate's OWN cgroup resolves to `docker.service` itself — still
 *       nothing an unprivileged process can fake. `allowMissingCgroupFallback`
 *       is only ever true for the `/proc/net` reader, which carries no
 *       cgroup column at all (see `applyDockerAttribution`'s own doc
 *       comment) — on the `ss` path, a row with no cgroup fails this check
 *       outright rather than falling back to it, since there `-e` genuinely
 *       ran and a missing cgroup means the tail was invalid (see
 *       `parseSsTailFields`), not merely "this reader never has one".
 *   (c) Docker's own published ports confirm `(protocol, hostPort)` is
 *       actually published by a running container right now
 *       (`publishedByContainer`) — skipped, not failed, when Docker itself
 *       could not be reached (`dockerReachable`); (a) and (b) alone are
 *       enough to trust the pid/name in that case, just not enough to name
 *       a `container`.
 *
 * `readUids`/`readCgroup` are injected so a unit test can drive this with
 * no real `/proc` at all, mirroring `resolveMainProcess`'s own shape.
 */
async function verifyDockerProxyCandidate(
  pid: number,
  socketCgroupPath: string | null,
  allowMissingCgroupFallback: boolean,
  dockerReachable: boolean,
  publishedByContainer: boolean,
  readUids: (pid: number) => Promise<readonly [number, number, number, number] | null>,
  readCgroup: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const uids = await readUids(pid)
  if (!uids || uids.some((uid) => uid !== 0)) return false // (a)

  const proxyCgroup = await readCgroup(pid)
  if (proxyCgroup === null) return false
  const cgroupOk =
    socketCgroupPath !== null
      ? proxyCgroup === socketCgroupPath
      : allowMissingCgroupFallback && parseCgroup(proxyCgroup).unit === DOCKER_SERVICE_UNIT
  if (!cgroupOk) return false // (b)

  if (dockerReachable && !publishedByContainer) return false // (c)

  return true
}

/**
 * Runs every candidate bound to the same entry through
 * `verifyDockerProxyCandidate` and returns the one that passed — but ONLY
 * if exactly one did. Zero survivors means no candidate here can be
 * trusted; more than one (which should never happen for a real deployment
 * — see the module comment on `Attribution`) means this function refuses
 * to pick one by scan order, since that is exactly the kind of guess a
 * fake proxy racing a real one is trying to win. Either way the caller
 * falls through to `service` instead, same as no cmdline match at all.
 *
 * Async, with every read injected — mirrors `resolveMainProcess`'s own
 * shape so a unit test can drive the uid/cgroup/ambiguity logic together
 * with no real `/proc` and no real Docker daemon at all. The one real
 * caller (`applyDockerAttribution`) passes readers cached across the whole
 * request's pids.
 */
export async function resolveDockerProxy(
  candidates: readonly DockerProxyCandidate[],
  context: {
    socketCgroupPath: string | null
    /** See `verifyDockerProxyCandidate`'s own doc on check (b): true only
     * for the `/proc/net` reader, which has no cgroup column at all. On the
     * `ss` path this is always false — a missing cgroup there means the
     * `-e` tail was invalid, not "this reader never has one" (see
     * `applyDockerAttribution`). */
    allowMissingCgroupFallback: boolean
    dockerReachable: boolean
    isPublished: (protocol: Protocol, hostPort: number) => boolean
    readUids: (pid: number) => Promise<readonly [number, number, number, number] | null>
    readCgroup: (pid: number) => Promise<string | null>
  },
): Promise<DockerProxyCandidate | null> {
  const verified: DockerProxyCandidate[] = []
  for (const candidate of candidates) {
    const published = context.dockerReachable
      ? context.isPublished(candidate.binding.protocol, candidate.binding.hostPort)
      : false
    const ok = await verifyDockerProxyCandidate(
      candidate.pid,
      context.socketCgroupPath,
      context.allowMissingCgroupFallback,
      context.dockerReachable,
      published,
      context.readUids,
      context.readCgroup,
    )
    if (ok) verified.push(candidate)
  }
  return verified.length === 1 ? (verified[0] as DockerProxyCandidate) : null
}

interface ContainerPortsRow {
  name: string
  ports: readonly PublishedPort[]
}

/**
 * A hung daemon must not add more than a few seconds to this endpoint's own
 * response. `listAllContainerIds`/`inspectContainersRawAll` are already
 * bounded per call by `DOCKER_READ_TIMEOUT_MS` (10s, via the shared
 * `DockerCli`) — generous for a docker query taken on its own, but too long
 * to ask a dashboard poll to wait on just to learn a container's name.
 * Racing a shorter deadline only stops *this* request from waiting on it —
 * a `docker` child that was actually spawned is still killed on its own
 * schedule by `DockerCli`'s existing SIGKILL-on-timeout, exactly as it
 * would be for any other caller of these functions.
 */
const DOCKER_QUERY_TIMEOUT_MS = 5_000

/** `reachable: false` is what tells "Docker was actually asked and said
 * nothing publishes this port" apart from "Docker could not be asked at
 * all" — `rows: []` alone can't, since a real, reachable daemon with zero
 * running containers looks identical on the wire. `verifyDockerProxyCandidate`'s
 * own check (c) needs that distinction: unreachable waives the published-port
 * check entirely, reachable-but-empty fails it for every candidate. */
interface DockerPublishedPortsQuery {
  reachable: boolean
  rows: ContainerPortsRow[]
}

async function queryDockerPublishedPorts(cli: DockerCli): Promise<DockerPublishedPortsQuery> {
  try {
    return await Promise.race([
      (async () => {
        const { reachable, ids } = await listAllContainerIdsResult(cli)
        const raws = await inspectContainersRawAll(ids, cli)
        const rows = raws.map((raw) => {
          const container = toDockerContainer(raw)
          return { name: container.name, ports: container.ports }
        })
        return { reachable, rows }
      })(),
      sleep(DOCKER_QUERY_TIMEOUT_MS).then((): DockerPublishedPortsQuery => {
        throw new Error(`docker query timed out after ${DOCKER_QUERY_TIMEOUT_MS}ms`)
      }),
    ])
  } catch (error) {
    // Never fails the request over this — a docker query is an enrichment,
    // not a dependency this endpoint needs to answer at all (see the module
    // comment: `attribution` degrading to 'none' for these rows is exactly
    // the pre-existing, honest answer this feature already gives).
    logger.warn(
      `docker query for port attribution failed, container names left null (${String(error)})`,
    )
    return { reachable: false, rows: [] }
  }
}

/** Whether ANY running container publishes this exact `(protocol,
 * hostPort)` — `verifyDockerProxyCandidate`'s check (c). Deliberately
 * simpler than `resolveContainerForPort` below: existence is all a
 * candidate's own trustworthiness depends on, never which name wins when
 * more than one container happens to publish the same port. */
function isPublishedByAnyContainer(
  rows: readonly ContainerPortsRow[],
  protocol: Protocol,
  hostPort: number,
): boolean {
  return rows.some((row) =>
    row.ports.some((p) => p.protocol === protocol && p.hostPort === hostPort),
  )
}

/** Null when zero or more than one running container publishes this exact
 * host port and protocol — an ambiguous match is reported as unknown rather
 * than guessed at. */
function resolveContainerForPort(
  rows: readonly ContainerPortsRow[],
  protocol: Protocol,
  hostPort: number,
): string | null {
  const matches = rows.filter((row) =>
    row.ports.some((p) => p.protocol === protocol && p.hostPort === hostPort),
  )
  return matches.length === 1 ? (matches[0]?.name ?? null) : null
}

/**
 * Promotes every still-unattributed entry with exactly one VERIFIED
 * `docker-proxy` candidate (see `resolveDockerProxy`) to `attribution:
 * 'docker'` (see `Attribution`), then — only if at least one row actually
 * matched, so a box with no relevant published port never pays for a
 * docker query at all — asks Docker once for the container publishing each
 * matched port. `container` stays null for a matched row when Docker could
 * not be reached at all or the name resolution itself was ambiguous;
 * `attribution` and `pid`/`processName` do not depend on that second query,
 * since `resolveDockerProxy` already required a reachable Docker to
 * confirm the port before getting this far (or, when Docker was
 * unreachable, accepted the uid+cgroup checks alone).
 *
 * `allowMissingCgroupFallback` is threaded straight through to
 * `resolveDockerProxy`'s context — see its own doc comment. The two real
 * callers set it deliberately: `collectFromSs` passes `false` (a row with
 * no cgroup there means the `-e` tail was invalid, not merely absent by
 * design), `collectFromProc` passes `true` (the `/proc/net` reader has no
 * cgroup column at all, ever).
 */
async function applyDockerAttribution(
  entries: PortEntry[],
  cli: DockerCli,
  rawCgroupPathByEntry: RawCgroupPathByEntry,
  allowMissingCgroupFallback: boolean,
): Promise<void> {
  const bindings = await scanDockerProxyBindings(PROC_SCAN_BUDGET_MS)
  if (bindings.length === 0) return

  const matchesByEntry = new Map<PortEntry, DockerProxyCandidate[]>()
  for (const entry of entries) {
    const matches = bindings.filter((b) => dockerProxyMatches(entry, b.binding))
    if (matches.length > 0) matchesByEntry.set(entry, matches)
  }
  if (matchesByEntry.size === 0) return

  const query = await queryDockerPublishedPorts(cli)

  const uidCache = new Map<number, readonly [number, number, number, number] | null>()
  const cgroupCache = new Map<number, string | null>()
  const readUids = async (pid: number) => {
    if (!uidCache.has(pid)) uidCache.set(pid, await readProcUids(pid))
    return uidCache.get(pid) ?? null
  }
  const readCgroup = async (pid: number) => {
    if (!cgroupCache.has(pid)) cgroupCache.set(pid, await readProcCgroupPath(pid))
    return cgroupCache.get(pid) ?? null
  }
  const isPublished = (protocol: Protocol, hostPort: number) =>
    isPublishedByAnyContainer(query.rows, protocol, hostPort)

  for (const [entry, matches] of matchesByEntry) {
    const winner = await resolveDockerProxy(matches, {
      socketCgroupPath: rawCgroupPathByEntry.get(entry) ?? null,
      allowMissingCgroupFallback,
      dockerReachable: query.reachable,
      isPublished,
      readUids,
      readCgroup,
    })
    if (!winner) continue // none verified, or more than one did — fall through to `service`

    entry.attribution = 'docker'
    entry.pid = winner.pid
    entry.processName = DOCKER_PROXY_COMM
    entry.processKnown = true
    entry.container = query.reachable
      ? resolveContainerForPort(query.rows, winner.binding.protocol, winner.binding.hostPort)
      : null
  }
}

// --- `service` attribution: the systemd unit's main process ----------------

const CGROUP_ROOT = '/sys/fs/cgroup'

async function readCgroupProcs(validPath: string): Promise<number[]> {
  try {
    const text = await readFile(`${CGROUP_ROOT}${validPath}/cgroup.procs`, 'utf8')
    return text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n))
  } catch {
    return [] // unreadable is treated the same as legitimately empty (see the caller)
  }
}

const PPID_RE = /^PPid:\s*(\d+)/m

async function readPPid(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8')
    const m = PPID_RE.exec(text)
    return m ? Number(m[1]) : null
  } catch {
    return null // exited, or unreadable
  }
}

/**
 * Pure: given each candidate pid's own current PPid (or null if it could
 * not be read), the unit's main process is the one whose parent is NOT
 * itself a member of the same cgroup — everything else in the set is a
 * worker forked *by* something already in it. The lowest pid breaks a tie
 * between more than one process satisfying that (rare, but a unit with more
 * than one top-level process is possible), which is at least deterministic
 * even when it isn't more meaningful than that. `ppidOf` is injected so a
 * unit test can drive this with no real /proc at all — see
 * `resolveMainProcess`, the one real caller, for the cached reader it
 * builds `ppidOf` from.
 */
export function selectMainProcess(
  pids: readonly number[],
  ppidOf: ReadonlyMap<number, number | null>,
): number | null {
  const pidSet = new Set(pids)
  let best: number | null = null
  for (const pid of pids) {
    const ppid = ppidOf.get(pid)
    if (ppid === null || ppid === undefined) continue
    if (!pidSet.has(ppid) && (best === null || pid < best)) best = pid
  }
  return best
}

/**
 * Async wrapper around `selectMainProcess`, with the pid -> PPid reader
 * injected — mirrors `attributeInodes`'s own shape so a unit test can drive
 * this with no real /proc at all. The one real caller (`applyServiceAttribution`)
 * passes a reader cached across the whole request; this function does not
 * cache anything itself, since a single unit's own pid list is small and
 * never revisited within one call.
 */
export async function resolveMainProcess(
  pids: readonly number[],
  readPPidFor: (pid: number) => Promise<number | null>,
): Promise<number | null> {
  const ppidOf = new Map<number, number | null>()
  for (const pid of pids) ppidOf.set(pid, await readPPidFor(pid))
  return selectMainProcess(pids, ppidOf)
}

/**
 * For every still-unattributed entry with a validated cgroup path
 * (`cgroupPathByEntry`), attributes it to its unit's main process. Reads
 * are cached per request — `cgroup.procs` once per distinct path, `PPid`/
 * `comm` once per distinct pid — because the same unit (and the same pid
 * within it) legitimately recurs across many sockets on one request (every
 * postgres backend socket shares postgres's own postmaster's cgroup, for
 * instance).
 *
 * An entry whose `unit` came back null (see `parseCgroup` — a bare slice
 * with no `.service`/`.socket`/`.scope` segment at all) is skipped rather
 * than read: there is no unit here to name a "main process" *of*, and
 * reading an arbitrary slice's `cgroup.procs` could hold dozens of
 * unrelated units' processes with no meaningful "main" among them.
 */
async function applyServiceAttribution(
  entries: readonly PortEntry[],
  cgroupPathByEntry: CgroupPathByEntry,
): Promise<void> {
  const procsCache = new Map<string, number[]>()
  const ppidCache = new Map<number, number | null>()
  const commCache = new Map<number, string | null>()

  const cachedReadPPid = async (pid: number): Promise<number | null> => {
    if (!ppidCache.has(pid)) ppidCache.set(pid, await readPPid(pid))
    return ppidCache.get(pid) ?? null
  }
  const cachedReadComm = async (pid: number): Promise<string | null> => {
    if (!commCache.has(pid)) commCache.set(pid, await readProcComm(pid))
    return commCache.get(pid) ?? null
  }

  for (const entry of entries) {
    if (entry.unit === null) continue
    const validPath = cgroupPathByEntry.get(entry)
    if (!validPath) continue

    let pids = procsCache.get(validPath)
    if (pids === undefined) {
      pids = await readCgroupProcs(validPath)
      procsCache.set(validPath, pids)
    }

    if (pids.length > 0) {
      const mainPid = await resolveMainProcess(pids, cachedReadPPid)
      if (mainPid === null) continue
      const comm = await cachedReadComm(mainPid)
      if (comm === null) continue
      entry.attribution = 'service'
      entry.pid = mainPid
      entry.processName = comm
      entry.processKnown = true
    } else if (entry.unit.endsWith('.socket')) {
      // Socket activation: systemd (pid 1) itself holds the listener until
      // the unit it activates has actually started, so an empty
      // `cgroup.procs` here is the expected steady state, not a miss.
      const comm = await cachedReadComm(1)
      if (comm === null) continue
      entry.attribution = 'service'
      entry.pid = 1
      entry.processName = comm
      entry.processKnown = true
    }
  }
}

/** Runs the `docker` then `service` passes over whatever is still
 * `'none'` after the socket-inode attribution pass. First match wins, so an
 * entry `applyDockerAttribution` already promoted is never reconsidered by
 * `applyServiceAttribution`. A no-op, with no /proc scan and no docker
 * query, when nothing is unattributed at all (the fast path on a box where
 * the inode scan resolves most rows itself, or an empty ports table). */
async function enrichUnattributed(
  entries: PortEntry[],
  cgroupPathByEntry: CgroupPathByEntry,
  rawCgroupPathByEntry: RawCgroupPathByEntry,
  cli: DockerCli,
  allowMissingCgroupFallback: boolean,
): Promise<void> {
  const unresolved = entries.filter((e) => e.attribution === 'none')
  if (unresolved.length === 0) return

  await applyDockerAttribution(unresolved, cli, rawCgroupPathByEntry, allowMissingCgroupFallback)

  const stillUnresolved = unresolved.filter((e) => e.attribution === 'none')
  if (stillUnresolved.length > 0) await applyServiceAttribution(stillUnresolved, cgroupPathByEntry)
}

/** Inodes worth asking `attributeInodes` about — every line/row's own
 * inode, except `0` (and `null`, which the ss reader's `ino` can be when
 * `-e` carried no such token at all): `0` is ss's own sentinel for a
 * kernel-held orphan socket with no owning process (see `ownerForLine`),
 * so asking about it could only ever attribute some UNRELATED process's fd
 * whose /proc readlink happens to print the literal string `socket:[0]` —
 * which the kernel never assigns to a real socket, but there is nothing to
 * gain by ever forming the request either way. Shared by both readers. */
function collectAttributableInodes(values: Iterable<number | null>): Set<number> {
  const inodes = new Set<number>()
  for (const value of values) if (value) inodes.add(value)
  return inodes
}

async function collectFromSs(
  scope: PortScope,
  cli: DockerCli,
  passwdMap: ReadonlyMap<number, string>,
): Promise<SsAttempt> {
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

  const inodes = collectAttributableInodes(lines.map((line) => line.ino))
  const attribution = await attributeInodes(inodes)

  const cgroupPathByEntry = new Map<PortEntry, string>()
  const rawCgroupPathByEntry = new Map<PortEntry, string>()
  const entries: PortEntry[] = []
  for (const line of lines) {
    const byPid = line.ino ? attribution.get(line.ino) : undefined
    const { validPath } = parseCgroup(line.cgroupPath)

    if (!byPid || byPid.size === 0) {
      const entry = toUnknownEntry(line, passwdMap)
      if (validPath) cgroupPathByEntry.set(entry, validPath)
      if (line.cgroupPath) rawCgroupPathByEntry.set(entry, line.cgroupPath)
      entries.push(entry)
      continue
    }
    for (const [pid, name] of byPid) {
      const entry = toKnownEntry(line, pid, name, passwdMap)
      if (validPath) cgroupPathByEntry.set(entry, validPath)
      if (line.cgroupPath) rawCgroupPathByEntry.set(entry, line.cgroupPath)
      entries.push(entry)
    }
  }

  // No cgroup on the ss path is never treated as "this reader has none by
  // design" — see applyDockerAttribution's own doc comment — only the
  // /proc/net reader (collectFromProc) passes `true` here.
  await enrichUnattributed(entries, cgroupPathByEntry, rawCgroupPathByEntry, cli, false)
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
  /** From /proc/net's own `uid` column — always known (unlike ss's `-e`
   * uid, this is not conditional on any flag), null only if the field
   * itself failed to parse as an integer. */
  uid: number | null
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
    const uidRaw = fields[7] ?? ''
    const inodeRaw = fields[9] ?? ''
    const local = splitHexAddrPort(localRaw)
    const peer = splitHexAddrPort(remRaw)
    if (!local || !peer) continue

    const inode = Number(inodeRaw)
    if (!Number.isFinite(inode)) continue
    const uid = Number(uidRaw)

    rows.push({
      localAddress: local.address,
      localPort: local.port,
      peerAddress: peer.address,
      peerPort: peer.port,
      state: stateTable[stateRaw.toUpperCase()] ?? 'UNKNOWN',
      inode,
      uid: Number.isInteger(uid) ? uid : null,
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

/** How long the /proc/<pid>/fd scan (and, on the ss path, the docker-proxy
 * comm scan) is allowed to run. A box with an enormous process table must
 * not turn one GET into a multi-second hang — past this, whatever rows are
 * left unattributed just stay that way. */
const PROC_SCAN_BUDGET_MS = 2_000

const SOCKET_FD_RE = /^socket:\[(\d+)\]$/

/**
 * The filesystem calls `attributeInodes` needs, factored out so a unit test
 * can drive the whole scan against fabricated pids/fds/comms with no real
 * `/proc` at all — the same reasoning as `verifyDockerProxyCandidate`'s
 * injected `readUids`/`readCgroup`. `REAL_PROC_FD_READERS` is what every
 * production caller actually gets (the default parameter below).
 */
export interface ProcFdReaders {
  /** `readdir('/proc')` — every pid directory currently present. */
  listPids: () => Promise<string[]>
  /** `readdir('/proc/<pid>/fd')` — every fd number currently open for
   * `pid`. Rejects (EACCES) for a pid this account does not own; the one
   * caller (`attributeInodes`) treats that as "nothing to see here", not
   * an error worth logging, since it is the expected outcome for almost
   * every pid on almost every request (see the module comment). */
  listFds: (pid: number) => Promise<string[]>
  /** `readlink('/proc/<pid>/fd/<fd>')` — what that one fd points at. */
  readFdLink: (pid: number, fd: string) => Promise<string>
  /** `/proc/<pid>/comm`, byte-exact past the one trailing-newline strip —
   * see `readProcComm`. Null when the pid has already exited. */
  readComm: (pid: number) => Promise<string | null>
}

const REAL_PROC_FD_READERS: ProcFdReaders = {
  listPids: () => readdir('/proc'),
  listFds: (pid) => readdir(`/proc/${pid}/fd`),
  readFdLink: (pid, fd) => readlink(`/proc/${pid}/fd/${fd}`),
  readComm: readProcComm,
}

/**
 * inode -> (pid -> comm), for exactly the inodes asked for. Scans
 * `/proc/<pid>/fd`, which throws EACCES on every pid this service account
 * does not own — the normal case on this deployment (see the module
 * comment), skipped silently rather than logged, since it would otherwise
 * log on almost every pid on every request. Reused by both readers
 * (`collectFromSs` and `collectFromProc`): this IS the `'socket'`
 * attribution pass (see `Attribution`) — the one and only place a pid is
 * ever attached to a socket in this module, and it happens with zero bytes
 * of process-controlled text ever entering a parse step (see the module
 * comment).
 *
 * One `listPids()` (`readdir('/proc')`) per call, bounded by
 * `PROC_SCAN_BUDGET_MS` overall so a box with an enormous process table
 * cannot turn one request into a multi-second hang, and `comm` is read at
 * most once per distinct pid (`commCache`) no matter how many of its fds
 * turn out to hold a requested inode.
 */
export async function attributeInodes(
  inodes: ReadonlySet<number>,
  readers: ProcFdReaders = REAL_PROC_FD_READERS,
): Promise<Map<number, Map<number, string>>> {
  const result = new Map<number, Map<number, string>>()
  if (inodes.size === 0) return result

  let pidDirs: string[]
  try {
    pidDirs = await readers.listPids()
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
      fds = await readers.listFds(pid)
    } catch {
      continue
    }

    for (const fd of fds) {
      let link: string
      try {
        link = await readers.readFdLink(pid, fd)
      } catch {
        continue // fd closed between the listing and this readlink
      }
      const match = SOCKET_FD_RE.exec(link)
      if (!match) continue
      const inode = Number(match[1])
      if (!inodes.has(inode)) continue

      let name = commCache.get(pid)
      if (name === undefined) {
        name = await readers.readComm(pid)
        commCache.set(pid, name)
      }
      if (name === null) continue // exited between the scan and this read — nothing to attribute

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

async function collectFromProc(
  scope: PortScope,
  cli: DockerCli,
  passwdMap: ReadonlyMap<number, string>,
): Promise<PortEntry[]> {
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

  const inodes = collectAttributableInodes(filtered.map((row) => row.inode))
  const attribution = await attributeInodes(inodes)

  // No cgroup at all in this reader (/proc/net carries no such column), so
  // `service` attribution never applies here — only `socket` (this scan) and
  // `docker` (port-based, tried below) can resolve a row. See the module
  // comment on the two readers' differing detail.
  const entries: PortEntry[] = []
  for (const row of filtered) {
    const peer = normalizePeer(row.peerAddress, row.peerPort)
    const byPid = row.inode !== 0 ? attribution.get(row.inode) : undefined
    // ino 0 is the same orphan-socket sentinel here as in the ss reader's
    // `ino:0` — see `ownerForLine` — even though this reader's `uid` column
    // is always genuinely present rather than root-by-omission: an orphan
    // socket still has no real owning process to report one for.
    const owner = row.inode === 0 ? null : ownerForUid(row.uid, passwdMap)

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
        attribution: 'none',
        unit: null,
        container: null,
        owner,
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
        attribution: 'socket',
        unit: null,
        container: null,
        owner,
      })
    }
  }

  // No raw cgroup for `docker` attribution's own socket-cgroup check to
  // compare against — it falls back to its own proxy-cgroup-is-docker.service
  // rule instead (see `verifyDockerProxyCandidate`, `allowMissingCgroupFallback: true`).
  await enrichUnattributed(entries, new Map(), new Map(), cli, true)
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
    unattributedCount: truncatedPorts.filter((p) => p.attribution === 'none').length,
    inferredCount: truncatedPorts.filter(
      (p) => p.attribution === 'docker' || p.attribution === 'service',
    ).length,
    ports: truncatedPorts,
  }
}

async function collectPorts(scope: PortScope, cli: DockerCli): Promise<PortsResult> {
  const collectedAt = new Date().toISOString()
  const passwdMap = await loadPasswdOwners()
  const ssAttempt = await collectFromSs(scope, cli, passwdMap)

  if (ssAttempt.ok) {
    return buildResult(scope, 'ss', collectedAt, ssAttempt.entries)
  }

  logger.warn(`ss unavailable for the ports endpoint (${ssAttempt.reason}) — falling back to /proc`)
  try {
    const procPorts = await collectFromProc(scope, cli, passwdMap)
    return buildResult(scope, 'proc', collectedAt, procPorts)
  } catch (procError) {
    throw serviceUnavailable(
      `Could not read the port table: ${ssAttempt.reason}, and ${String((procError as Error)?.message ?? procError)}`,
    )
  }
}

// Deduped per scope, not TTL-cached: a manual "Refresh" on the dashboard must
// see the current table, not a stale one, but several requests landing in
// the same tick (e.g. two browser tabs) should still share one read. Keyed
// on scope alone — `cli` is never anything but `realDockerCli` in production
// (routes.ts never passes one), so a second key component here would only
// ever have one real value anyway.
const inFlight: Partial<Record<PortScope, Promise<PortsResult>>> = {}

export async function getPorts(
  scope: PortScope,
  cli: DockerCli = realDockerCli,
): Promise<PortsResult> {
  const existing = inFlight[scope]
  if (existing) return existing

  const promise = collectPorts(scope, cli)
  inFlight[scope] = promise
  try {
    return await promise
  } finally {
    inFlight[scope] = undefined
  }
}
