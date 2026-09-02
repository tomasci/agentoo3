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
