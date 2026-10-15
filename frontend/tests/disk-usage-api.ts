// A fake backend for the disk-usage tests, standing in at the *transport*
// rather than replacing generated client functions the way most tests here do
// (see mock-module.ts): the real generated clients and the real kubb runtime
// build the request, and only the last step — axios's adapter — is ours. That
// is what lets a test say "Recalculate sent POST
// /api/projects/<id>/disk-usage/refresh" and mean the URL the browser would
// actually hit, not just that some mocked function was called.
//
// `client.setConfig` is process-wide, like `mock.module`, so `installFakeDiskUsageApi()` hands
// back an undo and registers it as an `afterAll` for you.

import { afterAll } from 'bun:test'
import type { QueryClient } from '@tanstack/react-query'
import {
  AxiosError,
  type AxiosResponse,
  AxiosHeaders,
  type InternalAxiosRequestConfig,
} from 'axios'
import { client } from '../src/shared/api/generated/.kubb/client'
import { getProjectDiskUsageQueryKey } from '../src/shared/api/generated/hooks/useGetProjectDiskUsage'
import { getProjectsDiskUsageQueryKey } from '../src/shared/api/generated/hooks/useGetProjectsDiskUsage'
import type { ProjectDiskUsage } from '../src/shared/api/generated/types/ProjectDiskUsage'

export type { ProjectDiskUsage }

export const GB = 1024 ** 3
export const MB = 1024 ** 2

export const usage = (
  projectId: string,
  overrides: Partial<ProjectDiskUsage> = {},
): ProjectDiskUsage => ({
  projectId,
  totalBytes: null,
  repoBytes: null,
  worktreesBytes: null,
  measuredAt: null,
  measuring: false,
  error: null,
  ...overrides,
})

/** For the tests that mount the picker or a Settings page without being about
 *  sizes: a plain measured size for each project in the query cache, both in
 *  the list and under each project's own entry, the way the shell's other
 *  ambient queries are seeded, so nothing reaches for a backend. Needs a
 *  client with an infinite `staleTime`, like those tests already use. */
export function seedDiskUsage(queryClient: QueryClient, projectIds: readonly string[]) {
  const rows = projectIds.map((id) =>
    usage(id, {
      totalBytes: MB,
      repoBytes: MB,
      worktreesBytes: 0,
      measuredAt: '2026-09-28T14:32:00.000Z',
    }),
  )
  queryClient.setQueryData(getProjectsDiskUsageQueryKey(), rows)
  for (const row of rows) {
    queryClient.setQueryData(getProjectDiskUsageQueryKey({ path: { id: row.projectId } }), row)
  }
}

export type Call = { method: string; url: string }

/** What the fake server knows. Reset between tests with `reset()`. */
export const fake = {
  calls: [] as Call[],
  /** Each project's current usage. A project with no row answers 404. */
  rows: new Map<string, ProjectDiskUsage>(),
  /** What a refresh turns a row into: the backend's own answer is
   *  `measuring: true` with the previous numbers, which is the default. */
  refreshed: (row: ProjectDiskUsage): ProjectDiskUsage => ({ ...row, measuring: true }),
  /** Makes the list endpoint answer 500. */
  listFails: false,
  /** Makes the refresh endpoint answer this status, with an `{ error }` body. */
  refreshFails: null as number | null,
  /** Held until released: the list endpoint's answer does not arrive. */
  listGate: null as Promise<void> | null,
  /** The same for the refresh endpoint, to look at a click in flight. */
  refreshGate: null as Promise<void> | null,

  count(method: string, urlPattern: RegExp): number {
    return this.calls.filter((c) => c.method === method && urlPattern.test(c.url)).length
  },
  reset() {
    this.calls = []
    this.rows = new Map()
    this.refreshed = (row) => ({ ...row, measuring: true })
    this.listFails = false
    this.refreshFails = null
    this.listGate = null
    this.refreshGate = null
  },
}

export const LIST_URL = /^\/api\/projects\/disk-usage$/
export const SINGLE_URL = /^\/api\/projects\/[^/]+\/disk-usage$/
export const REFRESH_URL = /^\/api\/projects\/[^/]+\/disk-usage\/refresh$/

function answer(config: InternalAxiosRequestConfig, status: number, data: unknown) {
  const response: AxiosResponse = {
    data,
    status,
    statusText: '',
    headers: new AxiosHeaders(),
    config,
  }
  if (status >= 200 && status < 300) return response
  throw new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_RESPONSE,
    config,
    {},
    response,
  )
}

async function handle(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const method = (config.method ?? 'get').toUpperCase()
  const url = config.url ?? ''
  fake.calls.push({ method, url })

  const id = url.split('/')[3] ?? ''
  if (method === 'GET' && LIST_URL.test(url)) {
    if (fake.listGate) await fake.listGate
    if (fake.listFails) return answer(config, 500, { error: 'boom' })
    return answer(config, 200, [...fake.rows.values()])
  }
  if (method === 'GET' && SINGLE_URL.test(url)) {
    const row = fake.rows.get(id)
    return row ? answer(config, 200, row) : answer(config, 404, { error: 'Project not found' })
  }
  if (method === 'POST' && REFRESH_URL.test(url)) {
    if (fake.refreshGate) await fake.refreshGate
    if (fake.refreshFails) return answer(config, fake.refreshFails, { error: 'Refresh refused' })
    const row = fake.rows.get(id)
    if (!row) return answer(config, 404, { error: 'Project not found' })
    const next = fake.refreshed(row)
    fake.rows.set(id, next)
    return answer(config, 200, next)
  }
  // Anything else is not this file's business. A read fails, the way it does
  // for a shell query nobody seeded (and as it would against no server at
  // all) — answering `[]` instead would hand components shapes they never get
  // in production. A write (the project mutations) just succeeds; the tests
  // that touch them count calls and care about nothing in the body.
  return method === 'GET' ? answer(config, 404, { error: 'Not faked' }) : answer(config, 200, {})
}

export function installFakeDiskUsageApi(): () => void {
  client.setConfig({ options: { adapter: handle } })
  const undo = () => {
    client.setConfig({ options: undefined })
  }
  afterAll(undo)
  return undo
}
