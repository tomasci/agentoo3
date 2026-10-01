// Live enforcement of the admin-configurable max-concurrent-sessions setting
// (features/system/settings.ts) against the already-running session-run
// worker and queue. Dependency direction is deliberately queue -> settings,
// never the other way: the API process reads and writes the setting but
// never touches Redis for it — only this module, on the worker side, does.

import type { Queue, Worker } from 'bullmq'
import { getMaxConcurrentSessions } from '@/features/system/settings'
import { logger } from '@/lib/logger'

/** How often the worker re-reads the setting and re-applies it. Short enough
 * that an admin's save on the Settings page is felt in seconds, not after a
 * restart; long enough that this is a background poll, not a hot loop. */
export const SESSION_CONCURRENCY_REFRESH_MS = 5_000

/**
 * The real cap is BullMQ's queue-wide global concurrency
 * (`queue.setGlobalConcurrency`), not `worker.concurrency`. The former writes
 * `concurrency` into this queue's own Redis meta hash and every fetch path
 * checks it there, atomically, in Lua — so it is what actually bounds how
 * many turns run at once, correctly, even with more than one worker process
 * pointed at the same queue. `worker.concurrency` is a different, purely
 * local number: how many fetch/process slots *this one worker's* main loop
 * may have outstanding at a time, checked nowhere else.
 *
 * The local number is deliberately `limit + 1`, not `limit`. BullMQ's main
 * loop (`Worker.mainLoop`) only attempts a new fetch while
 * `asyncFifoQueue.numTotal() < this._concurrency`. With the local number
 * equal to the global cap, a fully busy worker already has `numTotal() ==
 * concurrency` from its running jobs alone, so the loop stops fetching
 * entirely and the only thing left to await is one of those jobs finishing.
 * Raising the global cap later (2 -> 3, say, while 2 turns are already
 * running) would then sit inert until something else freed a slot, because
 * nothing ever attempts the third fetch to notice the new cap had changed.
 * The spare local slot fixes this for free: the loop always has one more
 * fetch in flight than the global cap currently allows, and that fetch is
 * refused by the identical Lua check the instant it would exceed the cap —
 * so the spare slot can never itself run a turn, it only ever lets the loop
 * notice a cap that just went up. Easy to read as redundant and delete —
 * without it, an admin raising the Settings-page value while the worker is
 * already saturated would silently do nothing until a running turn finished
 * on its own, which looks indistinguishable from the save not having worked.
 *
 * Order matters, in both directions: `worker.concurrency` is set first, and
 * `queue.setGlobalConcurrency` second. Reversing that would, for the
 * duration of the gap between the two awaits, leave the *old* local number
 * (== the *old* cap, with no spare slot of its own) satisfying the *new*
 * global cap exactly — zero spare slots, the exact state the paragraph above
 * exists to avoid — rather than the local number already being ahead of
 * whatever global says, old or new.
 */
export async function applySessionConcurrency(
  worker: Pick<Worker, 'concurrency'>,
  queue: Pick<Queue, 'setGlobalConcurrency'>,
  limit: number,
): Promise<void> {
  const target = limit + 1
  // Logged exactly when this changes anything, which covers "the first
  // apply" for free: startSessionRunWorker constructs the worker with
  // env.WORKER_CONCURRENCY, never `target` (always some limit + 1), so the
  // very first tick is guaranteed to log a change with no separate
  // "is this the first tick" flag to track.
  if (worker.concurrency !== target) {
    logger.info(`Session concurrency now ${limit} (worker slots: ${target})`)
    worker.concurrency = target
  }
  // Re-asserted every tick, even when `limit` has not changed since the last
  // one: this value lives in Redis, not in this process, so anything that
  // could have cleared or overwritten it there (a flushed or restarted
  // Redis, another process sharing this queue) self-heals on the next tick
  // instead of staying wrong until the setting itself changes again.
  await queue.setGlobalConcurrency(limit)
}

/**
 * One poll: read the effective setting and apply it. Returns the limit that
 * was applied, or undefined if the database read itself failed.
 *
 * A failed read deliberately does nothing further — not even a log beyond
 * the warning below — so `worker.concurrency` and the queue's global
 * concurrency are simply left at whatever the last successful tick set them
 * to. There is no separate "last applied" variable to fall back to: that
 * state already lives in `worker.concurrency` itself (and in Redis, for the
 * queue), which is exactly what "keep the last applied value" means here —
 * never the env default, which would silently override an admin's saved
 * value every time the database hiccups.
 */
export async function syncSessionConcurrency(
  worker: Pick<Worker, 'concurrency'>,
  queue: Pick<Queue, 'setGlobalConcurrency'>,
): Promise<number | undefined> {
  let limit: number
  try {
    limit = await getMaxConcurrentSessions()
  } catch (error) {
    logger.warn(
      `Could not read max_concurrent_sessions (${String(error)}) — leaving concurrency as it is`,
    )
    return undefined
  }
  await applySessionConcurrency(worker, queue, limit)
  return limit
}

/**
 * The shared poll loop both `watchSessionConcurrency` and
 * `startUnderSessionConcurrency` below are built from: tick now, then every
 * SESSION_CONCURRENCY_REFRESH_MS, returning a function that stops it.
 * `.unref()`'d so this timer alone never keeps the process alive.
 *
 * Guarded so at most one tick is ever in flight: a tick can hang rather than
 * reject — Redis being down is a stall on the `setGlobalConcurrency` call,
 * not an immediate error — and without this, a hung tick would pile up a new
 * overlapping attempt every REFRESH_MS on top of it, exactly the inFlight
 * dedup features/system/models.ts already uses for its own periodic probe.
 *
 * `onApplied` is the one difference between the two callers: it fires with
 * the limit a tick actually applied, and only for a tick that applied one
 * (never for a failed read). `startUnderSessionConcurrency` uses it to learn
 * about the very first successful apply without running a second,
 * independent tick loop of its own alongside this one — which is what would
 * reintroduce the overlap the inFlight guard above exists to prevent, one
 * layer up.
 */
