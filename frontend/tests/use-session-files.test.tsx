// `useAttachmentUploads`: the hook that starts an upload the moment a file is
// attached, tracks its own progress, and can cancel it mid-flight — none of
// which the generated mutation hook can do on its own (see the hook's own
// comment). The generated *client* function is mocked below so a test can
// resolve, reject or abort one upload at a time and inspect exactly what the
// hook does at each step, the same technique tests/session-page-scroll.test.tsx
// and tests/use-session-stream-hook.test.tsx use for their own generated
// clients.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mockModule } from './mock-module'
import type { SessionFile } from '../src/features/sessions/hooks/use-session-files'
import { useAttachmentUploads } from '../src/features/sessions/hooks/use-session-files'

interface ProgressEvent {
  loaded: number
  total?: number
}

interface Call {
  file: File
  onUploadProgress?: (e: ProgressEvent) => void
  resolve: (data: SessionFile) => void
  reject: (err: unknown) => void
}

let calls: Call[] = []

const CLIENT_SPEC = '@/shared/api/generated/clients/postApiSessionsIdFiles'

// Through tests/mock-module.ts rather than `mock.module` directly, so this
// fake is taken back when the file is done rather than answering for every
// file `bun test` loads afterwards.
await mockModule(CLIENT_SPEC, () => ({
  postApiSessionsIdFiles: (opts: {
    body: { file: File }
    signal?: AbortSignal
    options?: { onUploadProgress?: (e: ProgressEvent) => void }
  }) =>
    new Promise((resolve, reject) => {
      calls.push({
        file: opts.body.file,
        onUploadProgress: opts.options?.onUploadProgress,
        resolve: (data) => resolve({ data }),
        reject,
      })
      // A real AbortController fires this synchronously on `.abort()`, and by
      // then `signal.aborted` is already `true` — which is the only thing the
      // hook's own `catch` reads to tell "cancelled" apart from "the server
      // said no".
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}))

const fileDto = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  id: 'server-file-1',
  sessionId: 's1',
  originalFilename: 'a.txt',
  mimeType: 'text/plain',
  sizeBytes: 5,
  checksum: 'abc',
  status: 'ready',
  lineCount: 1,
  pageCount: null,
  createdAt: '2026-09-04T10:00:00.000Z',
  ...overrides,
})

let client: QueryClient
let container: HTMLDivElement
let root: Root
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let api: ReturnType<typeof useAttachmentUploads>

function Probe({ sessionId }: { sessionId: string }) {
  api = useAttachmentUploads(sessionId)
  return null
}

async function mount(sessionId = 's1') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe sessionId={sessionId} />
      </QueryClientProvider>,
    )
  })
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** Drains whatever microtask chain a resolve/reject/abort just queued up —
 *  same idiom as tests/use-session-stream-hook.test.tsx's `frames()`, a real
 *  timer tick rather than a bare `await Promise.resolve()`, which is not
 *  guaranteed to outlast a `.then().catch().finally()` chain. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const file = (name = 'a.txt', body = 'hello', type = 'text/plain') => new File([body], name, { type })

beforeEach(() => {
  calls = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(async () => {
  await unmount()
  client.clear()
})

test('attach starts the upload immediately, as an "uploading" chip', async () => {
  await mount()
  await act(async () => {
    api.attach([file()])
  })

  expect(calls).toHaveLength(1)
  expect(api.uploads).toHaveLength(1)
  expect(api.uploads[0]?.status).toBe('uploading')
  expect(api.uploads[0]?.progress).toBe(0)
  expect(api.pendingCount).toBe(1)
})

test('onUploadProgress updates that chip, and only that chip', async () => {
  await mount()
  await act(async () => {
    api.attach([file('a.txt'), file('b.txt')])
  })
  expect(calls).toHaveLength(2)

  await act(async () => {
    calls[0]?.onUploadProgress?.({ loaded: 5, total: 10 })
  })

  expect(api.uploads.find((u) => u.file.name === 'a.txt')?.progress).toBe(50)
  expect(api.uploads.find((u) => u.file.name === 'b.txt')?.progress).toBe(0)
})

test('a successful upload flips the chip to "done" and clears pendingCount', async () => {
  await mount()
  await act(async () => {
    api.attach([file()])
  })
  calls[0]?.resolve(fileDto())
  await flush()

  expect(api.uploads[0]?.status).toBe('done')
  expect(api.uploads[0]?.progress).toBe(100)
  expect(api.uploads[0]?.serverFile?.id).toBe('server-file-1')
  expect(api.pendingCount).toBe(0)
})

test('a server rejection surfaces as an error chip, not a thrown exception', async () => {
  await mount()
  await act(async () => {
    api.attach([file()])
  })
  const error = new Error('413 too large')
  calls[0]?.reject(error)
  await flush()

  expect(api.uploads[0]?.status).toBe('error')
  expect(api.uploads[0]?.error).toBe(error)
  expect(api.uploads[0]?.precheckFailed).toBeUndefined()
})

test('cancel aborts the in-flight request and drops the chip entirely', async () => {
  await mount()
  await act(async () => {
    api.attach([file()])
  })
  expect(api.uploads).toHaveLength(1)

  await act(async () => {
    api.cancel(api.uploads[0]?.id ?? '')
  })
  await flush()

  // Dropped, not shown as an error — a cancellation is not a failure.
  expect(api.uploads).toHaveLength(0)
})

test('a file that would obviously bust the session quota never reaches the network', async () => {
  await mount()
  const budget = { fileCount: 1, sizeBytes: 990, maxFiles: 10, maxSessionBytes: 1000 }
  await act(async () => {
    api.attach([file('big.txt', 'x'.repeat(20))], budget)
  })

  expect(calls).toHaveLength(0)
  expect(api.uploads).toHaveLength(1)
  expect(api.uploads[0]?.status).toBe('error')
  expect(api.uploads[0]?.precheckFailed).toBe(true)
})

test('clearSent drops only the named done uploads, leaving the rest of the tray alone', async () => {
  await mount()
  await act(async () => {
    api.attach([file('a.txt'), file('b.txt')])
  })
  calls[0]?.resolve(fileDto({ id: 'file-a' }))
  calls[1]?.resolve(fileDto({ id: 'file-b' }))
  await flush()
  expect(api.uploads).toHaveLength(2)

  await act(async () => {
    api.clearSent(['file-a'])
  })

  expect(api.uploads).toHaveLength(1)
  expect(api.uploads[0]?.serverFile?.id).toBe('file-b')
})

test('dismiss removes an error chip without touching anything else', async () => {
  await mount()
  await act(async () => {
    api.attach([file()])
  })
  calls[0]?.reject(new Error('nope'))
  await flush()
  const id = api.uploads[0]?.id
  expect(id).toBeDefined()

  await act(async () => {
    if (id) api.dismiss(id)
  })

  expect(api.uploads).toHaveLength(0)
})

