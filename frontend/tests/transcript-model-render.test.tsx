// The per-message model label, in the rendered DOM.
//
// "Messages without a model render exactly as before" is a claim about
// markup — no empty wrapper, no orphan separator — and a snapshot would
// happily record either of those as the expected output, so everything below
// counts elements and compares exact text instead.
//
// Two environment facts shape the selectors. `bun test` resolves a
// `.module.scss` import to its file path, so `className={styles.model}`
// renders as no class at all (see the note in tests/transcript-row.test.tsx)
// — the label has to be found by something other than its class. And `bun
// test` shares one module registry across the whole run, so whether
// `@/shared/i18n` has been initialised by the time this file renders depends
// on which other file got there first: without the import below, `t()`
// returned raw keys when this file ran alone and real English when it ran
// after tests/ui-core.test.tsx, and eight assertions here flipped with the
// file order. Importing it (idempotent — i18next initialises once, module
// cached) is what tests/docker-page.test.tsx and tests/ui-core.test.tsx
// already do, and for the same reason.

import { plugin } from 'bun'
import { expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { i18n } from '@/shared/i18n'

// The language detector reads `navigator.language`, which is the host's, not
// this suite's business. Pinned so the strings asserted below are the ones in
// en.json whatever the box is set to.
await i18n.changeLanguage('en')

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx and
// the other transcript DOM tests — see the long note in
// tests/transcript-time.test.tsx for why every one of them has to register it.
// Copied verbatim, not widened.
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'transcript-model-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

const { Transcript } = await import('../src/features/sessions/components/transcript')

type M = Parameters<typeof Transcript>[0]['messages'][number]

const AT = '2026-09-06T11:40:23.812Z'
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
    createdAt: AT,
    ...o,
  }) as M

const assistant = (model: string | undefined, text: string, extra: Partial<M> = {}): M =>
  msg({
    type: 'assistant',
    title: `orchestrator: ${text}`,
    payload: {
      type: 'assistant',
      message: {
        role: 'assistant',
        type: 'message',
        ...(model === undefined ? {} : { model }),
        content: [{ type: 'text', text }],
      },
    },
    ...extra,
  })

const result = () => msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } })

async function render(messages: M[]) {
  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(<Transcript messages={messages} />)
  })
  return container
}

const triggers = (el: Element) =>
  [...el.querySelectorAll('button[data-part="trigger"]')] as HTMLElement[]

/** Open every disclosure, including ones that only appear once a parent opens. */
async function openAll(container: Element) {
  for (let pass = 0; pass < 5; pass++) {
    const shut = triggers(container).filter((b) => b.getAttribute('aria-expanded') === 'false')
    if (shut.length === 0) return
    for (const b of shut) await act(async () => b.click())
  }
  throw new Error('disclosures did not settle open')
}

/** Every model label rendered under `el`, in document order.
 *
 * Identified by the relationship between a span's title and its own text —
 * the title of a model label is exactly that label's key rendered for the
 * model it shows — rather than by a literal string. That holds whether or
 * not i18next resolved the key, so this cannot start measuring something
 * else the day the import above is dropped, and it can never match a
 * timestamp, whose title is a date.
 */
const labels = (el: Element) =>
  ([...el.querySelectorAll('span[title]')] as HTMLElement[]).filter(
    (s) =>
      s.getAttribute('title') ===
      i18n.t('sessions.transcript.model', { model: s.textContent ?? '' }),
  )
const models = (el: Element) => labels(el).map((s) => s.textContent)

/** The transcript's top-level rows, unwrapped from their `.row` containment
 * boundary — same helper as tests/transcript-time.test.tsx. */
const rows = (container: Element) =>
  [...(container.firstElementChild?.children ?? [])].map(
    (row) => row.firstElementChild as HTMLElement,
  )

/** HH:MM in the local zone, computed without Intl. */
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// --- the answer row -----------------------------------------------------------

