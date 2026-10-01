// Prompts rendered as markdown (with single-newline breaks), AI text left on
// CommonMark's own rules, and the icon-only copy button on every message with
// text — all through the rendered `Transcript`, not the parts in isolation.
//
// Rendered under a private `cimode` i18next instance (i18next's
// always-return-the-key mode), the same isolation as
// tests/shared-components.test.tsx and tests/transcript-attachments.test.tsx:
// the copy button's accessible name is asserted as the raw key
// (`common.copy` / `common.copied`) whatever file order the run happens to
// use. Never `.use(initReactI18next)` on it — see tests/settings-page.test.tsx.
//
// Clipboard: both paths are driven explicitly. `navigator.clipboard` is
// replaced per test with an own property and the original descriptor put back
// afterwards; `document.execCommand` likewise. Nothing here touches the real
// system clipboard.

import { afterEach, expect, test } from 'bun:test'
import i18next from 'i18next'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { CopyButton } from '@/shared/components'
import { Transcript } from '../src/features/sessions/components/transcript'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

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
const prompt = (t: string, o: Partial<M> = {}) => msg({ type: 'prompt', payload: { text: t }, ...o })
const reply = (t: string, o: Partial<M> = {}) =>
  msg({ type: 'assistant', title: 'orchestrator: replying', payload: text(t), ...o })
const result = () => msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } })

let root: Root | undefined
let host: HTMLElement | undefined

async function mount(ui: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>)
  })
  return host
}

const render = (messages: M[]) => mount(<Transcript messages={messages} sessionId="s1" />)

// --- clipboard doubles ---------------------------------------------------------

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true })
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  // An own property shadows the prototype's getter; deleting it restores it.
  // A fallback that failed mid-way can leave its textarea in <body> (see the
  // execCommand tests below); clear it so it cannot leak into the next test's
  // "exactly one textarea at copy time" check.
  for (const el of document.querySelectorAll('body > textarea')) el.remove()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else delete (navigator as { clipboard?: unknown }).clipboard
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor)
  else delete (document as { execCommand?: unknown }).execCommand
})

/** Mocked async clipboard: records every write. */
function mockWriteText(impl?: (v: string) => Promise<void>) {
  const writes: string[] = []
  setClipboard({
    writeText: (v: string) => {
      writes.push(v)
      return impl ? impl(v) : Promise.resolve()
    },
  })
  return writes
}

/** No async clipboard (plain HTTP): the execCommand fallback must run. Records
 *  what was in the DOM at the moment `copy` was issued. */
function mockExecCommand() {
  setClipboard(undefined)
  const calls: {
    command: string
    textareas: { value: string; inBody: boolean; selected: string; readonly: boolean }[]
  }[] = []
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: (command: string) => {
      calls.push({
        command,
        textareas: ([...document.querySelectorAll('textarea')] as HTMLTextAreaElement[]).map((el) => ({
          value: el.value,
          inBody: el.parentElement === document.body,
          selected: el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
          readonly: el.hasAttribute('readonly'),
        })),
      })
      return true
    },
  })
  return calls
}

// --- DOM helpers ---------------------------------------------------------------

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

/** Top-level rows, unwrapped from their `data-transcript-row` div. */
const rows = (container: Element) =>
  [...container.querySelectorAll('[data-transcript-row]')].map(
    (row) => row.firstElementChild as HTMLElement,
  )

/** Every button whose accessible name (aria-label) is `name`. */
const named = (el: Element, name: string) =>
  [...el.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === name)
const copyButtons = (el: Element) => named(el, 'common.copy')

