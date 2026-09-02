// Host load, for the status bar.
//
// Read straight from /proc and statfs rather than shelling out to top or df:
// no subprocess per poll, and the numbers are the ones the kernel reports.
// Linux-only, which this is — the installer targets Ubuntu.

import { readFile, statfs } from 'node:fs/promises'
import { cpus, loadavg, uptime } from 'node:os'
import { env } from '@/env'
import { logger } from '@/lib/logger'

export interface SystemStats {
  cpu: { usagePercent: number; cores: number; load1: number }
  memory: { usedBytes: number; totalBytes: number; usedPercent: number }
  disk: { usedBytes: number; totalBytes: number; usedPercent: number; path: string }
  uptimeSeconds: number
}

/** /proc/meminfo values are in kB. */
async function memory(): Promise<SystemStats['memory']> {
  const text = await readFile('/proc/meminfo', 'utf8')
  const field = (key: string) =>
    Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024

  const totalBytes = field('MemTotal')
  // MemAvailable, not MemFree: free excludes the page cache, which the kernel
  // will hand back under pressure, so it reads as far more used than it is.
  const used = totalBytes - field('MemAvailable')
  return {
    usedBytes: used,
    totalBytes,
    usedPercent: totalBytes > 0 ? round((used / totalBytes) * 100) : 0,
  }
}

interface CpuSample {
  idle: number
  total: number
}

/** The aggregate `cpu` line of /proc/stat: cumulative jiffies per state. */
async function cpuSample(): Promise<CpuSample | null> {
  const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0]
  if (!line?.startsWith('cpu ')) return null
  const values = line.trim().split(/\s+/).slice(1).map(Number)
  if (values.length < 5 || values.some(Number.isNaN)) return null
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (values[3] ?? 0) + (values[4] ?? 0)
  return { idle, total: values.reduce((sum, n) => sum + n, 0) }
}

// Those counters are cumulative since boot, so a single read gives the average
// over the machine's whole uptime — a flat, useless number. Usage is the delta
// between two reads, which means remembering the last one.
let previous: CpuSample | null = null

async function cpu(): Promise<SystemStats['cpu']> {
  const sample = await cpuSample()
  const cores = cpus().length
  const load1 = round(loadavg()[0] ?? 0)

  if (!sample) return { usagePercent: 0, cores, load1 }

  const last = previous
  previous = sample

  // First call after boot has nothing to compare against. Fall back to load
  // average as a rough stand-in rather than reporting a confident 0%.
  if (!last) {
    return { usagePercent: Math.min(100, round((load1 / Math.max(cores, 1)) * 100)), cores, load1 }
  }

  const totalDelta = sample.total - last.total
  const idleDelta = sample.idle - last.idle
  // Counters can appear to go backwards across a suspend or a container move.
  if (totalDelta <= 0) return { usagePercent: 0, cores, load1 }

  const busy = ((totalDelta - idleDelta) / totalDelta) * 100
  return { usagePercent: clamp(round(busy)), cores, load1 }
}

/**
 * Disk usage where it matters: the directory holding project checkouts and
 * worktrees. That is what fills up, and it is often not the root filesystem.
 */
async function disk(): Promise<SystemStats['disk']> {
  const path = env.PROJECTS_DIR
  for (const target of [path, '/']) {
    try {
      const fs = await statfs(target)
      const totalBytes = Number(fs.blocks) * Number(fs.bsize)
      // bavail, not bfree: bfree counts blocks reserved for root, which a
      // service account cannot actually use.
      const usedBytes = totalBytes - Number(fs.bavail) * Number(fs.bsize)
      return {
        usedBytes,
        totalBytes,
        usedPercent: totalBytes > 0 ? round((usedBytes / totalBytes) * 100) : 0,
        path: target,
      }
    } catch (error) {
      // PROJECTS_DIR may not exist yet on a fresh install; / always does.
      if (target === '/') logger.warn(`Could not stat any filesystem: ${String(error)}`)
    }
  }
  return { usedBytes: 0, totalBytes: 0, usedPercent: 0, path }
}

const round = (n: number) => Math.round(n * 10) / 10
const clamp = (n: number) => Math.min(100, Math.max(0, n))

export async function systemStats(): Promise<SystemStats> {
  const [cpuStats, memoryStats, diskStats] = await Promise.all([cpu(), memory(), disk()])
  return {
    cpu: cpuStats,
    memory: memoryStats,
    disk: diskStats,
    uptimeSeconds: Math.round(uptime()),
  }
}
