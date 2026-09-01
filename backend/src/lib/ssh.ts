// SSH key generation and testing, for cloning private repositories.
//
// Two deliberate departures from the usual interactive recipe:
//
//   1. Keys are generated with no passphrase. A server clones unattended, so
//      there is nobody to type one.
//   2. There is no ssh-agent. `eval "$(ssh-agent -s)"` exports variables into
//      one shell; a long-running systemd worker never sees them, and the agent
//      dies on reboot. An agent only earns its keep by caching the passphrase of
//      an encrypted key, which is exactly what we do not have.
//
// Instead each clone points ssh at one specific key with GIT_SSH_COMMAND, so
// nothing global is mutated and a project's key is explicit.

import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from '@/env'
import { logger } from './logger'
import { hasControlChars } from './text'

export const SSH_KEYS_DIR = env.SSH_KEYS_DIR || join(homedir(), '.ssh', 'agentoo')

/** Filesystem-safe key name. The name becomes a path, so it is checked like one. */
export function checkKeyName(name: string): { ok: boolean; reason?: string } {
  if (name.length === 0) return { ok: false, reason: 'Name is empty' }
  if (name.length > 64) return { ok: false, reason: 'Name is too long (max 64)' }
  if (hasControlChars(name)) return { ok: false, reason: 'Name contains control characters' }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return {
      ok: false,
      reason:
        'Name may contain only letters, digits, dot, dash and underscore, and must start with a letter or digit',
    }
  }
  return { ok: true }
}

/**
 * The comment lands in `ssh-keygen -C`. There is no shell — Bun.spawn takes an
 * argv array — but a newline would still corrupt the public key file, which is
 * line-oriented.
 */
export function checkComment(comment: string): { ok: boolean; reason?: string } {
  if (comment.length > 200) return { ok: false, reason: 'Comment is too long (max 200)' }
  if (hasControlChars(comment)) return { ok: false, reason: 'Comment contains control characters' }
  return { ok: true }
}

/**
 * Host for a connectivity test.
 *
 * The value reaches ssh's argv, and ssh parses anything starting with `-` as an
 * option — `-oProxyCommand=<cmd>` runs that command through a shell. A single
 * option-shaped token cannot exploit this on its own, because ssh needs a
 * destination as well and prints usage without one, but that is a property of
 * the current argv layout rather than a guarantee. Validating here and passing
 * `--` below means neither has to hold.
 */
export function checkHost(host: string): { ok: boolean; reason?: string } {
  if (host.length === 0) return { ok: false, reason: 'Host is empty' }
  if (host.length > 255) return { ok: false, reason: 'Host is too long' }
  if (hasControlChars(host)) return { ok: false, reason: 'Host contains control characters' }
  if (host.startsWith('-')) return { ok: false, reason: 'Host may not start with "-"' }
  // Optional user@, then a hostname. No ports: `ssh -T` takes a port with -p,
  // not host:port, so accepting one here would only mislead.
  if (!/^([A-Za-z0-9._-]+@)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    return { ok: false, reason: 'Host must look like github.com or git@github.com' }
  }
  return { ok: true }
}

export const privateKeyPath = (name: string) => join(SSH_KEYS_DIR, name)
export const publicKeyPath = (name: string) => `${join(SSH_KEYS_DIR, name)}.pub`

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

interface Spawned {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

async function run(cmd: string[]): Promise<Spawned> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

export interface GeneratedKey {
  name: string
  comment: string
  publicKey: string
  fingerprint: string
  privateKeyPath: string
}

export async function generateKey(name: string, comment: string): Promise<GeneratedKey> {
  await mkdir(SSH_KEYS_DIR, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by umask, so set it explicitly.
  await chmod(SSH_KEYS_DIR, 0o700)

  const priv = privateKeyPath(name)
  const pub = publicKeyPath(name)

  if (await exists(priv)) {
    throw new Error(`A key already exists at ${priv}`)
  }

  // -N '' is the passphraseless part; -q keeps ssh-keygen from drawing art.
  const result = await run([
    'ssh-keygen',
    '-t',
    'ed25519',
    '-C',
    comment,
    '-f',
    priv,
    '-N',
    '',
    '-q',
  ])
  if (!result.ok) {
    throw new Error(result.stderr || 'ssh-keygen failed')
  }

  await chmod(priv, 0o600)
  await chmod(pub, 0o644)

  const publicKey = (await readFile(pub, 'utf8')).trim()
  const fingerprint = await fingerprintOf(pub)

  logger.info(`Generated ssh key ${name} (${fingerprint})`)
  return { name, comment, publicKey, fingerprint, privateKeyPath: priv }
}

/** `ssh-keygen -lf` prints "256 SHA256:… comment (ED25519)"; keep the hash. */
export async function fingerprintOf(pubPath: string): Promise<string> {
  const result = await run(['ssh-keygen', '-lf', pubPath])
  if (!result.ok) return 'unknown'
  return result.stdout.split(/\s+/)[1] ?? 'unknown'
}

export async function deleteKeyFiles(name: string): Promise<void> {
  await rm(privateKeyPath(name), { force: true })
  await rm(publicKeyPath(name), { force: true })
}

/** ssh options that make a non-interactive connection fail fast rather than hang. */
export function sshOptionsFor(keyPath: string): string[] {
  return [
    '-i',
    keyPath,
    // Offer only this key: otherwise ssh walks every default identity and a host
    // with a low MaxAuthTries answers "Too many authentication failures".
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
  ]
}

/** The GIT_SSH_COMMAND that makes one clone use one specific key. */
export function gitSshCommand(keyPath: string): string {
  // Paths come from our own SSH_KEYS_DIR plus a validated name, so quoting is
  // belt and braces rather than the only defence.
  return ['ssh', ...sshOptionsFor(keyPath)]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/(["\\])/g, '\\$1')}"` : part))
    .join(' ')
}

export interface KeyTestResult {
  ok: boolean
  message: string
}

/**
 * Try the key against a git host.
 *
 * GitHub and GitLab both refuse a shell and exit non-zero even on success, so
 * the exit code says nothing useful — the greeting on stderr is the signal.
 */
export async function testKey(keyPath: string, host: string): Promise<KeyTestResult> {
  const check = checkHost(host)
  if (!check.ok) return { ok: false, message: check.reason ?? 'Invalid host' }

  const target = host.includes('@') ? host : `git@${host}`
  // `--` stops option parsing, so even a host that slipped past validation is
  // read as a destination rather than a flag. Verified: OpenSSH honours it.
  const result = await run(['ssh', '-T', ...sshOptionsFor(keyPath), '--', target])
  const output = `${result.stderr}\n${result.stdout}`.trim()

  if (/successfully authenticated|Welcome to GitLab|logged in as/i.test(output)) {
    return { ok: true, message: output.split('\n')[0] ?? 'Authenticated' }
  }
  if (/permission denied|publickey/i.test(output)) {
    return {
      ok: false,
      message: 'The host rejected this key. Has it been added as a deploy key yet?',
    }
  }
  if (/could not resolve|connection timed out|network is unreachable/i.test(output)) {
    return { ok: false, message: `Could not reach ${target}: ${output.split('\n')[0]}` }
  }
  return { ok: false, message: output.split('\n')[0] || 'No response from the host' }
}
