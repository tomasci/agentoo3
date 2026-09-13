// The one seam every docker-touching function goes through.
//
// Every service function in this feature takes `cli: DockerCli =
// realDockerCli` as an optional *last* parameter; routes never pass it, and
// tests substitute a fake. That is what makes this feature testable end to
// end on a host with no docker daemon at all — this one, notably — without a
// single test that depends on a real container starting.

import { readBounded } from '@/lib/spawn'

export interface DockerResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

export interface DockerStreamLine {
  stream: 'stdout' | 'stderr'
  line: string
}

export interface DockerStream {
  lines: AsyncIterable<DockerStreamLine>
  close(): void
  exited: Promise<number>
}

export interface DockerCli {
  run(args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<DockerResult>
  stream(args: string[], options?: { cwd?: string }): DockerStream
}

/**
 * Every read this feature makes against the daemon shares this bound — a
 * project-scoped constant rather than an env setting, since there is nothing
 * an operator would legitimately want to tune here: `docker inspect` and
 * `docker compose config` are local, disk-and-socket calls with no network
 * round trip, so 10s is generous headroom, not a value anyone should need to
 * raise.
 */
export const DOCKER_READ_TIMEOUT_MS = 10_000

/**
 * The sentinel `run()` reports in `exitCode` when `docker` itself could not be
 * spawned — chosen to be unambiguous against every *real* exit code a process
 * can report (0-255) and against the `-1` this module already uses for "ran,
 * but we have no code" (a timeout kill). 127 is the shell's own convention for
 * "command not found", which is what a caller checking `cliInstalled` is
 * really asking.
 */
export const MISSING_BINARY_EXIT_CODE = -127

function noop() {}

export const realDockerCli: DockerCli = {
  async run(args, options = {}) {
    // A local, non-generic function rather than an inline call: it lets
    // `ReturnType<typeof spawn>` below capture the concrete type Bun resolved
    // for *this* literal `stdout`/`stderr` pair. Declaring `proc`'s type as
    // `ReturnType<typeof Bun.spawn>` directly instead — Bun.spawn is generic
    // — resolves to its *default* type parameters (stderr defaults to
    // "inherit", i.e. no stream at all), not the ones this call actually asks
    // for, and silently mistypes `proc.stderr` a few lines down.
    const spawn = () =>
      Bun.spawn(['docker', ...args], {
        cwd: options.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        // Bun only applies a timeout when one is given; every caller in this
        // feature passes one (DOCKER_READ_TIMEOUT_MS for reads,
        // DOCKER_OP_TIMEOUT_MS for the worker's mutations) so this fallback
        // never actually runs, but is the same "unbounded when omitted"
        // default lib/git.ts's `git()` uses.
        ...(options.timeoutMs !== undefined && {
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
        }),
      })

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn()
    } catch (error) {
      // A missing `docker` binary surfaces as a spawn failure (ENOENT), not a
      // non-zero exit — this is the one case `cliInstalled: false` reports,
      // and this exitCode is how every caller downstream tells it apart from
      // "docker ran, but the daemon said no" (an ordinary non-zero exit).
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, stdout: '', stderr: message, exitCode: MISSING_BINARY_EXIT_CODE }
    }

    const [stdout, stderr] = await Promise.all([
      readBounded(proc.stdout, proc.exited),
      readBounded(proc.stderr, proc.exited),
      // See lib/git.ts's identical line: guarantees proc.exitCode is populated
      // by the time it's read below, in the legal case both pipe reads reach
      // EOF before Bun's own wait() on the process resolves.
      proc.exited,
    ])

    const timedOut = proc.exitCode === null
    const stderrText = stderr.trim()
    const reason = timedOut
      ? stderrText || `docker ${args[0]} timed out after ${options.timeoutMs}ms`
      : stderrText

    return {
      ok: proc.exitCode === 0,
      stdout: stdout.trim(),
      stderr: reason,
      exitCode: proc.exitCode ?? -1,
    }
  },

  stream(args, options = {}) {
    // Same reasoning as `run()` above for the local `spawn` function.
    const spawn = () =>
      Bun.spawn(['docker', ...args], { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })

    let proc: ReturnType<typeof spawn> | undefined
    let spawnError: string | undefined
    try {
      proc = spawn()
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error)
    }

    if (!proc) {
      return {
        lines: (async function* () {
          yield { stream: 'stderr' as const, line: spawnError ?? 'docker: command not found' }
        })(),
        close: noop,
        exited: Promise.resolve(MISSING_BINARY_EXIT_CODE),
      }
    }

    const p = proc
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      p.kill('SIGTERM')
      // A follow that ignores SIGTERM (unlikely for `docker logs`/`docker
      // compose up`, but this is the same backstop lib/git.ts's timeout path
      // relies on) still has to actually stop when the client goes away.
      setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {
          // Already reaped.
        }
      }, 2000)
    }

    return {
      lines: mergeLines(p.stdout, p.stderr),
      close,
      exited: p.exited.then((code) => code ?? -1),
    }
  },
}

/**
 * Merge two live pipes into one ordered-by-arrival stream of lines.
 *
 * Read separately rather than concatenated: without a TTY, `docker` (like
 * `git`) writes a container's own stdout to its stdout and stderr to its
 * stderr, so reading the two pipes apart classifies each line for free — the
 * whole reason DockerStreamLine carries `stream` at all. A `tty: true`
 * service merges everything onto stdout upstream of us; there is nothing left
 * to tell apart in that case, and this reports exactly what it read.
 *
 * A `--follow` stream never reaches EOF on either pipe until the process
 * itself does, so pulling one pipe to completion before starting the other
 * would starve whichever one goes second for the entire run. This pumps both
 * concurrently into one queue instead, waking the consumer only when there is
 * something to hand it.
 */
function mergeLines(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
): AsyncIterable<DockerStreamLine> {
  const queue: DockerStreamLine[] = []
  let wake: (() => void) | null = null
  let pipesOpen = 2

  const push = (line: DockerStreamLine) => {
    queue.push(line)
    wake?.()
    wake = null
  }
  const pipeClosed = () => {
    pipesOpen -= 1
    wake?.()
    wake = null
  }

  async function pump(stream: ReadableStream<Uint8Array>, which: 'stdout' | 'stderr') {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx = buf.indexOf('\n')
        while (idx !== -1) {
          push({ stream: which, line: buf.slice(0, idx) })
          buf = buf.slice(idx + 1)
          idx = buf.indexOf('\n')
        }
      }
      if (buf) push({ stream: which, line: buf })
    } finally {
      reader.cancel().catch(noop)
      pipeClosed()
    }
  }

  void pump(stdout, 'stdout')
  void pump(stderr, 'stderr')

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (pipesOpen <= 0) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}