async function click(button: HTMLElement) {
  await act(async () => {
    button.click()
    // writeText's promise, then the state update.
    await Promise.resolve()
    await Promise.resolve()
  })
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

function only<T>(xs: T[], what: string): T {
  if (xs.length !== 1) throw new Error(`expected exactly one ${what}, got ${xs.length}`)
  return xs[0] as T
}

const SOURCE = '**bold**\nsecond line'
const ANSWER_SOURCE = '# Done\n\n- [x] item one\n- `code` two\n\nline a\nline b'
const EVENT_SOURCE = 'Reading `schema.ts`\nthen _deciding_'

/** A prompt, an event row with text (a reply that is NOT the turn's last), and
 *  the answer — each holding markdown with newlines. */
const turn = () => {
  n = 0
  return [
    prompt(SOURCE),
    msg({ type: 'assistant', title: 'orchestrator: thinking aloud', payload: text(EVENT_SOURCE) }),
    msg({
      type: 'assistant',
      title: 'orchestrator: running tools',
      payload: { message: { content: [{ type: 'tool_use', id: 'tu-x', name: 'Bash', input: {} }] } },
    }),
    reply(ANSWER_SOURCE),
    result(),
  ]
}

// --- 1. prompts render as markdown, with single-newline breaks -----------------

test('a prompt renders bold and turns a single newline into a <br>', async () => {
  n = 0
  const container = await render([prompt(SOURCE)])
  const bubble = only(rows(container), 'prompt row')

  const strong = [...bubble.querySelectorAll('strong')]
  expect(strong.map((s) => s.textContent)).toEqual(['bold'])
  expect(bubble.querySelectorAll('br')).toHaveLength(1)
  // The <br> sits between the two lines, inside the same paragraph.
  const p = only([...bubble.querySelectorAll('p')], 'paragraph')
  expect(p.innerHTML).toBe('<strong>bold</strong><br>\nsecond line')
  expect(bubble.textContent).not.toContain('**')
})

test('a prompt renders a fenced code block, a list and a new-tab link', async () => {
  n = 0
  const source = [
    'see [the docs](https://example.com/docs) first',
    '',
    '- one',
    '- two',
    '',
    '```ts',
    'const x = 1',
    'const y = 2',
    '```',
  ].join('\n')
  const container = await render([prompt(source)])
  const bubble = only(rows(container), 'prompt row')

  const a = only([...bubble.querySelectorAll('a')], 'link')
  expect(a.getAttribute('href')).toBe('https://example.com/docs')
  expect(a.getAttribute('target')).toBe('_blank')
  expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  expect(a.textContent).toBe('the docs')

  expect([...bubble.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['one', 'two'])

  const pre = only([...bubble.querySelectorAll('pre')], 'code block')
  // The fence keeps its own newline: `breaks` does not inject <br> into code.
  expect(pre.querySelector('code')?.textContent).toBe('const x = 1\nconst y = 2\n')
  expect(pre.querySelectorAll('br')).toHaveLength(0)
})

test('raw HTML typed in a prompt is never rendered as live elements', async () => {
  n = 0
  const source = [
    '<img src=x onerror=alert(1)>',
    '',
    '<script>alert(2)</script>',
    '',
    'inline <b onclick="alert(3)">bold?</b> and <iframe src="https://evil.example"></iframe>',
    '',
    '[click](javascript:alert(4))',
  ].join('\n')
  const container = await render([prompt(source)])
  const bubble = only(rows(container), 'prompt row')

  expect(bubble.querySelectorAll('img, script, iframe, b')).toHaveLength(0)
  // No element anywhere in the bubble carries an inline event handler.
  const handlers = [...bubble.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].filter((a) => a.name.startsWith('on')).map((a) => a.name),
  )
  expect(handlers).toEqual([])
  // A javascript: URL is not kept as a navigable href.
  for (const a of bubble.querySelectorAll('a')) {
    expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i)
  }
})

