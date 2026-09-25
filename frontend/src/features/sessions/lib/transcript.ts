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

/** One entry of a `prompt` message's own `files` array — see `files` on
 * `sessionMessageSchema` in openapi.json. `id`/`mimeType`/`sizeBytes`/`status`
 * are null together once the file's row has been hard-deleted; the link row
 * keeps `originalFilename` denormalised even then, so the transcript can still
 * say *which* file was here. */
export type MessageFile = SessionMessage['files'][number]

export type TranscriptNode =
  | {
      kind: 'prompt'
      id: string
      seq: number
      text: string
      files: MessageFile[]
      createdAt: string
    }
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
  /** The reply that closes a turn: shown open, at full size, as markdown.
   * `model` is carried here rather than read off a `message` the way the
   * `event` variant does, because promoting a row into this variant (see
   * `markAnswers` below) drops everything but `text` — the source message is
   * gone by the time anything renders this node. */
  | {
      kind: 'answer'
      id: string
      seq: number
      text: string
      model: string | null
      createdAt: string
    }
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
      /**
       * True until this group's own `task_started` has been seen — see
       * `partialGroupFor` below. A partial group is a normal collapsible row,
       * just missing the detail only `task_started` carries: `agent`/`title`
       * stay `''` (or hold whatever a `task_progress` ping already gave away,
       * see the `task_progress` branch), and `prompt`/`command` stay `null`,
       * until either `task_started` loads or the tree is rebuilt without this
       * node ever being asked for again. The renderer (`transcript.tsx`) uses
       * this to show a neutral badge and a translated placeholder instead of
       * guessing at a name or an accent colour it has no basis for.
       */
      partial: boolean
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

/**
 * A task node's id, and its React key once it reaches `transcript.tsx` — see
 * `partialGroupFor` and the `task_started` branch below, the two places that
 * mint one. Derived from the delegation's own `tool_use_id` rather than the
 * `task_started` message's id: the whole point is that a partial group
 * (created before that message has loaded) and the real group it upgrades
 * into (once it has) are the *same* row, so they need the same key whether or
 * not `task_started` is in the window this call was given. `task:` can never
 * collide with a message id (a uuid — see `SessionMessage`), so this is safe
 * to use unconditionally; `fallback` (today's `message.id`) only fires for a
 * `task_started` with no `tool_use_id` at all, which cannot become partial in
 * the first place (nothing could name it as a parent without one).
 */
const taskNodeId = (toolUseId: string | undefined, fallback: string): string =>
  toolUseId ? `task:${toolUseId}` : fallback

/**
 * `messages` is a *window* into the transcript, not the whole of it, now that
 * the caller pages: the newest `PAGE_SIZE` on open, older pages prepended as
 * the reader scrolls up (see use-sessions.ts). A window that starts mid-task
 * used to degrade in a way that only looked temporary: every message of a
 * still-open delegation whose `task_started` was above the window rendered
 * flattened at the top level, and the moment that older page loaded they all
 * collapsed into the single row they should have been the whole time — right
 * under the reader's eyes, taking the scroll anchor with them. That is fixed:
 * a message whose `parentToolUseId` names a group not (yet) in the window
 * gets a *partial* task group instead of falling through to `roots` (see
 * `partialGroupFor`), so the row count a loaded window renders does not
 * change shape as an older page fills in detail it already knew was missing.
 * The real `task_started`, if it turns up later in the same pass, fills that
 * same object in rather than creating a second one (see the `task_started`
 * branch below); and because a task node's `id` is derived from its
 * `tool_use_id` (`taskNodeId`) rather than from whichever message happened to
 * create the group, the *next* build — the one after the older page has
 * actually loaded — produces a real group under the exact same id, so React
 * keeps the same row mounted instead of swapping one element for another.
 *
 * Two degradations from the old version of this comment remain, genuinely
 * unrelated to task nesting:
 *
 * - a `tool_result` whose `tool_use` is above the window finds no owner in
 *   `toolUseOwners`, so the result is discarded — real content loss, but one
 *   that predates pagination (a `tool_use`/`tool_result` pair has always been
 *   able to straddle two different fetches) and pagination only makes it the
 *   common case instead of the theoretical one;
 * - `markAnswers` walks `roots` positionally, so a window that starts or ends
 *   mid-turn can promote the wrong assistant message as "the answer", or none.
 *   A subagent's own reply cannot be caught by this any more, though: it now
 *   nests inside its (real or partial) task group instead of sitting in
 *   `roots`, so `markAnswers` — which only ever looks at `roots` — never sees
 *   it as a candidate in the first place.
 *
 * The alternative — pages aligned to turn boundaries — would need turn
 * boundaries recorded in the schema, and even then could not bound a page's
 * size (one turn can be arbitrarily long), so it was not worth the schema
 * change for the two degradations partial groups do not already cover.
 */