test('an answer with a model shows it once, as its own element beside the time', async () => {
  n = 0
  const container = await render([
    msg({ type: 'prompt', payload: { text: 'go' } }),
    assistant('claude-opus-5', 'All fixes landed.'),
    result(),
  ])

  const answer = rows(container)[1]
  if (!answer) throw new Error('expected an answer row')

  expect(models(answer)).toEqual(['claude-opus-5'])
  // Beside the time, not inside it: a label nested in the timestamp would
  // inherit its tabular-nums and be read as part of the clock.
  const [label] = labels(answer)
  const time = [...answer.querySelectorAll('span[title]')].find((s) => s.textContent === hhmm(AT))
  if (!label || !time) throw new Error('expected both a time and a model label')
  expect(time.contains(label)).toBe(false)
  expect(label.parentElement).toBe(time.parentElement)

  // Exactly the meta wrapper and the markdown body — the model did not add a
  // third child to the answer's single-column grid.
  expect(answer.children).toHaveLength(2)
  expect(answer.children[0]?.children).toHaveLength(2)
})

test('an answer with no model renders no label, no empty element and no separator', async () => {
  n = 0
  const container = await render([
    msg({ type: 'prompt', payload: { text: 'go' } }),
    assistant(undefined, 'All fixes landed.'),
    result(),
  ])

  const answer = rows(container)[1]
  if (!answer) throw new Error('expected an answer row')

  expect(labels(answer)).toHaveLength(0)
  // The meta wrapper holds the timestamp and nothing else: no placeholder
  // span waiting to be filled.
  expect(answer.children).toHaveLength(2)
  expect(answer.children[0]?.children).toHaveLength(1)
  // And nothing punctuates the gap where a model would have gone.
  expect(answer.textContent).toBe(`${hhmm(AT)}All fixes landed.`)
  expect(answer.textContent).not.toContain('undefined')
  expect(answer.textContent).not.toContain('null')
})

test('an answer whose model is a number renders as if it had none', async () => {
  n = 0
  const container = await render([
    msg({
      type: 'assistant',
      title: 'orchestrator: replying',
      payload: { message: { model: 5, content: [{ type: 'text', text: 'done' }] } },
    }),
    result(),
  ])

  const answer = rows(container)[0]
  if (!answer) throw new Error('expected an answer row')
  expect(labels(answer)).toHaveLength(0)
  expect(answer.textContent).toBe(`${hhmm(AT)}done`)
})

test('an answer with a model but an unparsable time shows the model alone', async () => {
  n = 0
  const container = await render([
    assistant('claude-opus-5', 'All fixes landed.', { createdAt: 'not-a-date' }),
    msg({ type: 'result', title: 'Turn complete', createdAt: 'not-a-date', payload: {} }),
  ])

  const answer = rows(container)[0]
  if (!answer) throw new Error('expected an answer row')
  expect(models(answer)).toEqual(['claude-opus-5'])
  expect(answer.textContent).toBe('claude-opus-5All fixes landed.')
  expect(answer.textContent).not.toContain('Invalid Date')
  expect(answer.textContent).not.toContain('NaN')
})

// --- collapsed rows ------------------------------------------------------------

test('a collapsed assistant row carries its own model in the trigger', async () => {
  n = 0
  const container = await render([
    assistant('claude-opus-5', 'reading the schema'),
    // A second assistant row, so the first is not promoted into the answer.
    assistant('claude-opus-5', 'still reading'),
  ])

  const [first] = rows(container)
  if (!first) throw new Error('expected a collapsed row')
  const trigger = triggers(first)[0]
  if (!trigger) throw new Error('no trigger')
  expect(models(trigger)).toEqual(['claude-opus-5'])
  // indicator, title, meta — the model went inside the meta slot rather than
  // adding a fourth child.
  expect(trigger.children).toHaveLength(3)
})

test('a result row names no model, because nothing produced it', async () => {
  n = 0
  const container = await render([
    msg({ type: 'prompt', payload: { text: 'go' } }),
    assistant('claude-opus-5', 'All fixes landed.'),
    result(),
  ])

  const resultRow = rows(container)[2]
  if (!resultRow) throw new Error('expected a result row')
  expect(labels(resultRow)).toHaveLength(0)
})

test('a prompt row names no model', async () => {
  n = 0
  const container = await render([
    msg({ type: 'prompt', payload: { text: 'commit & push' } }),
    assistant('claude-opus-5', 'done'),
    result(),
  ])
  const prompt = rows(container)[0]
  if (!prompt) throw new Error('expected a prompt row')
  expect(labels(prompt)).toHaveLength(0)
  expect(prompt.textContent).toBe(
    `${i18n.t('sessions.transcript.you')}${hhmm(AT)}commit & push`,
  )
})

