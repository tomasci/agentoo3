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

export interface ToolResult {
  toolUseId: string
  text: string
  isError: boolean
}

export type TranscriptNode =
  | { kind: 'prompt'; id: string; seq: number; text: string; createdAt: string }
  | {
      kind: 'event'
      id: string
      seq: number
      message: SessionMessage
      /** This message's own tool calls, keyed by tool_use_id, filled in when the
       * matching tool_result arrives later in the stream — it carries no title
       * of its own, so without this it would just be dropped. */
      results: Record<string, ToolResult>
      createdAt: string
    }
  /** The reply that closes a turn: shown open, at full size, as markdown. */
  | { kind: 'answer'; id: string; seq: number; text: string; createdAt: string }
  | {
      kind: 'task'
      id: string
      seq: number
      taskId: string
      agent: string
      title: string
      /** What the orchestrator actually asked for. The point of the whole tree. */
      prompt: string | null
      /**
       * The literal shell command behind a backgrounded Bash call. `task_started`
       * fires for every task type, not only a spawned agent — a plain Bash
       * command has the same shape but no `subagent_type` or `prompt`, so
       * rendering it as a delegation put the raw command, however long, straight
       * into the title and left the body empty (a background Bash call produces
       * no child messages). Held here instead, so the title can stay short and
       * the body always has the one thing worth showing.
       */
      command: string | null
      status: 'running' | 'completed' | 'failed' | 'killed'
      /** Latest progress ping, shown while the task is still running. */
      progress: string | null
      children: TranscriptNode[]
      createdAt: string
    }

type EventNode = Extract<TranscriptNode, { kind: 'event' }>
type TaskNode = Extract<TranscriptNode, { kind: 'task' }>
type Payload = Record<string, unknown>

const str = (payload: Payload, key: string): string | undefined =>
  typeof payload[key] === 'string' ? (payload[key] as string) : undefined

/** A task_notification's status, honestly: 'stopped' is the SDK's word for a
 * background task that was cut off rather than one that ran to a natural end,
 * so it is folded into 'killed' rather than into 'completed'. */
const NOTIFICATION_STATUS: Record<string, TaskNode['status']> = {
  completed: 'completed',
  failed: 'failed',
  stopped: 'killed',
}

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
  // tool_use_id -> the row that made that call, for the tool_result that
  // answers it — arriving as a separate, untitled message later on.
  const toolUseOwners = new Map<string, EventNode>()

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
        createdAt: message.createdAt,
      })
      continue
    }

    if (payload.subtype === 'task_started') {
      // Housekeeping the engine runs for itself; the backend already declines
      // to title these, and they are not the user's work.
      if (payload.ambient === true || payload.skip_transcript === true) continue

      const toolUseId = str(payload, 'tool_use_id')
      const taskId = str(payload, 'task_id')
      // Only a spawned agent is a delegation; a backgrounded Bash call carries
      // no subagent_type or prompt at all and needs a badge that says so
      // honestly, rather than the generic fallback that used to read
      // 'subagent' regardless of what actually ran.
      const isBash = str(payload, 'task_type') === 'local_bash'
      const description = str(payload, 'description')
      const group: TaskNode = {
        kind: 'task',
        id: message.id,
        seq: message.seq,
        taskId: taskId ?? message.id,
        agent: isBash ? 'shell' : displayAgent(str(payload, 'subagent_type') ?? 'task'),
        // The description alone: the badge beside it already names the agent,
        // and "ARCHITECT | architect: investigate" says it twice. `||`, not
        // `??`: an empty-string description is still not a title, and should
        // fall through the same as a missing one.
        title: isBash ? 'Shell command' : description || message.title || 'delegated task',
        prompt: isBash ? null : (str(payload, 'prompt') ?? null),
        command: isBash ? description || null : null,
        status: 'running',
        progress: null,
        children: [],
        createdAt: message.createdAt,
      }
      listFor(parent).push(group)
      if (toolUseId) groups.set(toolUseId, group)
      if (taskId) byTaskId.set(taskId, group)
      continue
    }

    // Progress pings arrive at the top level with no parentToolUseId, so they
    // would otherwise sit beside the orchestrator's own steps, repeating work
    // that is already nested inside the group. They belong to their task.
    if (payload.subtype === 'task_progress') {
      const taskId = str(payload, 'task_id')
      const group = taskId ? byTaskId.get(taskId) : undefined
      if (group) group.progress = str(payload, 'summary') ?? str(payload, 'last_tool_name') ?? null
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

    // Completion arrives here, not as another task_updated: the backend
    // never titles this message (it is state, not a row), so it has to be
    // handled before the `!message.title` guard below drops it like the rest
    // of the untitled traffic.
    if (payload.subtype === 'task_notification') {
      const taskId = str(payload, 'task_id')
      const status = str(payload, 'status')
      const group = taskId ? byTaskId.get(taskId) : undefined
      const resolved = status ? NOTIFICATION_STATUS[status] : undefined
      if (group && resolved) group.status = resolved
      continue
    }

    // A user-role replay of tool_result blocks: the backend titles nothing
    // of type 'user' (they are answers to a call, never a step of their
    // own), so this also has to run before the guard below. The result is
    // attached to the row that made the call rather than discarded with it.
    if (message.type === 'user') {
      for (const result of toolResultsOf(message)) {
        const owner = toolUseOwners.get(result.toolUseId)
        if (owner) owner.results[result.toolUseId] = result
      }
      continue
    }

    // Rows the backend declined to title carry nothing a reader needs: the
    // init handshake, and turn-internal bookkeeping the row above already
    // consumed.
    if (!message.title) continue

    const node: EventNode = {
      kind: 'event',
      id: message.id,
      seq: message.seq,
      message,
      results: {},
      createdAt: message.createdAt,
    }
    for (const call of toolCallsOf(message)) toolUseOwners.set(call.id, node)
    listFor(parent).push(node)
  }

  markAnswers(roots)
  return roots
}