export function buildTranscript(messages: SessionMessage[]): TranscriptNode[] {
  const roots: TranscriptNode[] = []
  // tool_use_id -> the group collecting that delegation's messages — real
  // once its own task_started has been seen in this window, partial before
  // that (see partialGroupFor).
  const groups = new Map<string, TaskNode>()
  // task_id -> the same group, for the status patches that arrive later.
  const byTaskId = new Map<string, TaskNode>()
  // tool_use_id -> the row that made that call, for the tool_result that
  // answers it — arriving as a separate, untitled message later on.
  const toolUseOwners = new Map<string, EventNode>()
  // tool_use_id of a task_started the backend itself declined to title
  // (ambient housekeeping, or explicitly marked skip_transcript): recorded so
  // a stray child, progress ping or notification for the same id keeps
  // falling through to `roots` exactly as it did before partial groups
  // existed, rather than growing a group nobody asked to see.
  const skipped = new Set<string>()

  const ordered = [...messages].sort((a, b) => a.seq - b.seq)

  /**
   * The group for `toolUseId`, real or partial — creating a partial one at
   * the back of `roots` the first time anything needs it. `roots`, because a
   * partial group's own parent is unknown by definition: the one message that
   * would say so, its `task_started`, has not been seen. If that message
   * turns up later in this same pass, the `task_started` branch below finds
   * this exact object by `toolUseId` and fills it in rather than moving it —
   * relocating it once its real parent is known would just trade the jump
   * this function exists to remove for a different one.
   */
  function partialGroupFor(toolUseId: string, seq: number, createdAt: string): TaskNode {
    const existing = groups.get(toolUseId)
    if (existing) return existing
    const group: TaskNode = {
      kind: 'task',
      id: taskNodeId(toolUseId, toolUseId),
      seq,
      taskId: toolUseId,
      agent: '',
      title: '',
      prompt: null,
      command: null,
      status: 'running',
      progress: null,
      partial: true,
      children: [],
      createdAt,
    }
    groups.set(toolUseId, group)
    roots.push(group)
    return group
  }

  /** Where a message belongs: inside its parent's group — a partial one, if
   * that group's own task_started has not loaded yet — or at the top, for a
   * message with no parent or one whose parent was itself declined a title
   * and must not grow a group of its own (see `skipped`). */
  const listFor = (
    parentToolUseId: string | null,
    seq: number,
    createdAt: string,
  ): TranscriptNode[] => {
    if (!parentToolUseId || skipped.has(parentToolUseId)) return roots
    return partialGroupFor(parentToolUseId, seq, createdAt).children
  }

  /**
   * A group named by `toolUseId` if the payload carries one, else by
   * `taskId` — task_progress and task_notification carry both (see the doc
   * comment above), task_updated only ever carries the latter. Only the
   * `toolUseId` path can create a group that is not there yet: a bare
   * `taskId` alone is not enough to derive the stable id a partial group
   * needs (`taskNodeId`), so task_updated can only ever resolve a group
   * something else already created — exactly the shape the pre-pagination
   * code had for it.
   */
  function resolveGroup(
    toolUseId: string | undefined,
    taskId: string | undefined,
    seq: number,
    createdAt: string,
  ): TaskNode | undefined {
    if (toolUseId)
      return skipped.has(toolUseId) ? undefined : partialGroupFor(toolUseId, seq, createdAt)
    return taskId ? byTaskId.get(taskId) : undefined
  }

  for (const message of ordered) {
    const payload = (message.payload ?? {}) as Payload
    const parent = message.parentToolUseId

    if (message.type === 'prompt') {
      roots.push({
        kind: 'prompt',
        id: message.id,
        seq: message.seq,
        text: str(payload, 'text') ?? '',
        // `?? []`: the REST page this hook's own history load reads always
        // carries this (see the schema), but a prompt appended live over the
        // stream is published from the raw `messages` row the moment it is
        // written (session-run.worker.ts publishes `message: row`) — before
        // the same worker links `message_files` a little later, and nothing
        // re-publishes the message once it does. So a freshly sent prompt in
        // *this* tab shows no attachments until the transcript is next
        // fetched from the server (reload, another tab); this is what keeps
        // that gap from crashing the row instead.
        files: message.files ?? [],
        createdAt: message.createdAt,
      })
      continue
    }

    if (payload.subtype === 'task_started') {
      const toolUseId = str(payload, 'tool_use_id')
      const taskId = str(payload, 'task_id')

      // Housekeeping the engine runs for itself; the backend already declines
      // to title these, and they are not the user's work. Recorded by
      // tool_use_id (see `skipped` above) rather than simply skipped, so
      // nothing downstream mistakes one for a delegation still waiting on
      // this very message.
      if (payload.ambient === true || payload.skip_transcript === true) {
        if (toolUseId) skipped.add(toolUseId)
        continue
      }

      // Only a spawned agent is a delegation; a backgrounded Bash call carries
      // no subagent_type or prompt at all and needs a badge that says so
      // honestly, rather than the generic fallback that used to read
      // 'subagent' regardless of what actually ran.
      const isBash = str(payload, 'task_type') === 'local_bash'
      const description = str(payload, 'description')
      const agent = isBash ? 'shell' : displayAgent(str(payload, 'subagent_type') ?? 'task')
      // The description alone: the badge beside it already names the agent,
      // and "ARCHITECT | architect: investigate" says it twice. `||`, not
      // `??`: an empty-string description is still not a title, and should
      // fall through the same as a missing one.
      const title = isBash ? 'Shell command' : description || message.title || 'delegated task'
      const prompt = isBash ? null : (str(payload, 'prompt') ?? null)
      const command = isBash ? description || null : null

      const existing = toolUseId ? groups.get(toolUseId) : undefined
      if (existing?.partial) {
        // A partial group already sits wherever an earlier orphaned child (or
        // a progress/notification ping) put it — filled in, in place, rather
        // than replaced: the row a reader may already be looking at stays the
        // same DOM element instead of disappearing behind a second one.
        existing.seq = message.seq
        existing.taskId = taskId ?? existing.taskId
        existing.agent = agent
        existing.title = title
        existing.prompt = prompt
        existing.command = command
        existing.createdAt = message.createdAt
        existing.partial = false
        if (taskId) byTaskId.set(taskId, existing)
        continue
      }

      const group: TaskNode = {
        kind: 'task',
        id: taskNodeId(toolUseId, message.id),
        seq: message.seq,
        taskId: taskId ?? message.id,
        agent,
        title,
        prompt,
        command,
        status: 'running',
        progress: null,
        partial: false,
        children: [],
        createdAt: message.createdAt,
      }
      listFor(parent, message.seq, message.createdAt).push(group)
      if (toolUseId) groups.set(toolUseId, group)
      if (taskId) byTaskId.set(taskId, group)
      continue
    }

    // Progress pings arrive at the top level with no parentToolUseId, so they
    // would otherwise sit beside the orchestrator's own steps, repeating work
    // that is already nested inside the group. They belong to their task —
    // found (or, if task_started has not loaded yet, created) by tool_use_id;
    // task_id is only ever the fallback for a payload that carries nothing
    // else, the shape every fixture predating this change already used.
    if (payload.subtype === 'task_progress') {
      const taskId = str(payload, 'task_id')
      const toolUseId = str(payload, 'tool_use_id')
      const group = resolveGroup(toolUseId, taskId, message.seq, message.createdAt)
      if (group) {
        if (taskId) {
          group.taskId = taskId
          byTaskId.set(taskId, group)
        }
        // Only while the group is still waiting on its own task_started, and
        // only to fill what is not already known: a ping can name the
        // delegation before the window's own task_started does, but it is
        // never a more authoritative source than that message once it exists.
        if (group.partial) {
          const subagentType = str(payload, 'subagent_type')
          const description = str(payload, 'description')
          if (!group.agent && subagentType) group.agent = displayAgent(subagentType)
          if (!group.title && description) group.title = description
        }
        group.progress = str(payload, 'summary') ?? str(payload, 'last_tool_name') ?? null
      }
      continue
    }

    if (payload.subtype === 'task_updated') {
      const taskId = str(payload, 'task_id')
      const patch = (payload.patch ?? {}) as Payload
      const status = str(patch, 'status')
      // task_updated carries only task_id and patch — no tool_use_id (see the
      // doc comment above resolveGroup) — so this can only ever resolve a
      // group task_started, task_progress or task_notification already made.
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
      const toolUseId = str(payload, 'tool_use_id')
      const status = str(payload, 'status')
      const group = resolveGroup(toolUseId, taskId, message.seq, message.createdAt)
      if (group) {
        if (taskId) {
          group.taskId = taskId
          byTaskId.set(taskId, group)
        }
        const resolved = status ? NOTIFICATION_STATUS[status] : undefined
        if (resolved) group.status = resolved
      }
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
    listFor(parent, message.seq, message.createdAt).push(node)
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
              model: modelOf(answer.message),
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

/** The model that produced an assistant message — only ever on an
 * `assistant` frame's `message.model`. Absent from a `prompt` (the human's own
 * words), a `result` (session-level accounting, not attributable to a single
 * model) and anything else the SDK sends with no `message` of its own. A
 * subagent's messages can and do name a different model from the
 * orchestrator's — this is genuinely per-message, not per-session. */
export function modelOf(message: SessionMessage): string | null {
  const model = ((message.payload ?? {}) as { message?: { model?: unknown } }).message?.model
  return typeof model === 'string' ? model : null
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
