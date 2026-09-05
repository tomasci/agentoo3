import { plugin } from 'bun'
import { expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// `Transcript` pulls in the whole `@/shared/ui` barrel, which means importing
// it here also loads the ten `.module.scss` files `ui-core.test.tsx` owns. That
// file installs an identity-proxy loader for them at its own module scope, and
// `bun test` does not evaluate files in a documented order — so whichever of
// the two files runs first decides how those modules are cached for the whole
// run, and ui-core's class-name assertions fail whenever this one wins.
// Registering the identical loader here makes the outcome the same either way;
// it is a no-op when ui-core happens to get there first. (Keep the allowlist in
// step with the one in tests/ui-core.test.tsx.)
const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'transcript-time-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

// Dynamic, so the loader above is registered before the barrel resolves.
const { buildTranscript } = await import('../src/features/sessions/lib/transcript')
const { Transcript } = await import('../src/features/sessions/components/transcript')

/**
 * The timestamp on a transcript row, exercised through the rendered DOM rather
 * than through the formatter alone: "renders nothing for a bad createdAt" is a
 * claim about markup (no empty span, no stray separator), and the nested rows
 * inside a task group only exist once the group is opened.
 */

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
    createdAt: '',
    ...o,
  }) as M

const text = (t: string) => ({ message: { content: [{ type: 'text', text: t }] } })

/** A full turn: prompt, a delegation with one nested step, the reply, the result. */
const turn = (at: (i: number) => string) => {
  n = 0
  return [
    msg({ type: 'prompt', payload: { text: 'build it' }, createdAt: at(0) }),
    msg({
      type: 'system',
      title: 'architect: design the runner',
      createdAt: at(1),
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
      title: 'architect: reading schema',
      createdAt: at(2),
      payload: text('looking'),
    }),
    msg({ type: 'assistant', title: 'orchestrator: replying', createdAt: at(3), payload: text('done') }),
    msg({ type: 'result', title: 'Turn complete', createdAt: at(4), payload: { subtype: 'success' } }),
  ]
}

/** Mounted for real: a closed Collapsible unmounts its children, so nested rows
 *  are not in the markup until the group is clicked open. */
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

/** Every rendered timestamp: `Timestamp` is the only thing here with a title. */
const stamps = (el: Element) => [...el.querySelectorAll('span[title]')] as HTMLElement[]
const times = (el: Element) => stamps(el).map((s) => s.textContent)

/** The transcript's top-level rows, in order.
 *
 * Each is now wrapped in its own `.row` div — the `content-visibility`
 * containment boundary that keeps the composer's forced layout from scoping
 * over the whole transcript — so this unwraps one level to hand back what it
 * always did: the node's own root element (a Collapsible, the prompt bubble,
 * the answer block), not the wrapper around it. */
const rows = (container: Element) =>
  [...(container.firstElementChild?.children ?? [])].map((row) => row.firstElementChild as HTMLElement)

/** HH:MM in the local zone, computed without Intl so the expectation is not
 *  the implementation restated. */
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Digits only, so a locale that separates hours with U+2236 still compares. */
const digits = (s: string | null) => s?.replace(/\D/g, '') ?? ''

const AT = (i: number) => `2026-09-04T1${i}:0${i}:00Z`

// --- 1. every row kind, including nested ones ---------------------------------

test('all four row kinds render a time, nested rows included', async () => {
  const container = await render(turn(AT))
  await openAll(container)

  const [prompt, task, answer, result] = rows(container)
  if (!prompt || !task || !answer || !result) throw new Error('expected four top-level rows')

  // Shapes, so the rest of the assertions are about the row they claim to be.
  expect(prompt.textContent).toContain('build it')
  expect(task.getAttribute('data-scope')).toBe('collapsible')
  expect(answer.textContent).toContain('done')
  expect(result.getAttribute('data-scope')).toBe('collapsible')

  expect(times(prompt)).toEqual([hhmm(AT(0))])
  expect(times(answer)).toEqual([hhmm(AT(3))])
  expect(times(result)).toEqual([hhmm(AT(4))])

  // The task group's own time, then the nested step's — two stamps, in order.
  expect(task.textContent).toContain('architect: reading schema')
  expect(times(task)).toEqual([hhmm(AT(1)), hhmm(AT(2))])
})

