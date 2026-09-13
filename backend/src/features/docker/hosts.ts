// Every address a browser on the tailnet might actually reach a published
// port by. The server only ever returns *hosts* — it has no way to know which
// origin the browser used to load the page, so the current hostname is added
// client-side and is deliberately not this module's concern.
//
// Preference order: tailscale (works from anywhere on the tailnet, which is
// this app's whole deployment model), then LAN (works from the same
// network), then loopback (works only from the box itself, but always
// works).

import { networkInterfaces } from 'node:os'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { readBounded } from '@/lib/spawn'

export interface HostAddress {
  kind: 'tailscale' | 'lan' | 'loopback'
  label: string
  host: string
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// --- tailscale, cached ---------------------------------------------------

export interface TailscaleAddresses {
  dnsName: string | null
  ip: string | null
}

const NO_TAILSCALE: TailscaleAddresses = { dnsName: null, ip: null }

const tailscaleStatusRaw = z
  .object({
    BackendState: z.string().optional(),
    Self: z
      .object({
        DNSName: z.string().optional(),
        TailscaleIPs: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

/**
 * How long a resolved (or empty) tailscale result is trusted before spawning
 * again. Applies equally to "tailscale answered" and "tailscale is not
 * installed" — a box with no tailscale binary must not re-spawn `tailscale`
 * on every request either.
 */
export const HOST_ADDRESS_TTL_MS = 60_000
const TAILSCALE_TIMEOUT_MS = 3_000

async function runTailscaleStatus(): Promise<TailscaleAddresses> {
  // See docker/cli.ts's identical comment: a local, non-generic function is
  // what lets `ReturnType<typeof spawn>` capture the literal `stdout`/
  // `stderr` pair this call actually asks for, rather than Bun.spawn's
  // generic defaults.
  const spawn = () =>
    Bun.spawn(['tailscale', 'status', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TAILSCALE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })

  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn()
  } catch {
    // Binary not installed. Not an error — most boxes running this app do
    // have it, but nothing here requires it.
    return NO_TAILSCALE
  }

  const [stdout] = await Promise.all([
    readBounded(proc.stdout, proc.exited),
    readBounded(proc.stderr, proc.exited),
    proc.exited,
  ])
  if (proc.exitCode !== 0) return NO_TAILSCALE

  const shaped = tailscaleStatusRaw.safeParse(safeJsonParse(stdout))
  if (!shaped.success || shaped.data.BackendState !== 'Running') return NO_TAILSCALE

  const dnsName = shaped.data.Self?.DNSName?.replace(/\.$/, '') || null
  const ip = shaped.data.Self?.TailscaleIPs?.[0] ?? null
  return { dnsName, ip }
}

let cache: { at: number; value: TailscaleAddresses } | null = null
// Deduplicates concurrent callers onto one spawn — several requests to
// GET /projects/{id}/docker arriving inside the same tick must not each start
// their own `tailscale status`.
let inFlight: Promise<TailscaleAddresses> | null = null

export async function getTailscaleAddresses(): Promise<TailscaleAddresses> {
  const now = Date.now()
  if (cache && now - cache.at < HOST_ADDRESS_TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = runTailscaleStatus()
    .catch((error) => {
      logger.warn(`tailscale status --json failed: ${String(error)}`)
      return NO_TAILSCALE
    })
    .then((value) => {
      cache = { at: Date.now(), value }
      inFlight = null
      return value
    })
  return inFlight
}

/** Test-only: setup-env-style state reset between tests. */
export function resetTailscaleCacheForTests(): void {
  cache = null
  inFlight = null
}

// --- assembly, pure and therefore fully testable ---------------------------

export interface NetworkInterfaceAddress {
  address: string
  family: string
  internal: boolean
}
export type NetworkInterfacesInput = Record<string, NetworkInterfaceAddress[] | undefined>

function isBridgeIsh(name: string): boolean {
  return name === 'docker0' || name.startsWith('br-') || name.startsWith('veth')
}

export function assembleHosts(input: {
  interfaces: NetworkInterfacesInput
  tailscale: TailscaleAddresses
}): HostAddress[] {
  const hosts: HostAddress[] = []

  if (input.tailscale.dnsName) {
    hosts.push({ kind: 'tailscale', label: 'Tailscale', host: input.tailscale.dnsName })
  }
  if (input.tailscale.ip) {
    hosts.push({ kind: 'tailscale', label: 'Tailscale (IP)', host: input.tailscale.ip })
  }

  for (const [name, addresses] of Object.entries(input.interfaces)) {
    if (isBridgeIsh(name)) continue
    for (const addr of addresses ?? []) {
      if (addr.internal) continue
      // IPv6 link-local addresses need a zone id a plain URL cannot carry,
      // and this deployment's tailnet-first model makes LAN IPv6 unnecessary
      // to solve for — IPv4 covers every network this box actually runs on.
      if (addr.family !== 'IPv4') continue
      if (addr.address === input.tailscale.ip) continue // already listed above
      hosts.push({ kind: 'lan', label: name, host: addr.address })
    }
  }

  hosts.push({ kind: 'loopback', label: 'localhost', host: '127.0.0.1' })

  return hosts
}

export async function getHostAddresses(): Promise<HostAddress[]> {
  const tailscale = await getTailscaleAddresses()
  return assembleHosts({ interfaces: networkInterfaces() as NetworkInterfacesInput, tailscale })
}