test('a long unbroken token in a prompt sits under a wrap-anywhere box', async () => {
  // Same contract tests/transcript-overflow.test.tsx pins on tool names:
  // `wrap-anywhere` (overflow-wrap: anywhere, which changes min-content), not
  // `break-words`. The bubble lost `whitespace-pre-wrap` in this change; the
  // wrap rule itself must survive it.
  n = 0
  const LONG = `/very/long/${'segment'.repeat(40)}/path.txt`
  const container = await render([prompt(`look at ${LONG}`)])
  const bubble = only(rows(container), 'prompt row')

  const p = only([...bubble.querySelectorAll('p')], 'paragraph')
  expect(p.textContent).toBe(`look at ${LONG}`)
  // Walk up from the paragraph: some ancestor inside the bubble (or the bubble
  // itself) declares wrap-anywhere, and nothing on the way overrides it.
  const chain: Element[] = []
  for (let el: Element | null = p; el && el !== bubble.parentElement; el = el.parentElement) chain.push(el)
  expect(chain).toContain(bubble)
  expect(chain.some((el) => el.classList.contains('wrap-anywhere'))).toBe(true)
  expect(chain.some((el) => el.classList.contains('break-words'))).toBe(false)
  expect(chain.some((el) => el.classList.contains('whitespace-nowrap'))).toBe(false)
  expect(chain.some((el) => el.classList.contains('truncate'))).toBe(false)
})

// --- 2. AI text keeps CommonMark's rule: one newline is not a <br> ------------

test('an answer "a\\nb" renders no <br>', async () => {
  n = 0
  const container = await render([prompt('go'), reply('a\nb'), result()])
  const answer = rows(container)[1]
  if (!answer) throw new Error('no answer row')
  expect(answer.textContent).toContain('a\nb')
  expect(answer.querySelectorAll('br')).toHaveLength(0)
})

test('an event row "a\\nb", its thinking, and a delegated task prompt render no <br>', async () => {
  n = 0
  const container = await render([
    msg({ type: 'assistant', title: 'event with text', payload: text('a\nb') }),
    msg({
      type: 'assistant',
      title: 'event with thinking',
      payload: { message: { content: [{ type: 'thinking', thinking: 'c\nd' }] } },
    }),
    msg({
      type: 'system',
      title: 'architect: design',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'design',
        prompt: 'e\nf',
      },
    }),
  ])
  await openAll(container)
  const [event, thinking, task] = rows(container)
  if (!event || !thinking || !task) throw new Error('expected three rows')

  expect(event.textContent).toContain('a\nb')
  expect(thinking.textContent).toContain('c\nd')
  expect(task.textContent).toContain('e\nf')
  expect(container.querySelectorAll('br')).toHaveLength(0)
})

// --- 3. one copy button per message with text --------------------------------

test('prompt, answer and an event row with text each expose exactly one copy button', async () => {
  const container = await render(turn())
  await openAll(container)
  const [p, event, tools, answer, res] = rows(container)
  if (!p || !event || !tools || !answer || !res) throw new Error('expected five rows')

  expect(copyButtons(p)).toHaveLength(1)
  expect(copyButtons(event)).toHaveLength(1)
  expect(copyButtons(answer)).toHaveLength(1)
  // A tool-call-only row and the result row have no text, so no button.
  expect(copyButtons(tools)).toHaveLength(0)
  expect(copyButtons(res)).toHaveLength(0)
  expect(copyButtons(container)).toHaveLength(3)
})

test('the compact button is icon-only, named by aria-label and title alike', async () => {
  n = 0
  const container = await render([prompt(SOURCE)])
  const button = only(copyButtons(container), 'copy button')
  expect(button.getAttribute('type')).toBe('button')
  expect(button.getAttribute('title')).toBe('common.copy')
  expect(button.textContent).toBe('')
  expect(button.querySelector('svg')).not.toBeNull()
})

test('a task row exposes no copy button; its nested text step has its own', async () => {
  n = 0
  const container = await render([
    msg({
      type: 'system',
      title: 'architect: design',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'design',
        prompt: 'Design **it**.',
      },
    }),
  ])
  await openAll(container)
  const task = only(rows(container), 'task row')
  expect(task.textContent).toContain('Design it.')
  expect(copyButtons(container)).toHaveLength(0)

  // With a nested text step: exactly one button, and it is inside the step.
  n = 0
  const c2 = await render([
    msg({
      type: 'system',
      title: 'architect: design',
      payload: {
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'design',
        prompt: 'Design it.',
      },
    }),
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'nested step', payload: text('inner') }),
  ])
  await openAll(c2)
  const button = only(copyButtons(c2), 'copy button')
  const nestedTrigger = triggers(c2).find((b) => b.textContent?.includes('nested step'))
  const nestedRoot = nestedTrigger?.closest('[data-slot="collapsible"]')
  expect(nestedRoot?.contains(button)).toBe(true)
})

