import { expect, test } from 'bun:test'

// PROJECTS_DIR is set there to a path that does not exist, which is what the
// fallback below relies on: a fresh install has no projects directory yet, and
// the status bar must still show a disk figure.
import './setup-env'

const { systemStats } = await import('../src/features/system/service')

test('disk falls back to / when the projects directory is not there yet', async () => {
  const stats = await systemStats()
  expect(stats.disk.path).toBe('/')
  expect(stats.disk.totalBytes).toBeGreaterThan(0)
  expect(stats.disk.usedBytes).toBeGreaterThan(0)
  expect(stats.disk.usedPercent).toBeGreaterThan(0)
  expect(stats.disk.usedPercent).toBeLessThanOrEqual(100)
})

test('memory is reported as in-use, not as total-minus-free', async () => {
  const { memory } = await systemStats()
  expect(memory.totalBytes).toBeGreaterThan(0)
  expect(memory.usedBytes).toBeGreaterThan(0)
  expect(memory.usedBytes).toBeLessThan(memory.totalBytes)
  // MemFree would put a normal Linux box near 100% because it excludes the page
  // cache; MemAvailable is what the kernel will actually give back.
  expect(memory.usedPercent).toBeLessThan(99)
  expect(memory.usedPercent).toBeCloseTo((memory.usedBytes / memory.totalBytes) * 100, 0)
})

test('cpu usage is a percentage, and reflects the interval rather than uptime', async () => {
  const first = await systemStats()
  expect(first.cpu.cores).toBeGreaterThan(0)

  // Busy-wait so the next sample has real work in it. The counters in /proc/stat
  // are cumulative since boot, so a single read would give a flat average over
  // the machine's whole uptime and never move.
  const end = Date.now() + 400
  let x = 0
  while (Date.now() < end) x += Math.sqrt(x + 1)

  const second = await systemStats()
  for (const stats of [first, second]) {
    expect(stats.cpu.usagePercent).toBeGreaterThanOrEqual(0)
    expect(stats.cpu.usagePercent).toBeLessThanOrEqual(100)
  }
  expect(second.cpu.usagePercent).not.toBe(first.cpu.usagePercent)
})

test('uptime is a whole number of seconds', async () => {
  const { uptimeSeconds } = await systemStats()
  expect(Number.isInteger(uptimeSeconds)).toBe(true)
  expect(uptimeSeconds).toBeGreaterThan(0)
})
