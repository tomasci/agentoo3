// The wrapper `TranscriptView` puts around each top-level transcript node.
//
// It used to carry a `content-visibility` containment boundary too (dropped —
// see transcript.tsx's own comment on the row wrapper for why); what it still
// has to carry is `data-transcript-row`, the selector session-page.tsx's
// scroll-position compensation (`pickAnchor`) walks inside the scroll
// container.
//
// The claim being pinned is structural and exact: *one* wrapper per top-level
// node, and *none* around a nested one. Both halves matter — no wrapper and
// `pickAnchor` has nothing to select at all; a wrapper per nested row and it
// would anchor a prepend on a row that is not actually top-level, inside an
// open task group that already gets its own containment for free from
// Collapsible's own unmount-on-exit.
//
// Asserted through parentage rather than class names on purpose: a node root
// either has a wrapper of its own between it and the grid, or it shares its
// parent with its siblings — a fact classes cannot substitute for even though
// Tailwind's own utility classes are literal strings in this DOM.

import { expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { buildTranscript } from '../src/features/sessions/lib/transcript'
import { Transcript } from '../src/features/sessions/components/transcript'

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
    createdAt: '2026-09-04T10:00:00Z',
    ...o,
  }) as M

const text = (t: string) => ({ message: { content: [{ type: 'text', text: t }] } })

/** A turn whose delegated task has *two* nested steps: one nested row cannot
 *  distinguish "shares a parent with its siblings" from "has a parent of its
 *  own", and that distinction is the whole test. */
const turn = () => {
  n = 0
  return [
    msg({ type: 'prompt', payload: { text: 'build it' } }),
    msg({
      type: 'system',
      title: 'architect: design the runner',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'design the runner',
        prompt: 'Design it.',
      },
    }),
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'nested one', payload: text('inner a') }),
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'nested two', payload: text('inner b') }),
    msg({ type: 'assistant', title: 'orchestrator: replying', payload: text('done') }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ]
}

async function render(messages: M[]) {
  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(<Transcript messages={messages} />)
  })
  return container
}

/** Every collapsible trigger: `ui/collapsible`'s own `data-slot`, set
 *  unconditionally by the shared component regardless of what a caller wraps
 *  it in. */
const triggers = (el: Element) =>
  [...el.querySelectorAll('button[data-slot="collapsible-trigger"]')] as HTMLElement[]

async function openAll(container: Element) {
  for (let pass = 0; pass < 5; pass++) {
    const shut = triggers(container).filter((b) => b.getAttribute('aria-expanded') === 'false')
    if (shut.length === 0) return
    for (const b of shut) await act(async () => b.click())
  }
  throw new Error('disclosures did not settle open')
}

const grid = (container: Element) => {
  const el = container.firstElementChild
  if (!el) throw new Error('nothing rendered')
  return el
}

/**
 * A short, printable stand-in for a DOM node: unique per node, stable for the
 * life of the run.
 *
 * No element in this file is the operand of a matcher that prints its operands
 * — `toBe`, `toEqual`, `toBeNull`, `toBeUndefined`. A happy-dom element
 * serialises its symbol-keyed internals *and* its whole ancestor chain, which
 * from a transcript row is the document. The nested-row assertion below is
 * where that was found: it failed, the serialiser ran, and the process died at
 * ~1.4 GB with exit 137 and no message, taking the rest of `bun test tests/`
 * with it. A test that cannot report its own failure has nothing to say, so
 * identity is compared through these tokens instead: distinct nodes get
 * distinct tokens, one node always gets the same token, and a mismatch prints
 * as `<div #6>` vs `<div #7>` rather than as a heap dump.
 *
 * (`toHaveLength` is exempt — it prints only the two lengths. The `.length`
 * spellings below are for positional failure messages, not for safety.)
 *
 * (The `openAll` loop above was the other suspect and is not implicated: it
 * settles in two passes, so leave it matching the copy in
 * tests/transcript-time.test.tsx.)
 */
const tokens = new WeakMap<Node, string>()
let tokenCount = 0
// `null`/`undefined` pass straight through rather than becoming the strings
// "null"/"undefined": an absence is a distinct outcome from any node, and a
// token that stringifies it would quietly satisfy a `toBeNull()` written
// against this helper later. Same contract as the copy in
// tests/workspace.test.tsx.
const ref = (node: Node | null | undefined): string | null | undefined => {
  if (node === null || node === undefined) return node
  const seen = tokens.get(node)
  if (seen) return seen
  const token = `<${node.nodeName.toLowerCase()} #${++tokenCount}>`
  tokens.set(node, token)
  return token
}

