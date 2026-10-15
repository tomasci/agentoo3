// A prompt's Code / Q&A mode, from the stored payload to the transcript row.
//
// `payload` is `unknown` on the wire (the backend writes `{ text }` for Code
// and `{ text, mode: 'qa' }` for Q&A, and a continuation may add `auto`), so
// the model reads `mode` the way it reads `text`: only the literal `'qa'`
// counts, and anything else — a missing key, another string, a number, a
// payload that is not even an object — is a Code row that renders exactly as
// every prompt did before the field existed.
//
// The badge is asserted by its shadcn `data-slot="badge"` and by counting,
// not by snapshot: "a Code row is unchanged" is a claim about the absence of
// markup. `@/shared/i18n` is imported and pinned to English for the reason
// tests/transcript-model-render.test.tsx spells out.

import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { i18n } from '@/shared/i18n'
import { Transcript } from '../src/features/sessions/components/transcript'
import { buildTranscript } from '../src/features/sessions/lib/transcript'

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
    createdAt: '2026-09-06T11:40:23.812Z',
    ...o,
  }) as M

const prompt = (payload: unknown) => msg({ type: 'prompt', payload })

const modeOf = (payload: unknown) => {
  n = 0
  const [node] = buildTranscript([prompt(payload)])
  if (node?.kind !== 'prompt') throw new Error('expected a prompt node')
  return node.mode
}

// --- the model ------------------------------------------------------------------

test('a Q&A payload gives a prompt node with mode "qa", and the text is the payload text, untouched', () => {
  n = 0
  const [node] = buildTranscript([prompt({ text: '  why?  \n', mode: 'qa' })])
  expect(node?.kind).toBe('prompt')
  if (node?.kind !== 'prompt') return
  expect(node.mode).toBe('qa')
  expect(node.text).toBe('  why?  \n')
})

test('a Code payload, with or without the key, is mode "code"', () => {
  expect(modeOf({ text: 'do it' })).toBe('code')
  expect(modeOf({ text: 'do it', mode: 'code' })).toBe('code')
})

test('a continuation that is also Q&A keeps its mode; one that is not stays Code', () => {
  expect(modeOf({ text: 'go on', mode: 'qa', auto: true })).toBe('qa')
  expect(modeOf({ text: 'go on', auto: true })).toBe('code')
})

test('anything but the literal "qa" reads as Code, and nothing throws', () => {
  for (const payload of [
    { text: 'x', mode: 'QA' },
    { text: 'x', mode: 'question' },
    { text: 'x', mode: '' },
    { text: 'x', mode: 1 },
    { text: 'x', mode: true },
    { text: 'x', mode: null },
    { text: 'x', mode: ['qa'] },
    { text: 'x', mode: { qa: true } },
    {},
    null,
    undefined,
  ]) {
    expect(modeOf(payload)).toBe('code')
  }
})

test('every prompt node carries a mode, and only prompt nodes do', () => {
  n = 0
  const nodes = buildTranscript([
    prompt({ text: 'a question', mode: 'qa' }),
    msg({ type: 'assistant', title: 'orchestrator: hi', payload: { mode: 'qa' } }),
    prompt({ text: 'a task' }),
  ])
  const prompts = nodes.filter((nd) => nd.kind === 'prompt')
  expect(prompts.map((p) => (p.kind === 'prompt' ? p.mode : null))).toEqual(['qa', 'code'])
  for (const nd of nodes) {
    if (nd.kind !== 'prompt') expect('mode' in nd).toBe(false)
  }
})

// --- the row ---------------------------------------------------------------------

let root: Root | undefined
let container: HTMLDivElement | undefined

async function render(messages: M[]) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Transcript messages={messages} sessionId="s" />)
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

const badges = (el: Element) => [...el.querySelectorAll('[data-slot="badge"]')]

test('a Q&A prompt row shows one "Q&A" badge, next to the label, and still shows the text as typed', async () => {
  n = 0
  const el = await render([prompt({ text: 'why is the build slow?', mode: 'qa' })])
  const found = badges(el)
  expect(found.map((b) => b.textContent)).toEqual(['Q&A'])
  expect(el.textContent).toContain('why is the build slow?')
  // The text is not prefixed, wrapped or otherwise reworded by the badge.
  expect(el.querySelector('p')?.textContent).toBe('why is the build slow?')
  // Beside the "You" label, in the row's own header — not inside the message.
  const badge = found[0]
  expect(badge?.closest('p')).toBeNull()
  expect(badge?.parentElement?.textContent).toContain('You')
})

test('a Code prompt row has no badge at all', async () => {
  n = 0
  const el = await render([prompt({ text: 'fix it' }), prompt({ text: 'and this', mode: 'code' })])
  expect(badges(el)).toEqual([])
  expect(el.textContent).not.toContain('Q&A')
})

test('in a mixed transcript only the Q&A rows carry the badge', async () => {
  n = 0
  const el = await render([
    prompt({ text: 'task one' }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
    prompt({ text: 'a question', mode: 'qa' }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
    prompt({ text: 'task two' }),
  ])
  expect(badges(el).length).toBe(1)
  const row = badges(el)[0]?.closest('[data-transcript-row]')
  expect(row?.textContent).toContain('a question')
  expect(row?.textContent).not.toContain('task one')
  expect(row?.textContent).not.toContain('task two')
})

test('the badge reads the Russian label under the Russian locale', async () => {
  await i18n.changeLanguage('ru')
  try {
    n = 0
    const el = await render([prompt({ text: 'вопрос', mode: 'qa' })])
    expect(badges(el).map((b) => b.textContent)).toEqual(['Вопрос'])
  } finally {
    // Inside act(): the mounted rows re-render on the language change.
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  }
})
