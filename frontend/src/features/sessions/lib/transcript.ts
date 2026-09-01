import type { SessionMessage } from '../hooks/use-sessions'

/**
 * The transcript, as a tree.
 *
 * The SDK sends one flat, ordered stream, but delegated work is nested: every
 * message a subagent produces carries `parentToolUseId`, the id of the Task call
 * that started it. Grouping on that is what turns "everything that happened"
 * into something readable — the orchestrator's own steps at the top level, and
 * each delegation as one collapsible block holding the prompt it was given and
 * everything it did.
 */

export type TranscriptNode =
  | { kind: 'prompt'; id: string; seq: number; text: string }
  | { kind: 'event'; id: string; seq: number; message: SessionMessage }
  | {
      kind: 'task'
      id: string
      seq: number
      taskId: string
      agent: string
      title: string
      /** What the orchestrator actually asked for. The point of the whole tree. */
      prompt: string | null
      status: 'running' | 'completed' | 'failed' | 'killed'
      children: TranscriptNode[]
    }

type TaskNode = Extract<TranscriptNode, { kind: 'task' }>
type Payload = Record<string, unknown>

const str = (payload: Payload, key: string): string | undefined =>
  typeof payload[key] === 'string' ? (payload[key] as string) : undefined

/**
 * Library agents reach a session through the project's plugin, so the engine
 * names them `agentoo:scout` rather than `scout`. Every one of them carries the
 * same prefix, so it distinguishes nothing and is dropped for display.
 */
export const displayAgent = (name: string) => name.replace(/^agentoo:/, '')

export function buildTranscript(messages: SessionMessage[]): TranscriptNode[] {
  const roots: TranscriptNode[] = []
  // tool_use_id -> the group collecting that delegation's messages.
  const groups = new Map<string, TaskNode>()
  // task_id -> the same group, for the status patches that arrive later.
  const byTaskId = new Map<string, TaskNode>()

  const ordered = [...messages].sort((a, b) => a.seq - b.seq)

  /** Where a message belongs: inside its parent's group, or at the top. */
  const listFor = (parentToolUseId: string | null): TranscriptNode[] =>
    (parentToolUseId ? groups.get(parentToolUseId)?.children : undefined) ?? roots

  for (const message of ordered) {
    const payload = (message.payload ?? {}) as Payload
    const parent = message.parentToolUseId

    if (message.type === 'prompt') {
      roots.push({
        kind: 'prompt',
        id: message.id,
        seq: message.seq,
        text: str(payload, 'text') ?? '',
      })
      continue
    }

    if (payload.subtype === 'task_started') {
      // Housekeeping the engine runs for itself; the backend already declines
      // to title these, and they are not the user's work.
      if (payload.ambient === true || payload.skip_transcript === true) continue

      const toolUseId = str(payload, 'tool_use_id')
      const taskId = str(payload, 'task_id')
      const group: TaskNode = {
        kind: 'task',
        id: message.id,
        seq: message.seq,
        taskId: taskId ?? message.id,
        agent: displayAgent(str(payload, 'subagent_type') ?? 'subagent'),
        title: message.title ?? str(payload, 'description') ?? 'delegated task',
        prompt: str(payload, 'prompt') ?? null,
        status: 'running',
        children: [],
      }
      listFor(parent).push(group)
      if (toolUseId) groups.set(toolUseId, group)
      if (taskId) byTaskId.set(taskId, group)
      continue
    }

    if (payload.subtype === 'task_updated') {
      const taskId = str(payload, 'task_id')
      const patch = (payload.patch ?? {}) as Payload
      const status = str(patch, 'status')
      const group = taskId ? byTaskId.get(taskId) : undefined
      if (group && status && status !== 'pending' && status !== 'paused') {
        group.status = status as TaskNode['status']
      }
      // A status patch is not a transcript row of its own.
      continue
    }

    // Rows the backend declined to title carry nothing a reader needs: the
    // init handshake, tool results already shown under their call.
    if (!message.title) continue

    listFor(parent).push({ kind: 'event', id: message.id, seq: message.seq, message })
  }

  return roots
}

/** Text blocks of an assistant/user message, joined. */
export function textOf(message: SessionMessage): string {
  const content = ((message.payload ?? {}) as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string',
    )
    .map((b) => b.text)
    .join('\n\n')
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

/** Tool calls in a message, so a row can show what was run and with what. */
export function toolCallsOf(message: SessionMessage): ToolCall[] {
  const content = ((message.payload ?? {}) as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b?.type === 'tool_use')
    .map((b, i) => ({
      id: typeof b.id === 'string' ? b.id : String(i),
      name: typeof b.name === 'string' ? b.name : 'tool',
      input: b.input,
    }))
}
