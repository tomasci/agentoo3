// Child half of system-ports-verify.test.ts. Runs under `bun test` (not plain
// `bun`) only so that mock.module is available for the one scenario that needs
// /proc/net to be unreadable.
//
// Why a child process at all: Bun.spawn resolves `ss` against the PATH the
// process was STARTED with — assigning process.env.PATH at runtime does not
// change what it finds (checked while writing this). So every "ss is missing /
// broken / slow" scenario needs its own process, launched by the parent with a
// PATH that points at an empty dir or at a fake `ss` script the parent wrote.
//
// Input (env): PORTS_VERIFY_PLAN — JSON `Plan`; PORTS_VERIFY_OUT — where to
// write the JSON `ChildResult`. The parent does every assertion.

import { test } from 'bun:test'
import './setup-env'
import * as realFs from 'node:fs/promises'
import { mock } from 'bun:test'

interface Plan {
  /** Make every /proc/net/* read fail with EACCES, so the /proc reader fails too. */
  breakProc?: boolean
  /** Open a TCP listener and an unconnected UDP socket on 127.0.0.1 before requesting. */
  listen?: boolean
  /** Batches run in order; the requests inside one batch are fired concurrently. */
  batches: string[][]
  /** When set, this file's contents are captured after every batch (the fake ss argv log). */
  logFile?: string
}

const realReaddir = realFs.readdir

/** Open fds and live child pids of this process — to show repeated calls leak neither. */
async function processFootprint(): Promise<{ fds: number; children: number[] }> {
  const fds = (await realReaddir('/proc/self/fd')).length
  const children: number[] = []
  for (const tid of await realReaddir('/proc/self/task')) {
    const text = await Bun.file(`/proc/self/task/${tid}/children`).text().catch(() => '')
    for (const pid of text.trim().split(/\s+/)) if (pid) children.push(Number(pid))
  }
  return { fds, children }
}

const plan = JSON.parse(process.env.PORTS_VERIFY_PLAN ?? '{"batches":[]}') as Plan
const outFile = process.env.PORTS_VERIFY_OUT ?? ''

if (plan.breakProc) {
  const realReadFile = realFs.readFile
  mock.module('node:fs/promises', () => ({
    ...realFs,
    readFile: async (path: unknown, ...rest: unknown[]) => {
      if (String(path).startsWith('/proc/net/')) {
        const error = new Error(`EACCES: permission denied, open '${String(path)}'`) as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest)
    },
  }))
}

const { createApp } = await import('../src/app')

test('run the plan', async () => {
  const app = createApp()
  let tcpPort: number | null = null
  let udpPort: number | null = null
  let listener: { stop(closeActive?: boolean): void } | null = null
  let udp: { close(): void } | null = null

  if (plan.listen) {
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    listener = l
    tcpPort = l.port
    const u = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0 })
    udp = u
    udpPort = u.port
  }

  const batches: Array<{
    responses: Array<{ path: string; status: number; body: unknown; ms: number }>
    log: string | null
  }> = []

  const footprintBefore = await processFootprint()
  for (const batch of plan.batches) {
    const responses = await Promise.all(
      batch.map(async (path) => {
        const started = performance.now()
        const res = await app.request(path)
        const text = await res.text()
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {}
        return { path, status: res.status, body, ms: Math.round(performance.now() - started) }
      }),
    )
    const log = plan.logFile ? await Bun.file(plan.logFile).text().catch(() => '') : null
    batches.push({ responses, log })
  }

  // Let a SIGKILLed child's exit and pipe teardown settle before counting.
  await Bun.sleep(400)
  const footprintAfter = await processFootprint()
  listener?.stop(true)
  udp?.close()
  await Bun.write(outFile, JSON.stringify({ pid: process.pid, tcpPort, udpPort, batches, footprintBefore, footprintAfter }))
}, 60_000)