function pollSessionConcurrency(
  worker: Pick<Worker, 'concurrency'>,
  queue: Pick<Queue, 'setGlobalConcurrency'>,
  onApplied?: (limit: number) => void,
): () => void {
  let inFlight = false

  const tick = () => {
    if (inFlight) return
    inFlight = true
    syncSessionConcurrency(worker, queue)
      .then((limit) => {
        if (limit !== undefined) onApplied?.(limit)
      })
      .catch((error) => {
        // syncSessionConcurrency already logs a failed *database* read
        // itself; this only catches what it does not — applySessionConcurrency
        // rejecting outright (as opposed to hanging) — so that case is never
        // an unhandled rejection on a timer nobody awaits.
        logger.warn(`Session concurrency tick failed: ${String(error)}`)
      })
      .finally(() => {
        inFlight = false
      })
  }

  tick()
  const interval = setInterval(tick, SESSION_CONCURRENCY_REFRESH_MS)
  interval.unref()
  return () => clearInterval(interval)
}

/**
 * Starts polling `syncSessionConcurrency` immediately and then every
 * SESSION_CONCURRENCY_REFRESH_MS, returning a function that stops it. Plain
 * polling only — no opinion about whether a BullMQ `Worker` is fetching yet,
 * which is exactly what makes this safe for a worker that is already running
 * (an admin's save reaching it without a restart) as well as for tests that
 * want the apply loop alone. See `startUnderSessionConcurrency` below for the
 * boot-time ordering a freshly constructed, not-yet-started worker needs
 * instead.
 */
export function watchSessionConcurrency(
  worker: Pick<Worker, 'concurrency'>,
  queue: Pick<Queue, 'setGlobalConcurrency'>,
): () => void {
  return pollSessionConcurrency(worker, queue)
}

/**
 * Keeps a `Worker` constructed with `autorun: false` from fetching any job
 * until the saved cap has actually reached Redis, then keeps watching for
 * changes exactly as `watchSessionConcurrency` does. Returns a function that
 * stops the watch (the worker, once started, is stopped the normal BullMQ
 * way — `worker.close()` — not through this).
 *
 * This exists because `startSessionRunWorker` used to construct its `Worker`
 * with the default `autorun: true` and only *then* start the watcher —
 * meaning BullMQ began fetching jobs at the construction-time
 * `env.WORKER_CONCURRENCY` before the watcher's first tick (an async
 * Postgres read, then a Redis write) had any chance to land. A turn already
 * queued at boot could be, and in measurement regularly was, claimed under
 * that stale construction-time number rather than a lower saved cap — 14 of
 * 20 fresh-Redis restarts over-admitted, and every single restart did when
 * the first DB read was slow. A lower cap saved while the worker was down
 * made this worse, not better: the API process never writes Redis (see this
 * module's own header), so a Redis instance that survived the restart kept
 * serving whatever higher cap was last applied until the watcher's first
 * tick overwrote it — there was no path at all by which the new, lower
 * number could already be there at boot.
 *
 * So the ordering is inverted here: the worker is never run at all until the
 * first apply actually succeeds, which is the only moment either of the two
 * targets below — `worker.concurrency` and the BullMQ-managed Redis value —
 * is known to hold the real saved cap rather than a number this process made
 * up. A failed first read (the database unreachable at boot) deliberately
 * does not fall back to running at env's default: a turn cannot run at all
 * without the database anyway — `runTurn`'s very first step is a claim
 * that is itself a database write — so starting the worker on a guess no
 * more "available" than the real value would buy nothing and could only ever
 * be wrong. Instead this keeps retrying on the normal tick interval,
 * unstarted, until a read succeeds.
 *
 * Reuses `pollSessionConcurrency`'s own tick loop (and its inFlight guard)
 * via `onApplied` rather than running a second, separate loop beside it:
 * a boot-time call to `syncSessionConcurrency` sitting next to the watcher's
 * own immediate tick would be two overlapping reads of the same setting,
 * which is exactly the kind of race this function exists to remove, one
 * level up.
 *
 * `run()` is called at most once, from the first tick whose apply succeeds —
 * calling it twice throws (`Worker.run`'s own "Worker is already running."),
 * and nothing here needs to call it again once the worker is fetching.
 * Checked against `worker.closing` immediately before that call: a worker
 * closed (or mid-close) before its first successful apply must never be
 * started — BullMQ's own `run()` would silently no-op for that case rather
 * than throw, but asking it to start at all here would be backwards, since
 * `startSessionRunWorker` only reaches `close()` through a graceful shutdown
 * this watch should be honouring, not racing. `run()`'s returned promise
 * resolves only once the worker stops (see BullMQ's own `Worker.run`), so it
 * is deliberately not awaited here — awaiting it would block this tick, and
 * every tick after it, for as long as the worker keeps running — and the
 * `.catch` below exists only so a `run()` that rejects synchronously (`No
 * process function is defined.`, the other throw `run()` can produce) is
 * logged instead of becoming an unhandled rejection on a call nothing else
 * awaits.
 */
export function startUnderSessionConcurrency(
  worker: Pick<Worker, 'concurrency' | 'run' | 'closing'>,
  queue: Pick<Queue, 'setGlobalConcurrency'>,
): () => void {
  let started = false

  return pollSessionConcurrency(worker, queue, () => {
    if (started) return
    started = true
    if (worker.closing) return
    worker.run().catch((error) => {
      logger.error(`Session-run worker could not start: ${String(error)}`)
    })
  })
}