test('the nested row is genuinely inside the task group, not a sibling', async () => {
  const container = await render(turn(AT))
  await openAll(container)
  const task = rows(container)[1]
  if (!task) throw new Error('no task row')

  const nested = triggers(task).find((b) => b.textContent?.includes('reading schema'))
  if (!nested) throw new Error('nested row not rendered')
  expect(times(nested)).toEqual([hhmm(AT(2))])
})

test('the nested row is hidden until the group is opened, then shown', async () => {
  // Ark keeps the content mounted on first render and hides it, so the nested
  // row is in the markup while closed. What must change on click is whether it
  // is exposed: `hidden` on the content, `aria-expanded` on the trigger.
  const container = await render(turn(AT))
  const task = rows(container)[1]
  if (!task) throw new Error('no task row')

  const content = task.querySelector(':scope > [data-part="content"]') as HTMLElement | null
  if (!content) throw new Error('no collapsible content')
  expect(content.textContent).toContain('reading schema')
  expect(content.hasAttribute('hidden')).toBe(true)
  expect(triggers(task)[0]?.getAttribute('aria-expanded')).toBe('false')

  await openAll(container)
  expect(content.hasAttribute('hidden')).toBe(false)
  expect(triggers(task)[0]?.getAttribute('aria-expanded')).toBe('true')
})

// --- 2. unparsable createdAt renders nothing ----------------------------------

for (const bad of ['', 'not-a-date', 'NaN', '2026-13-45T99:99:99Z', 'Invalid Date']) {
  test(`createdAt ${JSON.stringify(bad)} renders no time and no empty slot`, async () => {
    const container = await render(turn(() => bad))
    await openAll(container)

    expect(new Date(bad).getTime()).toBeNaN()
    expect(stamps(container)).toHaveLength(0)
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Invalid Date')
    expect(container.textContent).not.toContain('NaN')
    expect(container.textContent).not.toContain('null')
    expect(container.textContent).not.toContain('undefined')

    const [prompt, task, answer, result] = rows(container)
    if (!prompt || !task || !answer || !result) throw new Error('expected four top-level rows')

    // The prompt caption keeps only its "you" label — no second, empty span.
    const caption = prompt.firstElementChild
    expect(caption?.children).toHaveLength(1)

    // The answer keeps only its markdown body.
    expect(answer.children).toHaveLength(1)

    // No `meta` span on either disclosure trigger: indicator, [badge,] title.
    const parts = (t: HTMLElement) => [...t.children].map((c) => c.getAttribute('data-part'))
    const resultTrigger = triggers(result)[0]
    const taskTrigger = triggers(task)[0]
    if (!resultTrigger || !taskTrigger) throw new Error('no trigger')
    expect(parts(resultTrigger)).toEqual(['indicator', null])
    expect(resultTrigger.children).toHaveLength(2)
    // The task trigger also carries its agent badge.
    expect(taskTrigger.children).toHaveLength(3)
  })
}

test('one bad createdAt does not suppress the good ones around it', async () => {
  const container = await render(turn((i) => (i === 3 ? 'not-a-date' : AT(i))))
  await openAll(container)
  expect(times(container)).toEqual([hhmm(AT(0)), hhmm(AT(1)), hhmm(AT(2)), hhmm(AT(4))])
})

// --- 3. the title attribute ---------------------------------------------------

test('the title attribute is a fuller timestamp than the visible text', async () => {
  const container = await render(turn(AT))
  await openAll(container)

  for (const stamp of stamps(container)) {
    const visible = stamp.textContent ?? ''
    const title = stamp.getAttribute('title') ?? ''
    expect(visible).toMatch(/^\d{2}\D\d{2}$/)
    // Strictly more than HH:MM, and carrying the date the visible text drops.
    expect(title.length).toBeGreaterThan(visible.length)
    expect(title).toContain(String(new Date(AT(0)).getFullYear()))
    expect(title).toContain(String(new Date(AT(0)).getDate()))
    expect(title).not.toBe(visible)
  }
})

