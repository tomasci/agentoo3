// A window that starts mid-task, and what happens to it as older pages load.
//
// Measured against a real session (see this change's own report): a window
// whose oldest loaded message sits inside a still-open delegation used to
// flatten every one of that delegation's messages to the top level — the
// `task_started` that would have grouped them lives on an older, not-yet-
// fetched page. The moment that page loaded, all of those top-level rows
// collapsed into the single row they were always meant to be, right under
// the reader: on the real session this measured against, one page prepend
// dropped the top-level row count by 187. These tests pin the fix: such a
// window renders one collapsed *partial* group instead of N flattened rows,
// and prepending the page that completes it upgrades that same row in place
// rather than swapping it for a different one.

import { expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { i18n } from '@/shared/i18n'
import { Transcript } from '../src/features/sessions/components/transcript'
import { buildTranscript } from '../src/features/sessions/lib/transcript'

// Pinned so the DOM assertion at the bottom of this file checks the English
// copy actually in en.json, whatever the host's own locale is — same
// reasoning as tests/transcript-model-render.test.tsx.
await i18n.changeLanguage('en')

type M = Parameters<typeof buildTranscript>[0][number]
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

const tasks = (nodes: ReturnType<typeof buildTranscript>) =>
  nodes.filter((node): node is Extract<typeof node, { kind: 'task' }> => node.kind === 'task')

test('a window that starts mid-task collapses into one partial group, not N flattened rows', () => {
  n = 0
  // task_started for tu1 is on an older page this window has not loaded; both
  // of its subagent's own messages are already here.
  const nodes = buildTranscript([
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading schema' }),
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: writing the design' }),
    msg({ type: 'assistant', title: 'orchestrator: applying it' }),
  ])

  expect(nodes.map((node) => node.kind)).toEqual(['task', 'event'])
  const [group] = tasks(nodes)
  if (!group) throw new Error('expected a partial task group')
  expect(group.partial).toBe(true)
  // Named from the tool_use_id every child actually carries, not from
  // whichever message happened to create the group — see taskNodeId.
  expect(group.id).toBe('task:tu1')
  expect(group.children.map((c) => (c.kind === 'event' ? c.message.title : c.kind))).toEqual([
    'architect: reading schema',
    'architect: writing the design',
  ])
})

test('prepending the page that contains task_started upgrades the same row in place, and the row count does not drop', () => {
  n = 0
  const started = msg({
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
  })
  const child1 = msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading schema' })
  const child2 = msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: writing the design' })
  const reply = msg({ type: 'assistant', title: 'orchestrator: applying it' })

  // The window before the scroll-up: task_started has already scrolled off
  // the loaded page.
  const before = buildTranscript([child1, child2, reply])
  expect(before.length).toBe(2)
  const partialId = before[0]?.id

  // The reader scrolls further up, the older page loads, and use-sessions.ts
  // rebuilds the tree from the whole, now-bigger window.
  const after = buildTranscript([started, child1, child2, reply])
  expect(after.length).toBe(before.length)
  const [group] = tasks(after)
  if (!group) throw new Error('expected a real task group')
  expect(group.partial).toBe(false)
  // Same id as the partial row it replaces — the property that keeps the DOM
  // element, and the reader's scroll anchor, in place.
  expect(group.id).toBe(partialId)
  expect(group.agent).toBe('architect')
  expect(group.children.length).toBe(2)
})

test("a nested task_started whose own parent is unknown joins the parent's partial group", () => {
  n = 0
  // tu-outer's own task_started is not in the window; the inner delegation
  // (tu-inner) is, and names tu-outer as its parent.
  const nodes = buildTranscript([
    msg({
      type: 'system',
      parentToolUseId: 'tu-outer',
      title: 'helper: dig',
      payload: {
        subtype: 'task_started',
        task_id: 't2',
        tool_use_id: 'tu-inner',
        subagent_type: 'helper',
        description: 'dig',
      },
    }),
    msg({ type: 'assistant', parentToolUseId: 'tu-inner', title: 'helper: grepping' }),
  ])

  expect(nodes.length).toBe(1)
  const [outer] = tasks(nodes)
  if (!outer) throw new Error('expected the outer partial group')
  expect(outer.partial).toBe(true)
  expect(outer.id).toBe('task:tu-outer')
  const inner = outer.children[0]
  if (inner?.kind !== 'task') throw new Error('expected the inner real group')
  expect(inner.partial).toBe(false)
  expect(inner.agent).toBe('helper')
  expect(inner.children.length).toBe(1)
})

test('an ambient task_started keeps its children flattened, same as before partial groups existed', () => {
  n = 0
  const nodes = buildTranscript([
    msg({
      type: 'system',
      payload: { subtype: 'task_started', tool_use_id: 'tu-a', task_id: 't-a', ambient: true },
    }),
    msg({ type: 'assistant', parentToolUseId: 'tu-a', title: 'x: work' }),
  ])
  expect(nodes.length).toBe(1)
  expect(nodes[0]?.kind).toBe('event')
})

test('a skip_transcript task_started keeps its children flattened, same as before partial groups existed', () => {
  n = 0
  const nodes = buildTranscript([
    msg({
      type: 'system',
      payload: { subtype: 'task_started', tool_use_id: 'tu-b', task_id: 't-b', skip_transcript: true },
    }),
    msg({ type: 'assistant', parentToolUseId: 'tu-b', title: 'y: work' }),
  ])
  expect(nodes.length).toBe(1)
  expect(nodes[0]?.kind).toBe('event')
})

test("a task_progress ping names a partial group's agent and title before task_started ever loads", () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading' }),
    msg({
      type: 'system',
      payload: {
        subtype: 'task_progress',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'investigate',
        last_tool_name: 'Bash',
      },
    }),
  ])
  const [group] = tasks(nodes)
  if (!group) throw new Error('expected a task group')
  // Still partial — task_started itself has not loaded — but no longer
  // nameless: the ping is the more authoritative source until that message
  // shows up.
  expect(group.partial).toBe(true)
  expect(group.agent).toBe('architect')
  expect(group.title).toBe('investigate')
  expect(group.progress).toBe('Bash')
})

