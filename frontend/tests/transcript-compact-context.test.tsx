// The card a compacted session opens with (`CompactContextCard` in
// components/transcript.tsx), from a `compact_context` message to the DOM:
//
//   - a heading, a link back to the source session (its title, or a name made
//     of its id, or plain text when there is no id or no project to link in),
//     the summary as rendered markdown, a copy button for the raw summary, and
//     the note that the agent got this once and not with every message;
//   - a summary past SUMMARY_CLAMP is folded behind Show more / Show less
//     (aria-expanded), a short one has no such button;
//   - a malformed payload renders an honest empty card and leaves the rest of
//     the transcript alone.
//
// The `<Link>` needs a router around it, so the transcript is mounted inside a
// root-only memory router, the way tests/session-page-header.test.tsx mounts
// the page for its own links. `@/shared/i18n` is imported and pinned to English
// for the reason tests/transcript-model-render.test.tsx spells out: the real
// strings are what a reader sees. Assertions compare primitives, never DOM
// nodes: bun pretty-printing a happy-dom element on failure takes minutes.

import { afterEach, expect, test } from 'bun:test'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { i18n } from '@/shared/i18n'
import { Transcript } from '../src/features/sessions/components/transcript'

await i18n.changeLanguage('en')

type M = Parameters<typeof Transcript>[0]['messages'][number]

let n = 0
const msg = (o: Partial<M> & { type: string }): M =>
  ({
    id: `m${n}`,
    sessionId: 's',
    seq: n++,
    parentToolUseId: null,
    title: null,
    pending: false,
    payload: {},
    createdAt: '2026-10-18T09:00:00.000Z',
    ...o,
  }) as M

const PAYLOAD = {
  summary: '## Goal\n\nShip the **compactor**.',
  sourceSessionId: 'src-1',
  sourceTitle: 'Old work',
  sourceTotalCostUsd: 1234.5,
  sourceBranch: 'agentoo/s-old',
  method: 'sdk_compact',
}

const context = (payload: unknown) => msg({ type: 'compact_context', payload })
const prompt = (text: string) => msg({ type: 'prompt', payload: { text } })

let root: Root | undefined
let container: HTMLDivElement | undefined

