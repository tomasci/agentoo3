// The horizontal-overflow fix, tested at the only two levels this environment
// can actually judge it at.
//
// happy-dom performs no layout — `getBoundingClientRect` is zeros, no
// stylesheet is ever applied — so "the transcript does not scroll sideways at
// 360px" is NOT provable here, and nothing below pretends otherwise. What is
// provable is:
//
//   1. The rendered markup: every code block the transcript emits is the
//      wrapping kind rather than the horizontally-scrolling kind. That is a
//      property of `transcript.tsx`, not of the layout engine, and it is the
//      one the fix depends on for the widest content a session produces (a
//      Bash result, a JSON tool input) — a `<Code block>` without `wrap` is a
//      `white-space: pre` box, and its own `overflow-x: auto` is then the only
//      thing between it and the page.
//   2. The `data-transcript-row` contract, which is a live selector in
//      session-page.tsx's scroll compensation: on every top-level row, in
//      document order, and on nothing nested.
//   3. Declarations, read out of the stylesheets. Restating a single rule
//      would be worthless, so these are invariants over *all* the rules of a
//      kind — every `display: grid` in the transcript's own sheet, whether or
//      not it existed when this was written — which is what makes them able to
//      catch the next grid somebody adds without the fix.
//
// Not covered here, and not coverable here: whether `minmax(0, 1fr)` is
// sufficient for a given item (a grid item keeps `min-width: auto`, so content
// with a large min-content size still overflows the track), whether a nested
// scroll container contributes zero to an ancestor's min-content size, and
// anything about Collapsible's `overflow: hidden` clipping rather than
// scrolling. Those need a real engine.

import { plugin } from 'bun'
import { expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx,
// tests/transcript-row.test.tsx, tests/transcript-time.test.tsx and
// tests/transcript-attachments.test.tsx — see the long note in
// transcript-time.test.tsx for why every one of them has to register it.
// Copied verbatim, not widened. It is also what makes assertion (1) above
// possible at all: with it, `Code`'s `styles.block` / `styles.wrap` render as
// the literal class names `block` and `wrap`.
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'transcript-overflow-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

const { buildTranscript } = await import('../src/features/sessions/lib/transcript')
const { Transcript } = await import('../src/features/sessions/components/transcript')

type M = Parameters<typeof Transcript>[0]['messages'][number]

let n = 0
const msg = (o: Partial<M> & { type: string }): M =>
  ({
    id: `m${n}`,
    sessionId: 's1',
    seq: n++,
    parentToolUseId: null,
    title: null,
    pending: false,
    payload: {},
    files: [],
    createdAt: '2026-09-04T10:00:00.000Z',
    ...o,
  }) as M

const text = (t: string) => ({ message: { content: [{ type: 'text', text: t }] } })

/** A single unbroken token — the shape of content that has no wrap
 *  opportunity at all: a path, a hash, a base64 blob. */
const LONG_TOKEN = `/very/long/${'segment'.repeat(40)}/path.txt`

/**
 * One turn that reaches every branch of the transcript that can hold wide
 * content, because "no `<Code block>` without `wrap`" is only worth asserting
 * over a tree that actually renders all of them:
 *
 *   ToolInput      object -> DefinitionList(stacked) -> Code per value
 *   ToolInput      non-object -> Code
 *   ToolInput      {} -> the no-arguments note, no Code at all
 *   ToolResultView plain -> Code
 *   ToolResultView is_error -> Alert wrapping the same Code
 *   MessageBody    unrecognised payload -> Code dump
 *   task           local_bash -> the command block -> Code
 *   answer         markdown -> react-markdown's own <pre>, which is a
 *                  different box with different rules (see the last test)
 */
const turn = (): M[] => {
  n = 0
  return [
    msg({ type: 'prompt', payload: { text: `look at ${LONG_TOKEN}` } }),
    msg({
      type: 'assistant',
      title: 'orchestrator: running tools',
      payload: {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-obj',
              // The MCP naming scheme: one unbroken token, up to 128 chars.
              name: 'mcp__some_server__do_a_thing_with_a_really_long_name',
              input: { command: `cat ${LONG_TOKEN}`, timeout: 120 },
            },
            { type: 'tool_use', id: 'tu-arr', name: 'ArrayInput', input: ['a', LONG_TOKEN] },
            { type: 'tool_use', id: 'tu-err', name: 'Bash', input: { command: 'false' } },
            { type: 'tool_use', id: 'tu-none', name: 'ListAgents', input: {} },
          ],
        },
      },
    }),
    msg({
      type: 'user',
      payload: {
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-obj', content: `ok ${LONG_TOKEN}` },
            { type: 'tool_result', tool_use_id: 'tu-err', content: LONG_TOKEN, is_error: true },
          ],
        },
      },
    }),
    msg({
      type: 'system',
      title: 'shell',
      payload: {
        subtype: 'task_started',
        task_id: 't-bash',
        tool_use_id: 'tu-bash',
        task_type: 'local_bash',
        description: `sleep 60 && cat ${LONG_TOKEN}`,
      },
    }),
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
    msg({
      type: 'assistant',
      parentToolUseId: 'tu1',
      title: 'nested step',
      payload: text('inner'),
    }),
    msg({
      type: 'system',
      parentToolUseId: 'tu1',
      title: 'scout: look around',
      payload: {
        subtype: 'task_started',
        task_id: 't2',
        tool_use_id: 'tu2',
        subagent_type: 'scout',
        description: 'look around',
        prompt: 'Look.',
      },
    }),
    // Nothing MessageBody recognises: the JSON dump branch.
    msg({ type: 'assistant', title: 'mystery', payload: { unrecognised: LONG_TOKEN } }),
    msg({
      type: 'assistant',
      title: 'orchestrator: replying',
      payload: text(
        [
          'done — see the table and the fence below.',
          '',
          '| column | value |',
          '| --- | --- |',
          `| path | ${LONG_TOKEN} |`,
          '',
          '```sh',
          `cat ${LONG_TOKEN}`,
          '```',
        ].join('\n'),
      ),
    }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ]
}

