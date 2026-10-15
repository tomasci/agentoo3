// The projects table's "Size" column (project-size-cell.tsx, rendered by
// projects-table.tsx, which the new-tab picker shows): where the column sits,
// and what its cell says for each state the sizes list can be in — a known
// figure, one still being re-measured, one never measured yet, a failed
// measurement, a project still being set up, a list that is loading or has
// failed to load — plus that the list is asked again when a project changes
// state, so a just-cloned project does not keep what was said while it was
// cloning.
//
// The table is rendered directly with the projects handed in, and the real
// generated clients talk to the fake backend in ./disk-usage-api.ts, so what
// is asserted is the full path from an answer on the wire to the text in a
// cell. Wording is checked through a private English i18next instance, the way
// tests/git-identity-card.test.tsx does, because the wording is part of the
// point. Assertions are by text, attribute and role, never a class name.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { ProjectsTable } from '../src/features/projects/components/projects-table'
import en from '../src/shared/i18n/locales/en.json'
import { fake, GB, installFakeDiskUsageApi, LIST_URL, usage } from './disk-usage-api'

installFakeDiskUsageApi()

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

const project = (id: string, name: string, status = 'ready') => ({
  id,
  name,
  slug: name.toLowerCase(),
  source: 'clone' as const,
  remoteUrl: `https://example.com/acme/${name.toLowerCase()}.git`,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: status as 'ready',
  lastError: null,
  recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`,
  createdAt: '',
  updatedAt: '',
})

let container: HTMLDivElement
let root: Root | null = null
let client: QueryClient

const settle = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

const tree = (projects: ReturnType<typeof project>[]) => (
  <I18nextProvider i18n={english}>
    <QueryClientProvider client={client}>
      <ProjectsTable projects={projects} onOpen={() => {}} />
    </QueryClientProvider>
  </I18nextProvider>
)

async function mount(projects: ReturnType<typeof project>[]) {
  container = document.createElement('div')
  document.body.append(container)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  root = createRoot(container)
  await act(async () => {
    root?.render(tree(projects))
  })
  await settle()
}

async function rerender(projects: ReturnType<typeof project>[]) {
  await act(async () => {
    root?.render(tree(projects))
  })
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake.reset()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

const headers = () => [...container.querySelectorAll('thead th')].map((th) => text(th))

/** The Size cell of the row naming `name`. */
const sizeCell = (name: string): HTMLElement => {
  const column = headers().indexOf('Size')
  const row = [...container.querySelectorAll('tbody tr')].find((tr) => text(tr).includes(name))
  const cell = row?.querySelectorAll('td')[column]
  if (column < 0 || !cell) throw new Error(`no Size cell for "${name}"`)
  return cell as HTMLElement
}
const spinners = (cell: Element) =>
  [...cell.querySelectorAll('[role="status"]')].filter(
    (el) => el.getAttribute('aria-label') === 'Measuring…',
  )

test('the Size column sits after Docker and before Path', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB }))
  await mount([project('p1', 'Alpha')])

  expect(headers()).toEqual(['Name', 'Status', 'Docker', 'Size', 'Path', ''])
})

test('a known size is shown in the shortest readable unit, with nothing spinning', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: 2.1 * GB, repoBytes: GB, worktreesBytes: GB }))
  await mount([project('p1', 'Alpha')])

  expect(text(sizeCell('Alpha'))).toBe('2.1 GB')
  expect(spinners(sizeCell('Alpha'))).toHaveLength(0)
})

test('a known size that is being re-measured stays on screen, with a spinner beside it', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: 2.1 * GB, measuring: true }))
  await mount([project('p1', 'Alpha')])

  expect(text(sizeCell('Alpha'))).toBe('2.1 GB')
  expect(spinners(sizeCell('Alpha'))).toHaveLength(1)
})

test('no number yet and measuring shows only a spinner labelled "Measuring…"', async () => {
  fake.rows.set('p1', usage('p1', { measuring: true }))
  await mount([project('p1', 'Alpha')])

  expect(text(sizeCell('Alpha'))).toBe('')
  expect(spinners(sizeCell('Alpha'))).toHaveLength(1)
})

test('no number, not measuring, with an error shows a dash and the error on hover and to screen readers', async () => {
  fake.rows.set('p1', usage('p1', { error: 'Could not read the folder size: Permission denied' }))
  await mount([project('p1', 'Alpha')])

  const cell = sizeCell('Alpha')
  expect(text(cell)).toBe('—')
  const dash = cell.querySelector('[title]')
  expect(dash?.getAttribute('title')).toBe('Could not read the folder size: Permission denied')
  expect(dash?.getAttribute('aria-label')).toBe('Could not read the folder size: Permission denied')
  expect(spinners(cell)).toHaveLength(0)
})

test('a project still being set up shows a dash, whatever the backend says about it', async () => {
  // What the backend reports for a folder that is not there yet: an error
  // for one, a measurement in progress for the other. Neither is news.
  fake.rows.set('p1', usage('p1', { error: 'Project folder not found' }))
  fake.rows.set('p2', usage('p2', { measuring: true }))
  await mount([project('p1', 'Alpha', 'pending'), project('p2', 'Beta', 'cloning')])

  for (const name of ['Alpha', 'Beta']) {
    const cell = sizeCell(name)
    expect(text(cell)).toBe('—')
    expect(cell.querySelector('[title]')).toBeNull()
    expect(spinners(cell)).toHaveLength(0)
  }
})

test('a failed or needs_manual project is not being set up: its measured size is shown, not a dash', async () => {
  // A clone that failed still leaves a folder (plugin/, an empty repo/), and
  // the backend measures it: 28672 bytes is what the live API answered for a
  // project whose clone of an unreachable remote had failed. Only pending and
  // cloning are "still being set up"; these two settle on a figure like any
  // ready project, with nothing left spinning.
  fake.rows.set('p1', usage('p1', { totalBytes: 28672, repoBytes: 4096, worktreesBytes: 0 }))
  fake.rows.set('p2', usage('p2', { totalBytes: 28672, repoBytes: 4096, worktreesBytes: 0 }))
  await mount([project('p1', 'Alpha', 'failed'), project('p2', 'Beta', 'needs_manual')])

  for (const name of ['Alpha', 'Beta']) {
    expect(text(sizeCell(name))).toBe('28 KB')
    expect(spinners(sizeCell(name))).toHaveLength(0)
  }
})

test('while the list is still loading every row shows the spinner, and the figures replace it when it answers', async () => {
  let release: () => void = () => {}
  fake.listGate = new Promise<void>((resolve) => {
    release = resolve
  })
  fake.rows.set('p1', usage('p1', { totalBytes: 512 * 1024 ** 2 }))
  await mount([project('p1', 'Alpha')])

  expect(spinners(sizeCell('Alpha'))).toHaveLength(1)
  expect(text(sizeCell('Alpha'))).toBe('')

  release()
  await settle()

  expect(text(sizeCell('Alpha'))).toBe('512 MB')
  expect(spinners(sizeCell('Alpha'))).toHaveLength(0)
})

test('a list that fails to load ends in a dash with a reason, not a spinner that never stops', async () => {
  fake.listFails = true
  await mount([project('p1', 'Alpha')])

  const cell = sizeCell('Alpha')
  expect(text(cell)).toBe('—')
  expect(cell.querySelector('[title]')?.getAttribute('title')).toBe('Could not load the size')
  expect(spinners(cell)).toHaveLength(0)
})

test('a project the list has no entry for yet shows the spinner', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB }))
  await mount([project('p1', 'Alpha'), project('p2', 'Beta')])

  expect(text(sizeCell('Alpha'))).toBe('1.0 GB')
  expect(spinners(sizeCell('Beta'))).toHaveLength(1)
})

test('one list request covers every project, not one per row', async () => {
  for (const id of ['p1', 'p2', 'p3']) fake.rows.set(id, usage(id, { totalBytes: GB }))
  await mount([project('p1', 'Alpha'), project('p2', 'Beta'), project('p3', 'Gamma')])

  expect(fake.count('GET', LIST_URL)).toBe(1)
  expect(fake.calls.filter((c) => /\/api\/projects\/[^/]+\/disk-usage/.test(c.url))).toHaveLength(0)
})

test('the list is asked again when a project changes state, and not when the same projects are handed in afresh', async () => {
  fake.rows.set('p1', usage('p1', { error: 'Project folder not found' }))
  await mount([project('p1', 'Alpha', 'cloning')])
  expect(fake.count('GET', LIST_URL)).toBe(1)
  expect(text(sizeCell('Alpha'))).toBe('—')

  // The project list polls while anything is cloning, so the table gets a new
  // array of identical projects every 1.5 s: that must not refetch anything.
  await rerender([project('p1', 'Alpha', 'cloning')])
  expect(fake.count('GET', LIST_URL)).toBe(1)

  // Cloning finished. The size is taken from what the backend now says.
  fake.rows.set('p1', usage('p1', { totalBytes: 40 * 1024 ** 2 }))
  await rerender([project('p1', 'Alpha', 'ready')])

  expect(fake.count('GET', LIST_URL)).toBe(2)
  expect(text(sizeCell('Alpha'))).toBe('40 MB')
})

test('a project appearing in the list asks again too', async () => {
  fake.rows.set('p1', usage('p1', { totalBytes: GB }))
  await mount([project('p1', 'Alpha')])
  expect(fake.count('GET', LIST_URL)).toBe(1)

  fake.rows.set('p2', usage('p2', { totalBytes: 3 * GB }))
  await rerender([project('p1', 'Alpha'), project('p2', 'Beta')])

  expect(fake.count('GET', LIST_URL)).toBe(2)
  expect(text(sizeCell('Beta'))).toBe('3.0 GB')
})
