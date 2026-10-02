// A pure, unit-tested reduction of one session's full message history
// (messages rows, in seq order) down to the bounded text the review call
// actually reads — see tests/learning-digest.test.ts. Reads only the shapes
// session-run.worker.ts's own appendMessage/titleFor already document; writes
// nothing and calls nothing.
//
// Deliberately narrower than the whole transcript: a model-review prompt pays
// per character for everything here, multiplied by however many sessions a
// batch packs in (features/learning/batching.ts), so this keeps only what the
// review instruction (library/learning-prompt.ts) actually asks about —
// operator prompts, what the orchestrator (and any subagent) said and did,
// tool errors, delegation prompts, and how the session ended. Left out on
// purpose: successful tool *output* (the bulky payload a tool call returns —
// often file contents or command output a model never needs to relitigate
// once the call already succeeded), extended thinking, and every bookkeeping
// message type (`stream_event`, `rate_limit_event`, `tool_use_summary`, and
// every `system` subtype besides `task_started` — `init`, `task_progress`,
// `task_updated`, `task_notification` all repeat facts this digest gets more
// cheaply elsewhere, same as titleFor's own reasoning in features/sessions/
// titles.ts for declining a row to most of them).

import { displayAgent } from '@/features/sessions/titles'

/** The one shape this module needs from a `messages` row — never the row
 * itself, so a caller can hand this a real Drizzle row or a plain test
 * fixture without either knowing about the other. */
export interface DigestMessageRow {
  type: string
  parentToolUseId: string | null
  payload: Record<string, unknown>
}

export interface DigestSessionHeader {
  projectName: string
  title: string | null
  orchestrator: string | null
  status: string
  createdAt: Date
  totalCostUsd: number
}

/** One line/paragraph's own cap — a single tool error or assistant thought
 * must not alone blow the whole session's budget below. */
export const DIGEST_ITEM_MAX_CHARS = 500
/** The whole digest's cap, header included — see batching.ts for why this
 * has to stay well under LEARNING_BATCH_CHARS even for one session alone:
 * one oversized session is packed into a batch of its own, already capped by
 * this constant, so that batch is still bounded. */
export const DIGEST_SESSION_MAX_CHARS = 12_000

/**
 * Keeps the head and the tail, with an explicit marker naming how much was
 * cut from the middle — never a bare trailing "…", which could read as the
 * text simply stopping rather than material being withheld.
 */
export function truncateKeepingEnds(text: string, max: number): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  const marker = `\n… [${omitted} characters omitted] …\n`
  if (marker.length >= max) return text.slice(0, Math.max(max, 0))
  const remaining = max - marker.length
  const head = Math.ceil(remaining * 0.6)
  const tail = remaining - head
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '')
}

function addLine(lines: string[], text: string): void {
  const trimmed = text.trim()
  if (trimmed) lines.push(truncateKeepingEnds(trimmed, DIGEST_ITEM_MAX_CHARS))
}

const str = (obj: Record<string, unknown>, key: string): string | undefined =>
  typeof obj[key] === 'string' ? (obj[key] as string) : undefined

/** Produces a one-line `name(salient value)` summary. A heuristic, not a
 * parser of a fixed tool schema: a tool this installation's library adds
 * later (a new skill's own MCP tool, say) still gets a legible one-liner from
 * whichever of these common field names it happens to carry, rather than
 * nothing until this file is updated for it. */
function summarizeToolInput(name: string, input: unknown): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (name === 'Task' || name === 'Agent') {
    const subagentType = str(obj, 'subagent_type')
    const description = str(obj, 'description')
    return `${name}(${subagentType ? displayAgent(subagentType) : 'subagent'}${description ? `: ${description}` : ''})`
  }
  const salientKeys = ['command', 'file_path', 'path', 'name', 'pattern', 'query', 'url', 'prompt']
  for (const key of salientKeys) {
    const value = str(obj, key)
    if (value) return `${name}(${value})`
  }
  try {
    return `${name}(${JSON.stringify(input).slice(0, 150)})`
  } catch {
    return name
  }
}