async function render(messages: M[]) {
  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(<Transcript messages={messages} sessionId="s1" />)
  })
  return container
}

const triggers = (el: Element) =>
  [...el.querySelectorAll('button[data-part="trigger"]')] as HTMLElement[]

/** Collapsible unmounts its body on exit, so nothing inside a task or event row
 *  exists in the DOM until it is opened — and a nested group only appears once
 *  its parent is open, hence the passes. */
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

// --- 1. every code block the transcript emits is the wrapping kind ------------

test('the fixture reaches every Code site the transcript has', async () => {
  // Guards the two tests below: they assert a property of a set, and a set that
  // silently stopped being populated would pass them without testing anything.
  // Nine `Code` blocks: three tool-input object values (command, timeout, and
  // the failing call's own command), one array input, two results (plain and
  // is_error), the shell command, and two payload dumps — the `mystery`
  // message and, less obviously, the turn's `result` row, whose
  // `{ subtype: 'success' }` is nothing MessageBody recognises either.
  const container = await render(turn())
  await openAll(container)
  const blocks = [...container.querySelectorAll('pre.block')]
  expect(blocks.length).toBe(9)
  // And the no-arguments branch rendered its note instead of an eighth.
  expect(container.textContent ?? '').toMatch(/noArguments|no arguments/i)
})

test('no code block in the transcript is left to scroll horizontally', async () => {
  const container = await render(turn())
  await openAll(container)

  // `.wrap` is what turns `white-space: pre` into `pre-wrap` +
  // `overflow-wrap: anywhere` (code.module.scss). Without it a block keeps its
  // own `overflow-x: auto`, which is a second horizontal scroller inside a
  // vertical one — the thing the change deliberately refuses to add.
  const unwrapped = [...container.querySelectorAll('pre.block')]
    .filter((pre) => !pre.classList.contains('wrap'))
    // Named by their content, so a failure says which call site regressed.
    .map((pre) => (pre.textContent ?? '').slice(0, 40))
  expect(unwrapped).toEqual([])
})

test("the model's own fenced code is NOT the wrapping kind, and relies on markdown's box", async () => {
  // react-markdown renders its own `<pre>`, which `Code` never touches: a
  // fence in a reply keeps its line breaks and scrolls inside itself. This is
  // the one horizontally-scrolling box the transcript still contains, so the
  // rule that makes it scroll *inside itself* is pinned below rather than
  // assumed.
  const container = await render(turn())
  const markdownPre = [...container.querySelectorAll('pre')].filter(
    (pre) => !pre.classList.contains('block'),
  )
  expect(markdownPre.length).toBe(1)
  expect(markdownPre[0]?.textContent ?? '').toContain('cat /very/long/')

  const scss = await Bun.file('src/shared/ui/core/markdown.module.scss').text()
  const strip = (s: string) => s.replace(/\/\/.*/g, '')
  // Nested inside `.markdown`, so match the declaration in context.
  expect(strip(scss)).toMatch(/pre\s*\{[^}]*overflow-x:\s*auto/)
  expect(strip(scss)).toMatch(/\.tableWrap\s*\{[^}]*overflow-x:\s*auto/)
})

test('a wide markdown table is wrapped in its own scroll box, not left bare', async () => {
  const container = await render(turn())
  const table = container.querySelector('table')
  if (!table) throw new Error('no table rendered')
  // The wrapper carries `.tableWrap`, whose class name is not available here
  // (markdown.module.scss is outside the identity-proxy allowlist), so the
  // structural fact is what is asserted: the table is not a bare child of the
  // markdown root.
  expect(table.parentElement?.tagName).toBe('DIV')
  expect(table.parentElement?.children.length).toBe(1)
})

// --- 2. the data-transcript-row contract --------------------------------------

