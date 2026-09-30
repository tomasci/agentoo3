/** Bytes as the shortest readable figure: 900 MB, 2.1 GB, 1.4 TB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  // One decimal only where it adds something: 2.1 GB, but 512 MB, not 512.0 MB.
  const digits = value < 10 && exponent > 0 ? 1 : 0
  return `${value.toFixed(digits)} ${units[exponent]}`
}

/** A host and port as one string, bracketing the host when it's IPv6 so its
 * own colons can't be mistaken for the address/port separator: bare
 * `2001:4860:4840:400::443` reads as ambiguous (where does the address end?),
 * while `[2001:4860:4840:400::]:443` doesn't. An address counts as IPv6 the
 * moment it contains a `:` — a zone suffix (`fe80::1%eth0`) is part of that
 * address and stays inside the brackets rather than tacked on after them.
 * IPv4 and the `*` wildcard have no `:` of their own, so they render
 * unbracketed. A null `port` renders the host alone, with no dangling `:`. */
export function formatHostPort(address: string, port: number | null): string {
  const host = address.includes(':') ? `[${address}]` : address
  return port == null ? host : `${host}:${port}`
}