async function render(messages: M[], projectId: string | undefined = 'p1') {
  n = 0
  container = document.createElement('div')
  document.body.append(container)
  const rootRoute = createRootRoute({
    component: () => <Transcript messages={messages} sessionId="s" projectId={projectId} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  root = createRoot(container)
  await act(async () => {
    root?.render(<RouterProvider router={router} />)
  })
  return container
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  container = undefined
  document.body.replaceChildren()
})

const card = (el: Element) => {
  const heading = [...el.querySelectorAll('h2')].find(
    (h) => h.textContent === 'Compacted context from previous session',
  )
  const found = heading?.parentElement?.parentElement
  if (!found) throw new Error('no compacted-context card')
  return found as HTMLElement
}
const toggle = (el: Element) =>
  [...el.querySelectorAll('button')].find((b) =>
    ['Show more', 'Show less'].includes(b.textContent?.trim() ?? ''),
  )

const NOTE =
  'The agent was given this context once, at the start of this session. It is not sent again with each message.'

test('the card has the heading, the source link, the markdown summary, a copy button and the note', async () => {
  const el = await render([context(PAYLOAD)])
  const c = card(el)
  expect(c.querySelector('h2')?.textContent).toBe('Compacted context from previous session')

  const link = c.querySelector('a')
  expect(link?.textContent).toBe('Old work')
  expect(link?.getAttribute('href')).toBe('/projects/p1/sessions/src-1')
  // In-app navigation: not a new tab, unlike the links inside the markdown.
  expect(link?.hasAttribute('target')).toBe(false)

  // Rendered as markdown, not echoed as source.
  expect(c.querySelector('strong')?.textContent).toBe('compactor')
  expect([...c.querySelectorAll('h2')].map((h) => h.textContent)).toContain('Goal')
  expect(c.textContent).not.toContain('**')
  expect(c.textContent).not.toContain('## Goal')

  const copy = [...c.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Copy')
  expect(copy.length).toBe(1)

  expect(c.textContent).toContain(NOTE)
})

test('the card is a plain block, not a disclosure, and the summary is visible without a click', async () => {
  const el = await render([context(PAYLOAD)])
  expect(el.querySelectorAll('[data-slot="collapsible"]').length).toBe(0)
  expect(card(el).textContent).toContain('Ship the compactor.')
})

test('the card is the first row, and the conversation after it renders as usual', async () => {
  const el = await render([context(PAYLOAD), prompt('carry on')])
  const rows = [...el.querySelectorAll('[data-transcript-row]')]
  expect(rows.length).toBe(2)
  expect(rows[0]?.textContent).toContain('Compacted context from previous session')
  expect(rows[1]?.textContent).toContain('carry on')
})

test('with no title the link is named after the source session’s id', async () => {
  const el = await render([context({ ...PAYLOAD, sourceTitle: null })])
  expect(card(el).querySelector('a')?.textContent).toBe('Session src-1')
})

test('with no source id there is nothing to link to: plain text, not an anchor', async () => {
  const el = await render([context({ ...PAYLOAD, sourceSessionId: undefined, sourceTitle: null })])
  const c = card(el)
  expect(c.querySelector('a')).toBeNull()
  expect(c.textContent).toContain('Source session: Previous session')
})

test('with no project to resolve the link in, the title is plain text, not an anchor', async () => {
  const el = await render([context(PAYLOAD)], '')
  const c = card(el)
  expect(c.querySelector('a')).toBeNull()
  expect(c.textContent).toContain('Source session: Old work')
})

test('a short summary has no Show more button', async () => {
  const el = await render([context(PAYLOAD)])
  expect(toggle(el)).toBeUndefined()
})

test('a long summary is folded behind Show more, and Show less folds it again', async () => {
  const long = `${'A long line of the summary. '.repeat(80)}\n\nThe very end.`
  const el = await render([context({ ...PAYLOAD, summary: long })])
  // The summary's own wrapper: the card's one direct-child div that is not the header row.
  const body = () =>
    [...card(el).children].find((c) => c.tagName === 'DIV' && c.classList.contains('min-w-0'))
  const classes = () => body()?.getAttribute('class') ?? ''

  const button = toggle(el)
  expect(button?.textContent?.trim()).toBe('Show more')
  expect(button?.getAttribute('aria-expanded')).toBe('false')
  expect(classes()).toContain('max-h-80')
  expect(classes()).toContain('overflow-y-hidden')

  await act(async () => {
    button?.click()
  })
  expect(toggle(el)?.textContent?.trim()).toBe('Show less')
  expect(toggle(el)?.getAttribute('aria-expanded')).toBe('true')
  expect(classes()).not.toContain('max-h-80')
  // Folding is a height cap, not a slice: the whole summary was in the DOM all along.
  expect(card(el).textContent).toContain('The very end.')

  await act(async () => {
    toggle(el)?.click()
  })
  expect(toggle(el)?.textContent?.trim()).toBe('Show more')
  expect(classes()).toContain('max-h-80')
})

test('the copy button copies the raw markdown, not the rendered text', async () => {
  const writes: string[] = []
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (v: string) => void writes.push(v) },
  })
  try {
    const el = await render([context(PAYLOAD)])
    const copy = [...card(el).querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Copy',
    )
    await act(async () => {
      copy?.click()
    })
    expect(writes).toEqual(['## Goal\n\nShip the **compactor**.'])
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

for (const [name, payload] of [
  ['a null payload', null],
  ['a string payload', 'nope'],
  ['an empty payload', {}],
  ['a payload with the wrong types', { summary: 3, sourceTitle: 4, sourceSessionId: [] }],
] as const) {
  test(`${name} renders an empty card without throwing, and the rest of the transcript still shows`, async () => {
    const el = await render([context(payload), prompt('still here')])
    const c = card(el)
    expect(c.textContent).toContain('The summary is empty or could not be read.')
    expect(c.textContent).toContain(NOTE)
    // Nothing to copy, nothing to fold.
    expect([...c.querySelectorAll('button')].length).toBe(0)
    expect(el.textContent).toContain('still here')
  })
}