test('every top-level row carries data-transcript-row, in document order', async () => {
  const messages = turn()
  const nodes = buildTranscript(messages)
  expect(nodes.map((node) => node.kind)).toEqual([
    'prompt',
    'event',
    'task',
    'task',
    'event',
    'answer',
    'event',
  ])

  const container = await render(messages)
  const g = grid(container)
  const marked = [...container.querySelectorAll('[data-transcript-row]')]

  expect(marked.length).toBe(nodes.length)
  // Exactly the grid's children, in order — `querySelectorAll` returns document
  // order, so comparing index by index proves both the set and the sequence.
  expect(marked.map((row, i) => row === g.children[i])).toEqual(nodes.map(() => true))
  // Valueless, not "true"/"1": `[data-transcript-row]` is the selector, and a
  // value would be a second thing to keep in step.
  expect(marked.map((row) => row.getAttribute('data-transcript-row'))).toEqual(nodes.map(() => ''))
})

test('no nested row carries it, even with every task group open', async () => {
  const container = await render(turn())
  const before = container.querySelectorAll('[data-transcript-row]').length
  await openAll(container)

  // Opening mounts the nested step and the nested scout group; neither is a
  // top-level row, and neither may acquire the attribute.
  expect(container.textContent ?? '').toContain('nested step')
  expect(container.textContent ?? '').toContain('look around')
  expect(container.querySelectorAll('[data-transcript-row]').length).toBe(before)

  // Stated the other way round as well: nothing marked contains anything else
  // marked, so a consumer counting rows inside the scroll container can never
  // double-count an open group.
  const nestedInside = [...container.querySelectorAll('[data-transcript-row]')].map(
    (row) => row.querySelectorAll('[data-transcript-row]').length,
  )
  expect(nestedInside).toEqual(nestedInside.map(() => 0))
})

// --- 3. declarations, as invariants over whole stylesheets ---------------------

/** Top-level rule blocks of a stylesheet, comments stripped. Nested rules
 *  (`&:hover`, `.layoutInline .term`) stay inside their parent's body, which is
 *  what the callers below want: a `display: grid` anywhere in a block has to be
 *  answered by a column template in that same block. */
function rules(scss: string): Array<{ selector: string; body: string }> {
  const source = scss.replace(/\/\/.*$/gm, '')
  const out: Array<{ selector: string; body: string }> = []
  let i = 0
  while (i < source.length) {
    const open = source.indexOf('{', i)
    if (open === -1) break
    const selector = source.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++
      else if (source[j] === '}') depth--
      j++
    }
    out.push({ selector, body: source.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

const gridsIn = (scss: string) =>
  rules(scss).filter((rule) => /display:\s*grid/.test(rule.body))

test('every grid in the transcript stylesheet pins its column to a zero minimum', async () => {
  const scss = await Bun.file('src/features/sessions/components/transcript.module.scss').text()
  const grids = gridsIn(scss)

  // Not a fixed list: the point of scanning is that a grid added later is
  // covered too. Five today — .transcript, .children, .tool, .result, .answer.
  expect(grids.length).toBeGreaterThanOrEqual(5)
  const offenders = grids
    .filter((rule) => !/grid-template-columns:\s*minmax\(\s*0\s*,/.test(rule.body))
    .map((rule) => rule.selector)
  // An implicit column is an `auto` track, whose base size is its widest item's
  // min-content contribution — that is the size that can exceed the viewport
  // and take every sibling row with it, because a stretched item is sized to
  // the track, not to the container.
  expect(offenders).toEqual([])
})

test("Collapsible's body — every transcript disclosure renders into it — does the same", async () => {
  const scss = await Bun.file('src/shared/ui/disclosure/collapsible.module.scss').text()
  const grids = gridsIn(scss)
  expect(grids.map((rule) => rule.selector)).toEqual(['.body'])
  expect(grids[0]?.body).toMatch(/grid-template-columns:\s*minmax\(\s*0\s*,/)

  // And the disclosure's own root still refuses to be widened by its title.
  const root = rules(scss).find((rule) => rule.selector === '.root')
  expect(root?.body).toMatch(/min-width:\s*0/)
})

test('the tool name breaks anywhere — the one keyword that changes min-content', async () => {
  const scss = await Bun.file('src/features/sessions/components/transcript.module.scss').text()
  const toolName = rules(scss).find((rule) => rule.selector === '.toolName')
  expect(toolName?.body).toMatch(/overflow-wrap:\s*anywhere/)
  // Deliberately not `break-word`: it permits the same breaks when painting but
  // is defined not to affect the intrinsic min-content size, so an MCP tool
  // name would still contribute its full length to the track and still push the
  // row wide. Only `anywhere` changes the measurement.
  expect(toolName?.body).not.toMatch(/overflow-wrap:\s*break-word/)
})

test("DefinitionList's description can shrink, in the layout its other three callers use", async () => {
  const scss = await Bun.file('src/shared/ui/patterns/definition-list.module.scss').text()
  const description = rules(scss).find((rule) => rule.selector === '.description')
  expect(description?.body).toMatch(/min-width:\s*0/)

  // The term keeps its fixed inline width, so the shrinking happens on the
  // side that has something to give.
  const inline = rules(scss).find((rule) => rule.selector === '.layoutInline')
  expect(inline?.body).toMatch(/width:\s*8rem/)
  expect(rules(scss).find((rule) => rule.selector === '.term')?.body).toMatch(/flex-shrink:\s*0/)
})