test('a task_notification resolves a partial group by tool_use_id, and teaches it the taskId a later task_updated needs', () => {
  n = 0
  const nodes = buildTranscript([
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading' }),
    msg({
      type: 'system',
      payload: { subtype: 'task_notification', task_id: 't1', tool_use_id: 'tu1', status: 'completed' },
    }),
    // task_updated carries only task_id, never a tool_use_id — this only
    // resolves because the notification above just registered t1 -> group.
    msg({ type: 'system', payload: { subtype: 'task_updated', task_id: 't1', patch: { status: 'failed' } } }),
  ])
  const [group] = tasks(nodes)
  if (!group) throw new Error('expected a task group')
  expect(group.status).toBe('failed')
})

test("a subagent's assistant text is never promoted to the answer while its task_started has not loaded", () => {
  n = 0
  const nodes = buildTranscript([
    msg({
      type: 'assistant',
      parentToolUseId: 'tu1',
      title: 'architect: replying',
      payload: { message: { content: [{ type: 'text', text: 'nested reply' }] } },
    }),
    msg({ type: 'result', title: 'Turn complete', payload: { subtype: 'success' } }),
  ])
  // Before partial groups, this message flattened into `roots` and was
  // eligible for markAnswers to mistake for the orchestrator's own closing
  // reply. Nested inside its (partial) group, it never is.
  expect(nodes.some((node) => node.kind === 'answer')).toBe(false)
})

test('task_started upgrades an existing partial group in place rather than creating a second one', () => {
  n = 0
  // Built so the child is processed before task_started (see buildTranscript
  // — a `tool_use_id`/`task_id` pair is only ever supposed to arrive this way
  // across two builds, once an older page loads; this exercises the same
  // upgrade-in-place branch defensively, within a single build).
  const child = msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading' })
  const started = msg({
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
  })

  const nodes = buildTranscript([child, started])
  expect(nodes.length).toBe(1)
  const [group] = tasks(nodes)
  if (!group) throw new Error('expected exactly one task group')
  expect(group.partial).toBe(false)
  expect(group.agent).toBe('architect')
  expect(group.prompt).toBe('Design it.')
  expect(group.children.length).toBe(1)
})

// --- the rendered row, not just the tree buildTranscript returns -----------

async function render(messages: M[]) {
  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(<Transcript messages={messages} />)
  })
  return container
}

const trigger = (el: Element) =>
  el.querySelector('button[data-slot="collapsible-trigger"]') as HTMLElement

/** The tone dot inside a badge is `StatusDot`'s own `aria-hidden` span — see
 * `shared/components/status-dot.tsx`. Asserted by the class that carries the
 * tone's meaning rather than by a screenshot: `bg-primary` is 'accent',
 * `bg-muted-foreground` is 'neutral', and no row here has any other tone to
 * confuse the two with. */
const dot = (el: Element) => el.querySelector('[aria-hidden="true"].rounded-full') as HTMLElement

test('a fully unknown partial group renders a neutral badge and a translated placeholder, not the running accent', async () => {
  n = 0
  const container = await render([
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading schema' }),
  ])
  const row = trigger(container)
  const pendingLabel = i18n.t('sessions.transcript.pendingTask')

  expect(row.textContent).toContain(pendingLabel)
  expect(dot(container)?.classList.contains('bg-muted-foreground')).toBe(true)
  expect(dot(container)?.classList.contains('bg-primary')).toBe(false)
  // No prompt section: nothing here claims to know what was asked for.
  expect(container.textContent).not.toContain(
    i18n.t('sessions.transcript.delegatedPrompt', { agent: pendingLabel }),
  )
})

test('a task_progress ping that names the agent switches the row back to the normal running accent', async () => {
  n = 0
  const container = await render([
    msg({ type: 'assistant', parentToolUseId: 'tu1', title: 'architect: reading' }),
    msg({
      type: 'system',
      payload: {
        subtype: 'task_progress',
        task_id: 't1',
        tool_use_id: 'tu1',
        subagent_type: 'architect',
        description: 'investigate',
      },
    }),
  ])
  const row = trigger(container)
  expect(row.textContent).toContain('architect')
  expect(row.textContent).toContain('investigate')
  expect(dot(container)?.classList.contains('bg-primary')).toBe(true)
})