/** Positional, so a failure names *which* row disagreed rather than only that
 *  one did. */
const each = <T,>(xs: readonly unknown[], value: T): T[] => xs.map(() => value)

const TEXT_NODE = 3

/** Text this element contributes itself, rather than through a descendant. */
const ownText = (el: Element) =>
  [...el.childNodes]
    .filter((n) => n.nodeType === TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join('')
    .trim()

/**
 * A row wrapper: holds one node and contributes nothing of its own.
 *
 * Deliberately *not* "a direct child of the grid". Remove the wrappers and the
 * grid still has one direct child per top-level node — the node roots move up
 * into their place — so counting children proves nothing. Every node root
 * fails at least one clause here: a disclosure carries `data-slot="collapsible"`
 * (`ui/collapsible`'s own contract), the prompt bubble carries its own text,
 * the answer block holds two children.
 */
const isWrapper = (el: Element) =>
  el.tagName === 'DIV' &&
  !el.hasAttribute('data-slot') &&
  el.children.length === 1 &&
  ownText(el) === ''

// --- one wrapper per top-level node -------------------------------------------

test('the grid holds exactly one child per top-level node, and each holds one node', async () => {
  const messages = turn()
  const nodes = buildTranscript(messages)
  expect(nodes.map((node) => node.kind)).toEqual(['prompt', 'task', 'answer', 'event'])

  const container = await render(messages)
  const rows = [...grid(container).children]
  expect(rows.length).toBe(nodes.length)
  expect(rows.map((row) => row.tagName)).toEqual(each(nodes, 'DIV'))
  // The wrapper carries nothing of its own: no collapsible parts, no text
  // outside the node it wraps.
  expect(rows.map((row) => row.hasAttribute('data-slot'))).toEqual(each(nodes, false))
  expect(rows.map((row) => row.children.length)).toEqual(each(nodes, 1))
  expect(rows.map(ownText)).toEqual(each(nodes, ''))
})

test('each top-level node sits under its own wrapper, one level below the grid', async () => {
  const container = await render(turn())
  const g = grid(container)

  // Anchored on elements that say what they are, rather than on "whatever sits
  // one level below the grid": deriving the roots by unwrapping a level
  // presumes the wrapper this test exists to prove, and passes just as happily
  // when there is none — it simply unwraps the node root instead and finds its
  // first child. The two top-level disclosures are named by their own trigger
  // text; the nested pair is titled differently on purpose.
  const rootOf = (title: string) => {
    const trigger = triggers(g).find((b) => b.textContent?.includes(title))
    if (!trigger) throw new Error(`no disclosure titled ${JSON.stringify(title)}`)
    return trigger.closest('[data-slot="collapsible"]') as HTMLElement
  }
  const roots = ['design the runner', 'Turn complete'].map(rootOf)

  // Wrapped: no node root's parent is the grid itself...
  expect(roots.map((root) => ref(root.parentElement))).not.toContain(ref(g))
  // ...and every grandparent is — exactly one level of wrapping, not two.
  expect(roots.map((root) => ref(root.parentElement?.parentElement))).toEqual(each(roots, ref(g)))
  // Wrapped *individually*: no two share a wrapper, and a wrapper holds
  // nothing besides the one node.
  expect(new Set(roots.map((root) => ref(root.parentElement))).size).toBe(roots.length)
  expect(roots.map((root) => root.parentElement?.children.length)).toEqual(each(roots, 1))
})

test('the wrapping did not disturb which node is which, or their order', async () => {
  const container = await render(turn())
  const [prompt, task, answer, result] = [...grid(container).children].map(
    (row) => row.firstElementChild as HTMLElement,
  )
  if (!prompt || !task || !answer || !result) throw new Error('expected four rows')

  expect(prompt.textContent).toContain('build it')
  expect(task.getAttribute('data-slot')).toBe('collapsible')
  expect(task.textContent).toContain('design the runner')
  expect(answer.textContent).toContain('done')
  expect(result.getAttribute('data-slot')).toBe('collapsible')
})

// --- and no wrapper below that -------------------------------------------------

test('nested rows are NOT wrapped: siblings inside a task group share one parent', async () => {
  const container = await render(turn())
  await openAll(container)

  const task = [...grid(container).children][1]?.firstElementChild
  if (!task) throw new Error('no task row')

  const nested = triggers(task)
    .filter((b) => /nested (one|two)/.test(b.textContent ?? ''))
    .map((b) => b.closest('[data-slot="collapsible"]') as HTMLElement)
  expect(nested.map((el) => el?.getAttribute('data-slot'))).toEqual(['collapsible', 'collapsible'])

  const [a, b] = nested
  if (!a || !b) throw new Error('nested rows missing')
  // A per-nested-row wrapper would give each its own parent with one child.
  expect(ref(a.parentElement)).toBe(ref(b.parentElement))
  expect(a.parentElement?.children.length).toBe(2)
})

test('the whole tree contains exactly as many wrappers as there are top-level nodes', async () => {
  const messages = turn()
  const container = await render(messages)
  await openAll(container)
  const g = grid(container)

  // One per top-level node, counted after opening: nothing the disclosures
  // mounted on the way in added another.
  expect([...g.children].filter(isWrapper).length).toBe(buildTranscript(messages).length)

  // And none below that. A structural sweep for wrappers over the whole tree
  // is no use — `CollapsibleContent`'s own body is a single-child div too, and
  // several divs in this tree match on shape alone. Disclosure roots
  // (`[data-slot="collapsible"]`) are the one thing that occurs at every depth
  // *and* announces itself, so they can be found without knowing where they
  // are, and each asked whether its parent wraps it alone. Document order: the
  // task group, its two nested steps, the result.
  const wrapping = [...container.querySelectorAll('[data-slot="collapsible"]')].map((root) => [
    triggers(root)[0]?.textContent?.includes('nested') ? 'nested' : 'top-level',
    root.parentElement ? isWrapper(root.parentElement) : false,
  ])
  expect(wrapping).toEqual([
    ['top-level', true],
    ['nested', false],
    ['nested', false],
    ['top-level', true],
  ])
})

test('a transcript of one node still gets exactly one wrapper', async () => {
  n = 0
  const container = await render([msg({ type: 'prompt', payload: { text: 'only' } })])
  const g = grid(container)
  expect(g.children.length).toBe(1)
  // isWrapper, not `children.length === 1`: an unwrapped prompt bubble is also
  // a lone div with a single element child (its caption).
  expect([...g.children].filter(isWrapper).length).toBe(1)
  expect(g.textContent).toContain('only')
})

test('an empty transcript renders the empty state, with no wrapper around nothing', async () => {
  const container = await render([])
  // Matched against key *or* copy: whether i18n has been initialised depends on
  // which other file in the run got there first, and this test is not about
  // that. The empty state is `ui/empty`, not the `.grid` container, so there is
  // no row level here at all to leave a stray boundary behind.
  expect(container.textContent ?? '').toMatch(/sessions\.transcript\.empty|Nothing yet/)
  expect(container.querySelectorAll('[data-slot="collapsible"]').length).toBe(0)
})

// --- the declarations the DOM structure exists to carry -------------------------

test('every top-level row is still a wrapper carrying the data-transcript-row contract, with no content-visibility left on it', async () => {
  // The containment classes were dropped (see transcript.tsx's own comment):
  // a placeholder height for a row scrolled out of view moved content under a
  // reader scrolling back through history on engines with no scroll
  // anchoring. What has to survive that removal is the wrapper itself and its
  // attribute — session-page.tsx's scroll-position compensation selects rows
  // by `[data-transcript-row]`, and losing that silently would break the
  // anchor it depends on without touching a single assertion about anchoring
  // itself.
  const container = await render(turn())
  const rows = [...grid(container).children]
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.hasAttribute('data-transcript-row')).toBe(true)
    expect(row.classList.contains('[content-visibility:auto]')).toBe(false)
    expect(row.classList.contains('[contain-intrinsic-size:auto_6rem]')).toBe(false)
  }
})

test('the prompt bubble aligns by a mechanism that survives no longer being a grid item', async () => {
  // `.prompt` used to be a direct child of the `.transcript` grid and aligned
  // right with `justify-self: end`. It is now a child of the row wrapper, an
  // ordinary block box — `justify-self` on a non-grid-item does nothing, so an
  // inline-margin push is what has to do the aligning instead.
  const container = await render([msg({ type: 'prompt', payload: { text: 'hi' } })])
  const prompt = grid(container).firstElementChild?.firstElementChild as HTMLElement
  if (!prompt) throw new Error('no prompt row')
  expect(prompt.classList.contains('ml-auto')).toBe(true)
  expect(prompt.classList.contains('justify-self-end')).toBe(false)
})
