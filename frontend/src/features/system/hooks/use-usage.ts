import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { getApiSystemUsageQueryOptions } from '@/shared/api/generated/hooks/useGetApiSystemUsage'

/**
 * The Claude subscription's plan limits, who this box's Claude Code is
 * authenticated as, and what has been consuming that usage — see
 * backend/src/features/system/usage.ts for the full contract.
 *
 * The endpoint always answers 200 (a probe failure lands in the response's
 * own `probeError`, not an HTTP status), so `retry: false` costs nothing —
 * there is no transient failure here worth retrying, only a slow local CLI
 * probe the backend already timed out on its own.
 *
 * `refetchInterval: 60_000`: the backend caches its own Claude Code probe
 * for 60s (usage.ts), so polling any faster would only ever re-read that
 * same cached answer. `refetchOnWindowFocus: false`: a reader tabbing back
 * to this page should not have a number change out from under them between
 * one glance and the next — Refresh and the next scheduled poll are the
 * only ways this updates, the same contract `usePorts` picks for its own
 * (manual-only) reasons.
 */
export function useUsage() {
  return useQuery({
    ...getApiSystemUsageQueryOptions(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

const TICK_MS = 30_000

/**
 * Forces a re-render roughly every 30s so a relative label ("resets in 3h
 * 16m", "reported 4 min ago") keeps counting down between polls — nothing
 * about `useUsage`'s own data has to change for the wall clock to have
 * moved on, and without this the page would only ever update those labels
 * once a minute, on the next `refetchInterval` tick. Returns nothing:
 * callers call this for its side effect alone and read `Date.now()` fresh
 * wherever they need "now".
 */
export function useRelativeTimeTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), TICK_MS)
    return () => clearInterval(id)
  }, [])
}
