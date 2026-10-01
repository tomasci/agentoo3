// A throwaway real redis-server, for the one test file that needs real BullMQ
// semantics rather than fake-redis.ts's pub/sub subset.
//
// BullMQ's global concurrency is enforced inside Lua scripts that run in
// Redis itself (isQueueMaxed.lua and friends), so nothing short of a real
// server can say whether a cap holds. This spawns one on a kernel-assigned
// port, with persistence off (`--save '' --appendonly no`) and its working
// directory in /tmp, and throws the whole directory away afterwards — the
// same shape as pg-cluster.ts. It never touches the deployment's own Redis.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, listen } from 'bun'

/** The redis-server binary on PATH, or undefined if there is none. */
export function redisServerBin(): string | undefined {
  return Bun.which('redis-server') ?? undefined
}

/** A port the kernel just handed out, released again immediately. */
function freePort(): number {
  const probe = listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/** One PING over a raw socket; true on +PONG. */
async function ping(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write('PING\r\n')
        },
        data(socket, data) {
          done(Buffer.from(data).toString().startsWith('+PONG'))
          socket.end()
        },
        error() {
          done(false)
        },
        close() {
          done(false)
        },
        connectError() {
          done(false)
        },
      },
    }).catch(() => done(false))
    setTimeout(() => done(false), 500)
  })
}

export interface RedisServer {
  url: string
  host: string
  port: number
  stop: () => Promise<void>
}

/**
 * Start a server and wait until it answers PING. Retries on a fresh port if
 * the first one was taken in the gap between probing and binding — the same
 * window setup-env.ts describes.
 */
export async function startTempRedis(): Promise<RedisServer> {
  const bin = redisServerBin()
  if (!bin) throw new Error('No redis-server binary found')
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-redis-'))

  let lastError = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = freePort()
    const proc = Bun.spawn(
      [
        bin,
        '--port',
        String(port),
        '--bind',
        '127.0.0.1',
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        dir,
        '--protected-mode',
        'no',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const deadline = Date.now() + 10_000
    let up = false
    while (Date.now() < deadline && proc.exitCode === null) {
      if (await ping(port)) {
        up = true
        break
      }
      await Bun.sleep(50)
    }
    if (up) {
      const stop = async () => {
        proc.kill('SIGTERM')
        const killer = setTimeout(() => proc.kill('SIGKILL'), 3000)
        await proc.exited
        clearTimeout(killer)
        await rm(dir, { recursive: true, force: true })
      }
      return { url: `redis://127.0.0.1:${port}`, host: '127.0.0.1', port, stop }
    }
    proc.kill('SIGKILL')
    await proc.exited
    lastError = (await new Response(proc.stdout).text()).slice(-1000)
  }
  await rm(dir, { recursive: true, force: true })
  throw new Error(`redis-server did not come up: ${lastError}`)
}