test('the title attribute names the same instant as the visible text', async () => {
  const container = await render(turn(AT))
  const prompt = rows(container)[0]
  if (!prompt) throw new Error('no prompt row')
  const stamp = stamps(prompt)[0]
  if (!stamp) throw new Error('no timestamp')

  const d = new Date(AT(0))
  // Minutes must match; the hour may be re-expressed in a 12-hour clock, so it
  // is checked against both readings rather than only the 24-hour one.
  expect(stamp.getAttribute('title')).toContain(String(d.getMinutes()).padStart(2, '0'))
  const h24 = d.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const title = stamp.getAttribute('title') ?? ''
  expect(new RegExp(`\\b(${h24}|${h12})\\b`).test(title)).toBe(true)
})

// --- 4. a long title must not push the time out ------------------------------

test('a very long row title keeps the time after it, both present', async () => {
  const long = `deploy ${'x'.repeat(600)} finished`
  n = 0
  const container = await render([
    msg({ type: 'assistant', title: long, createdAt: AT(1), payload: { tool: 1 } }),
  ])

  const trigger = triggers(container)[0]
  if (!trigger) throw new Error('no trigger')

  const kids = [...trigger.children]
  // indicator, title, meta — in that order, with nothing dropped.
  expect(kids).toHaveLength(3)
  expect(kids[0]?.getAttribute('data-part')).toBe('indicator')
  expect(kids[1]?.textContent).toBe(long)
  expect(kids[2]?.textContent).toBe(hhmm(AT(1)))

  // The time is a sibling of the title, not inside it: an overflowing title
  // with `text-overflow: ellipsis` would clip anything nested in it.
  expect(kids[1]?.contains(kids[2] as Node)).toBe(false)
})

test('the stylesheet gives the title the ellipsis and the meta slot a fixed width', async () => {
  // happy-dom does no layout, so the visual truncation itself cannot be
  // asserted here; what is checkable is that the rules the layout depends on
  // are declared on the two slots the DOM test above pins down.
  const scss = await Bun.file('src/shared/ui/disclosure/collapsible.module.scss').text()
  const block = (name: string) => scss.match(new RegExp(`\\.${name}\\s*\\{[^}]*\\}`))?.[0] ?? ''
  expect(block('title')).toContain('text-overflow: ellipsis')
  expect(block('title')).toContain('min-width: 0')
  expect(block('title')).toContain('flex: 1')
  expect(block('meta')).toContain('flex: none')
  expect(block('trigger')).toContain('display: flex')
})

// --- 5. buildTranscript carries createdAt onto every node kind ----------------

test('buildTranscript puts createdAt on prompt, event, task and answer nodes', () => {
  const nodes = buildTranscript(turn(AT))
  expect(nodes.map((x) => x.kind)).toEqual(['prompt', 'task', 'answer', 'event'])
  expect(nodes.map((x) => x.createdAt)).toEqual([AT(0), AT(1), AT(3), AT(4)])

  const task = nodes[1]
  if (task?.kind !== 'task') throw new Error('expected a task node')
  expect(task.children.map((c) => c.createdAt)).toEqual([AT(2)])
})

test('the answer keeps its own message createdAt through the markAnswers rebuild', () => {
  // The answer node is not built in the main loop: markAnswers replaces an
  // already-built `event` with it, so the original message's time has to
  // survive the rebuild rather than be dropped or picked up from the result.
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'prompt', payload: { text: 'go' }, createdAt: '2026-01-01T08:00:00Z' }),
    msg({
      type: 'assistant',
      title: 'orchestrator: replying',
      createdAt: '2026-01-01T09:30:00Z',
      payload: text('the answer'),
    }),
    msg({ type: 'result', title: 'Turn complete', createdAt: '2026-01-01T23:59:00Z', payload: {} }),
  ])

  const answer = nodes[1]
  if (answer?.kind !== 'answer') throw new Error('expected an answer node')
  expect(answer.createdAt).toBe('2026-01-01T09:30:00Z')
  // Not the result's time, and not the prompt's.
  expect(answer.createdAt).not.toBe('2026-01-01T23:59:00Z')
  expect(answer.createdAt).not.toBe('2026-01-01T08:00:00Z')
})