/** A tool_result's own `content`: a bare string, or the same text-block shape
 * an assistant message uses — mirrors frontend/src/features/sessions/lib/
 * transcript.ts's own resultTextOf, read-only precedent for this exact shape. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string',
    )
    .map((b) => b.text)
    .join('\n')
}

/**
 * The digest for one session, or `null` when it has nothing a review call
 * needs to see — an idle session nobody ever sent a prompt to, say. `null`
 * is what lets the engine's own `sessionsAnalyzed` count exactly the sessions
 * actually sent to the model.
 */
export function digestSession(
  header: DigestSessionHeader,
  rows: DigestMessageRow[],
): string | null {
  // tool_use_id -> the subagent task_started named, for attributing a later
  // message's parentToolUseId to a readable label — the same fold
  // session-run.worker.ts's own `attribution`/`tasks` map performs live.
  const tasks = new Map<string, string>()
  // tool_use_id -> the tool name that call invoked, so a later tool_result
  // error can say which tool it came from without re-reading the call itself.
  const toolNames = new Map<string, string>()
  const lines: string[] = []

  const labelFor = (parentToolUseId: string | null): string => {
    if (!parentToolUseId) return 'orchestrator'
    const agent = tasks.get(parentToolUseId)
    return agent ? displayAgent(agent) : 'subagent'
  }

  for (const row of rows) {
    const payload = row.payload ?? {}

    if (row.type === 'prompt') {
      const text = str(payload, 'text') ?? ''
      const auto = payload.auto === true
      addLine(lines, `${auto ? 'System (auto-continuation)' : 'Operator'}: ${text}`)
      continue
    }

    const subtype = str(payload, 'subtype')

    if (row.type === 'system' && subtype === 'task_started') {
      const ambient = payload.ambient === true || payload.skip_transcript === true
      const toolUseId = str(payload, 'tool_use_id')
      const subagentType = str(payload, 'subagent_type')
      const taskType = str(payload, 'task_type')
      // Only a real delegation — not the CLI's own ambient housekeeping, and
      // not a backgrounded shell command (`local_bash`), which carries no
      // subagent_type/prompt at all and so is not a "delegation prompt" in
      // the sense this digest cares about.
      if (!ambient && toolUseId && subagentType && taskType !== 'local_bash') {
        tasks.set(toolUseId, subagentType)
        const description = str(payload, 'description') ?? ''
        const prompt = str(payload, 'prompt') ?? ''
        addLine(
          lines,
          `Delegated to ${displayAgent(subagentType)}: ${description} — prompt: ${prompt}`,
        )
      }
      continue
    }

    if (row.type === 'assistant') {
      const content = (payload as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        const label = labelFor(row.parentToolUseId)
        for (const block of content as Record<string, unknown>[]) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text' && typeof block.text === 'string') {
            addLine(lines, `${label}: ${block.text}`)
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            if (typeof block.id === 'string') toolNames.set(block.id, block.name)
            addLine(lines, `${label} tool call: ${summarizeToolInput(block.name, block.input)}`)
          }
        }
      }
      continue
    }

    if (row.type === 'user') {
      const content = (payload as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'tool_result' && block.is_error === true) {
            const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
            const name = toolUseId ? toolNames.get(toolUseId) : undefined
            const text = toolResultText(block.content)
            addLine(lines, `Tool error${name ? ` (${name})` : ''}: ${text}`)
          }
        }
      }
      continue
    }

    if (row.type === 'result') {
      const resultSubtype = subtype ?? 'unknown'
      const isError = payload.is_error === true
      const text = str(payload, 'result') ?? ''
      addLine(lines, `Result: subtype=${resultSubtype} error=${isError}${text ? ` — ${text}` : ''}`)
    }

    // Everything else — stream_event, rate_limit_event, tool_use_summary,
    // every other system subtype, our own 'notice'/'error' rows — carries
    // nothing this digest's own instruction asks about, per this file's own
    // header.
  }

  if (lines.length === 0) return null

  const headerLines = [
    `Session: ${header.projectName}${header.title ? ` — ${header.title}` : ''}`,
    `Orchestrator: ${header.orchestrator ?? '(none)'}  Status: ${header.status}  ` +
      `Created: ${header.createdAt.toISOString()}  Cost: $${header.totalCostUsd.toFixed(4)}`,
  ]

  return truncateKeepingEnds([...headerLines, ...lines].join('\n'), DIGEST_SESSION_MAX_CHARS)
}
