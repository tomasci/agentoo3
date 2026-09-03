import { expect, test } from 'bun:test'

// PROJECTS_DIR is set there to a path that does not exist, which is what the
// fallback below relies on: a fresh install has no projects directory yet, and
// the status bar must still show a disk figure.
import './setup-env'

const { systemStats, cpuUsageBetween } = await import('../src/features/system/service')

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

// Asserted against fixed counters rather than two live samples.
//
// This used to busy-wait and require the two readings to differ. On an idle
// machine that works; under load both intervals are genuinely 100% and the
// assertion cannot hold, however long the busy-wait. pre-push runs four jobs
// concurrently, so it failed there two pushes in three — reported as `0 fail`
// with a non-zero exit, which reads like anything but a CPU-usage assertion.
//
// The property worth pinning is that usage comes from the delta between two
// reads, not from the counters' cumulative value. Fixed numbers state that
// outright, and cannot be perturbed by whatever else the machine is doing.
test('cpu usage is the delta between two reads, not the average since boot', () => {
  // Cumulative counters from a long-lived, mostly-idle machine: 90% idle.
  const boot = { idle: 900_000, total: 1_000_000 }

  // 1000 jiffies pass and every one is busy. Interval usage is 100%, while the
  // cumulative average barely moves off 10% — so a regression to reporting the
  // average could not produce this number.
  expect(cpuUsageBetween(boot, { idle: 900_000, total: 1_001_000 })).toBe(100)

  // The same interval, entirely idle.
  expect(cpuUsageBetween(boot, { idle: 901_000, total: 1_001_000 })).toBe(0)

  // Half busy.
  expect(cpuUsageBetween(boot, { idle: 900_500, total: 1_001_000 })).toBe(50)
})

test('cpu usage survives counters that do not advance or appear to go backwards', () => {
  const sample = { idle: 900_000, total: 1_000_000 }
  // Identical reads: no interval to measure, so 0 rather than NaN.
  expect(cpuUsageBetween(sample, sample)).toBe(0)
  // Backwards across a suspend or a container move.
  expect(cpuUsageBetween(sample, { idle: 800_000, total: 900_000 })).toBe(0)
  // Idle racing ahead of total would give a negative busy fraction; clamped.
  expect(cpuUsageBetween(sample, { idle: 903_000, total: 1_001_000 })).toBe(0)
})

test('cpu usage from the live machine is a percentage', async () => {
  const { cpu } = await systemStats()
  expect(cpu.cores).toBeGreaterThan(0)
  expect(cpu.usagePercent).toBeGreaterThanOrEqual(0)
  expect(cpu.usagePercent).toBeLessThanOrEqual(100)
  expect(Number.isFinite(cpu.usagePercent)).toBe(true)
})

test('uptime is a whole number of seconds', async () => {
  const { uptimeSeconds } = await systemStats()
  expect(Number.isInteger(uptimeSeconds)).toBe(true)
  expect(uptimeSeconds).toBeGreaterThan(0)
})