// --- the subagent case ----------------------------------------------------------

test('an orchestrator and its subagent each show their own model, not one hoisted value', async () => {
  // Modelled on the two real captured frames in
  // tests/streamed-message-real-frames.test.ts (:54 carries a
  // parentToolUseId, :94 does not). The models differ here because that is
  // exactly what a per-message label is for.
  n = 0
  const container = await render([
    msg({ type: 'prompt', payload: { text: 'build it' } }),
    msg({
      type: 'system',
      title: 'tester: check the capture',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'toolu_01QmjoUcD2n9Yf5JS921B1xY',
        subagent_type: 'tester',
        description: 'check the capture',
      },
    }),
    assistant('claude-haiku-4-5', 'Let me check the background live capture.', {
      parentToolUseId: 'toolu_01QmjoUcD2n9Yf5JS921B1xY',
    }),
    assistant('claude-opus-5', 'All fixes landed.'),
    result(),
  ])
  await openAll(container)

  // Both, once each, in stream order — not one value repeated onto both rows.
  expect(models(container)).toEqual(['claude-haiku-4-5', 'claude-opus-5'])

  const [, task, answer] = rows(container)
  if (!task || !answer) throw new Error('expected a task row and an answer row')
  // The subagent's label lives inside the group it belongs to.
  expect(models(task)).toEqual(['claude-haiku-4-5'])
  expect(models(answer)).toEqual(['claude-opus-5'])
})

test('a subagent two levels down still shows its own model', async () => {
  n = 0
  const started = (toolUseId: string, taskId: string, parent: string | null) =>
    msg({
      type: 'system',
      parentToolUseId: parent,
      title: `${taskId}: work`,
      payload: {
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: toolUseId,
        subagent_type: 'architect',
        description: `${taskId} work`,
      },
    })

  const container = await render([
    started('tu1', 't1', null),
    assistant('claude-sonnet-5', 'outer step', { parentToolUseId: 'tu1' }),
    started('tu2', 't2', 'tu1'),
    assistant('claude-haiku-4-5', 'inner step', { parentToolUseId: 'tu2' }),
  ])
  await openAll(container)

  expect(models(container)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5'])
})

// --- the model label and the timestamp are separate handles ----------------------

test('the model label is not counted as a timestamp, nor the other way round', async () => {
  // tests/transcript-time.test.tsx selects every `span[title]` as a
  // timestamp. The model label carries a title too, so the two must stay
  // distinguishable or that file starts measuring this one.
  n = 0
  const container = await render([
    msg({ type: 'prompt', payload: { text: 'go' } }),
    assistant('claude-opus-5', 'All fixes landed.'),
    result(),
  ])

  const titled = [...container.querySelectorAll('span[title]')] as HTMLElement[]
  const modelTitles = labels(container)
  expect(modelTitles).toHaveLength(1)
  // The title is the translated label, interpolated with this row's model —
  // not the bare key and not an uninterpolated "{{model}}".
  expect(modelTitles[0]?.getAttribute('title')).toBe('Model: claude-opus-5')
  for (const stamp of titled) {
    if (modelTitles.includes(stamp)) continue
    // Every other titled span is a clock.
    expect(stamp.textContent).toMatch(/^\d{2}\D\d{2}$/)
  }
})

// --- the gap between the two rendering paths -------------------------------------

test('a collapsed assistant row with a model but an unparsable time still shows the model', async () => {
  // The answer branch renders its meta wrapper when *either* a time or a
  // model is present. The collapsed branch gates the whole slot on the time
  // alone, so the same message loses its model here — the row it appears on
  // should not decide whether the label exists.
  n = 0
  const container = await render([
    assistant('claude-opus-5', 'reading the schema', { createdAt: 'not-a-date' }),
    assistant('claude-opus-5', 'still reading', { createdAt: 'not-a-date' }),
  ])

  const [first] = rows(container)
  if (!first) throw new Error('expected a collapsed row')
  expect(models(first)).toEqual(['claude-opus-5'])
})