test('an attachment-only prompt (empty text) exposes no copy button', async () => {
  n = 0
  const container = await render([
    msg({
      type: 'prompt',
      payload: { text: '' },
      files: [
        { id: 'f1', originalFilename: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, status: 'ready' },
      ] as M['files'],
    }),
  ])
  const bubble = only(rows(container), 'prompt row')
  expect(bubble.textContent).toContain('a.txt')
  expect(copyButtons(bubble)).toHaveLength(0)
  expect(bubble.querySelectorAll('button[title]')).toHaveLength(0)
})

test('a prompt with no text field at all exposes no copy button either', async () => {
  n = 0
  const container = await render([msg({ type: 'prompt', payload: {} })])
  expect(copyButtons(container)).toHaveLength(0)
})

// --- 4. clicking copies the raw markdown source --------------------------------

async function copiedFrom(row: 'prompt' | 'event' | 'answer', path: 'clipboard' | 'exec') {
  const writes = path === 'clipboard' ? mockWriteText() : undefined
  const calls = path === 'exec' ? mockExecCommand() : undefined
  const container = await render(turn())
  await openAll(container)
  const [p, event, , answer] = rows(container)
  const target = { prompt: p, event, answer }[row]
  if (!target) throw new Error(`no ${row} row`)
  const button = only(copyButtons(target), 'copy button')
  await click(button)
  return { button, writes, calls, container, target }
}

const expected = { prompt: SOURCE, event: EVENT_SOURCE, answer: ANSWER_SOURCE } as const

for (const row of ['prompt', 'event', 'answer'] as const) {
  test(`${row}: navigator.clipboard.writeText gets the raw source, exactly once`, async () => {
    const { writes, button } = await copiedFrom(row, 'clipboard')
    expect(writes).toEqual([expected[row]])
    expect(button.getAttribute('aria-label')).toBe('common.copied')
    expect(button.getAttribute('title')).toBe('common.copied')
  })

  test(`${row}: with no navigator.clipboard, execCommand('copy') copies the raw source from a textarea that is then removed`, async () => {
    const { calls, button } = await copiedFrom(row, 'exec')
    expect(calls?.map((c) => c.command)).toEqual(['copy'])
    const ta = only(calls?.[0]?.textareas ?? [], 'textarea at copy time')
    expect(ta).toEqual({ value: expected[row], inBody: true, selected: expected[row], readonly: true })
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    expect(button.getAttribute('aria-label')).toBe('common.copied')
  })
}

test('the event row copy button does not toggle its disclosure', async () => {
  mockWriteText()
  const container = await render(turn())
  await openAll(container)
  const event = rows(container)[1]
  if (!event) throw new Error('no event row')
  await click(only(copyButtons(event), 'copy button'))
  expect(triggers(event)[0]?.getAttribute('aria-expanded')).toBe('true')
  // Not nested inside the trigger (a button in a button is invalid HTML).
  expect(named(event, 'common.copied')[0]?.closest('[data-slot="collapsible-trigger"]')).toBeNull()
})

test('the label reverts from common.copied to common.copy after ~1.5s, not before', async () => {
  mockWriteText()
  n = 0
  const container = await render([prompt(SOURCE)])
  const button = only(copyButtons(container), 'copy button')
  await click(button)
  expect(button.getAttribute('aria-label')).toBe('common.copied')
  await wait(1000)
  expect(button.getAttribute('aria-label')).toBe('common.copied')
  await wait(700)
  expect(button.getAttribute('aria-label')).toBe('common.copy')
  expect(button.getAttribute('title')).toBe('common.copy')
})

test('a rejected writeText leaves the label at common.copy', async () => {
  const writes = mockWriteText(() => Promise.reject(new Error('denied')))
  n = 0
  const container = await render([prompt(SOURCE)])
  const button = only(copyButtons(container), 'copy button')
  await click(button)
  await wait(20)
  expect(writes).toEqual([SOURCE])
  expect(button.getAttribute('aria-label')).toBe('common.copy')
})