/**
 * Promote each turn's closing reply out of the collapsed rows.
 *
 * Everything above it is working — tool calls, delegations, thinking — and is
 * worth collapsing. The last thing the orchestrator says before the turn ends is
 * the part someone actually came to read, so it should not be behind a
 * disclosure triangle in the same small type as a Bash invocation.
 *
 * Identified by position rather than content: the final top-level assistant
 * message with text before a result. Nothing in the message marks it as the
 * answer, and its shape is the same as any other reply.
 */
function markAnswers(roots: TranscriptNode[]): void {
  let candidate = -1
  for (let i = 0; i < roots.length; i++) {
    const node = roots[i]
    if (!node) continue

    if (node.kind === 'event') {
      if (node.message.type === 'result') {
        const answer = candidate === -1 ? undefined : roots[candidate]
        if (answer?.kind === 'event') {
          const text = textOf(answer.message)
          if (text) {
            roots[candidate] = {
              kind: 'answer',
              id: answer.id,
              seq: answer.seq,
              text,
              createdAt: answer.createdAt,
            }
          }
        }
        candidate = -1
        continue
      }
      // Only the orchestrator's own replies; a subagent's are nested elsewhere.
      if (node.message.type === 'assistant' && textOf(node.message)) candidate = i
    }
  }
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

/** Extended thinking, so a "thinking" row shows the reasoning, not a payload dump. */
export function thinkingOf(message: SessionMessage): string {
  const content = ((message.payload ?? {}) as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: string; thinking: string } =>
        b?.type === 'thinking' && typeof b?.thinking === 'string',
    )
    .map((b) => b.thinking)
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

/** Tool results in a message, so each can be paired with the call it answers.
 * These arrive as content blocks on a `user`-type message — never mixed with
 * a real prompt, which this app writes as its own `type: 'prompt'` instead. */
function toolResultsOf(message: SessionMessage): ToolResult[] {
  const content = ((message.payload ?? {}) as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (b): b is { type: string; tool_use_id: string; content?: unknown; is_error?: boolean } =>
        b?.type === 'tool_result' && typeof b?.tool_use_id === 'string',
    )
    .map((b) => ({
      toolUseId: b.tool_use_id,
      text: resultTextOf(b.content),
      isError: b.is_error === true,
    }))
}

/** A tool_result's own `content`: a bare string, or the same text-block shape
 * an assistant message uses — the two never appear together in one block. */
function resultTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string',
    )
    .map((b) => b.text)
    .join('\n\n')
}