test('an answer with an unparsable createdAt still becomes an answer node', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'assistant', title: 'reply', createdAt: '', payload: text('body') }),
    msg({ type: 'result', title: 'Turn complete', createdAt: '', payload: {} }),
  ])
  expect(nodes[0]?.kind).toBe('answer')
  expect(nodes[0]?.createdAt).toBe('')
})

// --- 6. clock sanity ----------------------------------------------------------

test('midnight renders as 00:MM, never 24:MM', async () => {
  const { formatTime } = await import('../src/features/sessions/lib/format')
  const local = new Date()
  local.setHours(0, 5, 0, 0)
  const out = formatTime(local.toISOString())
  expect(digits(out)).toBe('0005')
  expect(out?.startsWith('24')).toBe(false)
})

test('a known instant renders the local hour, in any zone the host is set to', async () => {
  const { formatTime } = await import('../src/features/sessions/lib/format')
  const iso = '2026-09-04T14:32:00Z'
  // hhmm() reads the Date's own local getters — a different code path from
  // Intl, so this is a real cross-check rather than the formatter restated.
  expect(digits(formatTime(iso))).toBe(digits(hhmm(iso)))
})

test('the formatter holds up under explicit zones, including half-hour ones', () => {
  // A subprocess per zone: TZ has to be set before format.ts builds its
  // module-level Intl.DateTimeFormat, and mutating it in-process would leak
  // into every other test file in this run.
  const script = `
    const { formatTime } = await import('${process.cwd()}/src/features/sessions/lib/format.ts')
    const midnight = new Date(); midnight.setHours(0, 5, 0, 0)
    const known = new Date('2026-09-04T14:32:00Z')
    const pad = (n) => String(n).padStart(2, '0')
    console.log(JSON.stringify({
      midnight: formatTime(midnight.toISOString()),
      known: formatTime(known.toISOString()),
      expected: pad(known.getHours()) + ':' + pad(known.getMinutes()),
      bad: formatTime('not-a-date'),
    }))
  `
  for (const tz of ['UTC', 'Asia/Kolkata', 'Pacific/Chatham', 'America/New_York', 'Pacific/Kiritimati']) {
    const run = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, TZ: tz } })
    const stdout = run.stdout.toString().trim()
    if (!run.success) throw new Error(`${tz}: ${run.stderr.toString()}`)
    const got = JSON.parse(stdout) as Record<string, string | null>
    expect({ tz, ...got }).toEqual({
      tz,
      midnight: '00:05',
      known: got.expected as string,
      expected: got.expected as string,
      bad: null,
    })
    expect(got.known).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
  }
}, 30_000)

// --- boundary cases the type forbids but the wire can still produce ----------

test('a message that arrives with no createdAt at all renders, without a time', async () => {
  // `createdAt: string` is not optional in the generated type, but it arrives
  // as JSON from the backend and nothing parses it at the boundary, so a row
  // missing the field must degrade rather than throw.
  n = 0
  const withoutCreatedAt = { ...msg({ type: 'prompt', payload: { text: 'go' } }) } as Record<
    string,
    unknown
  >
  delete withoutCreatedAt.createdAt

  const container = await render([withoutCreatedAt as unknown as M])
  expect(container.textContent).toContain('go')
  expect(stamps(container)).toHaveLength(0)
  expect(container.textContent).not.toContain('Invalid Date')
})

test('a task nested inside a task carries a time at every depth', async () => {
  n = 0
  const started = (toolUseId: string, taskId: string, parent: string | null, at: string) =>
    msg({
      type: 'system',
      parentToolUseId: parent,
      title: `${taskId}: work`,
      createdAt: at,
      payload: {
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: toolUseId,
        subagent_type: 'architect',
        description: `${taskId} work`,
      },
    })

  const container = await render([
    started('tu1', 't1', null, AT(1)),
    started('tu2', 't2', 'tu1', AT(2)),
    msg({
      type: 'assistant',
      parentToolUseId: 'tu2',
      title: 'deep step',
      createdAt: AT(3),
      payload: text('deep'),
    }),
  ])
  await openAll(container)

  const outer = rows(container)[0]
  if (!outer) throw new Error('no outer task')
  expect(outer.textContent).toContain('deep step')
  expect(times(outer)).toEqual([hhmm(AT(1)), hhmm(AT(2)), hhmm(AT(3))])
})