/** Fallback path whose `execCommand` misbehaves in the given way. */
function brokenExecCommand(impl: () => boolean) {
  setClipboard(undefined)
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: impl })
}

test('a throwing execCommand fallback does not claim common.copied', async () => {
  brokenExecCommand(() => {
    throw new Error('blocked')
  })
  n = 0
  const container = await render([prompt(SOURCE)])
  const button = only(copyButtons(container), 'copy button')
  await click(button)
  await wait(20)
  expect(button.getAttribute('aria-label')).toBe('common.copy')
})

test('a throwing execCommand fallback still removes its hidden textarea', async () => {
  // The textarea holds the full value being copied (for the labelled
  // CopyButton elsewhere, e.g. a deploy key); one is appended per click, so a
  // failure must not leave it behind in <body>.
  brokenExecCommand(() => {
    throw new Error('blocked')
  })
  n = 0
  const container = await render([prompt(SOURCE)])
  await click(only(copyButtons(container), 'copy button'))
  await wait(20)
  expect(document.querySelectorAll('textarea')).toHaveLength(0)
})

test('an execCommand that reports failure (returns false) does not claim common.copied', async () => {
  // `document.execCommand` signals "not copied" by returning false rather than
  // throwing (no user activation, a sandboxed frame, a disabled command).
  brokenExecCommand(() => false)
  n = 0
  const container = await render([prompt(SOURCE)])
  const button = only(copyButtons(container), 'copy button')
  await click(button)
  await wait(20)
  expect(button.getAttribute('aria-label')).toBe('common.copy')
  expect(document.querySelectorAll('textarea')).toHaveLength(0)
})

// --- 5. the labelled (non-compact) CopyButton is unchanged ---------------------

test('the non-compact CopyButton still shows its visible label and no aria-label', async () => {
  const writes = mockWriteText()
  const container = await mount(<CopyButton value="ssh-ed25519 AAAA" label="Copy key" />)
  const button = only([...container.querySelectorAll('button')], 'button')
  expect(button.textContent).toBe('Copy key')
  expect(button.hasAttribute('aria-label')).toBe(false)
  expect(button.hasAttribute('title')).toBe(false)
  await click(button)
  expect(writes).toEqual(['ssh-ed25519 AAAA'])
  expect(button.textContent).toBe('common.copied')

  const c2 = await mount(<CopyButton value="x" />)
  expect(c2.querySelector('button')?.textContent).toBe('common.copy')
})

// --- 6. a bad createdAt still renders nothing stray ----------------------------

for (const bad of ['', 'not-a-date', 'NaN']) {
  test(`createdAt ${JSON.stringify(bad)}: prompt and answer show no Invalid Date/NaN/null/undefined`, async () => {
    n = 0
    const container = await render([
      prompt(SOURCE, { createdAt: bad }),
      reply('all **done**', { createdAt: bad }),
      result(),
    ])
    const [p, answer] = rows(container)
    if (!p || !answer) throw new Error('expected prompt and answer')
    for (const el of [p, answer]) {
      for (const junk of ['Invalid Date', 'NaN', 'null', 'undefined']) {
        expect(el.textContent).not.toContain(junk)
        expect(el.innerHTML).not.toContain(junk)
      }
      expect(el.querySelectorAll('span[title]')).toHaveLength(0)
      expect(copyButtons(el)).toHaveLength(1)
    }
    // With no time and no model, the meta groups hold the copy button and
    // nothing else — no empty slot where the timestamp would have been.
    const caption = p.firstElementChild
    expect(caption?.children).toHaveLength(2)
    expect([...(caption?.children[1]?.children ?? [])].map((c) => c.tagName)).toEqual(['BUTTON'])
    expect([...(answer.firstElementChild?.children ?? [])].map((c) => c.tagName)).toEqual(['BUTTON'])
    expect(p.querySelector('strong')?.textContent).toBe('bold')
    expect(answer.querySelector('strong')?.textContent).toBe('done')
  })
}
