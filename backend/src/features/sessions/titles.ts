// Headings for the collapsed rows in a transcript.
//
// These are read off the SDK's own messages rather than generated. The engine
// already names its work: a delegated task announces its subagent type and
// description when it starts, reports a rolling summary while it runs, and the
// CLI emits a summary of its own for runs of tool calls. Asking a model to
// re-describe what the transcript already says would cost tokens and latency to
// produce something less accurate.
//
// Only a plain reasoning turn with no tool calls falls through to the text
// itself, which is why the fallback is the first sentence rather than nothing.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Ours, not the SDK's. A turn can throw before it produces a result message —
 * a bad orchestrator, a missing credential, the CLI refusing to start — and
 * that has to land in the transcript like anything else, or the history simply
 * stops with no explanation.
 */
export interface RunnerErrorMessage {
  type: 'error'
  message: string
}

export type TranscriptMessage = SDKMessage | RunnerErrorMessage

const MAX = 120

/**
 * Library agents reach a session through the project's plugin, so the engine
 * reports them namespaced — `agentoo:scout`, not `scout`. The prefix is the same
 * for every one of them, so it is noise in a heading.
 */
export const displayAgent = (name: string) => name.replace(/^agentoo:/, '')

/** One line, collapsed whitespace, cut on a word boundary. */
function tidy(text: string, max = MAX): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** `Read x3, Grep, Edit` — what a turn did, when it said nothing about it. */
function describeToolUses(names: string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
}

function blocksOf(message: TranscriptMessage): ContentBlock[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/**
 * A heading for this message, or null when it needs no row of its own.
 *
 * `who` is the agent the message belongs to — the orchestrator on the main
 * thread, or a subagent's type when it came from inside a delegation.
 */
export function titleFor(message: TranscriptMessage, rawWho: string): string | null {
  const who = displayAgent(rawWho)
  if (message.type === 'system' && 'subtype' in message) {
    if (message.subtype === 'task_started') {
      const started = message as typeof message & {
        subagent_type?: string
        description?: string
        ambient?: boolean
        skip_transcript?: boolean
      }
      // Housekeeping the CLI runs for itself: a live-update watcher, a cache
      // warm. The SDK flags these precisely so hosts can keep them out.
      if (started.ambient || started.skip_transcript) return null
      const agent = displayAgent(started.subagent_type ?? 'task')
      return tidy(`${agent}: ${started.description ?? 'starting'}`)
    }
    if (message.subtype === 'task_progress') {
      const progress = message as typeof message & {
        subagent_type?: string
        summary?: string
        last_tool_name?: string
      }
      const detail = progress.summary ?? progress.last_tool_name
      if (!detail) return null
      return tidy(`${displayAgent(progress.subagent_type ?? who)}: ${detail}`)
    }
    if (message.subtype === 'init') return null
  }

  if (message.type === 'tool_use_summary') {
    const summary = (message as { summary?: string }).summary
    return summary ? tidy(`${who}: ${summary}`) : null
  }

  if (message.type === 'assistant') {
    const blocks = blocksOf(message)
    const text = blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text as string)
      .join(' ')
      .trim()
    if (text) {
      // The first sentence is nearly always the agent stating its intent.
      const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text
      return tidy(`${who}: ${sentence}`)
    }
    const tools = blocks.filter((b) => b.type === 'tool_use' && b.name).map((b) => b.name as string)
    if (tools.length > 0) return tidy(`${who}: ${describeToolUses(tools)}`)
    const thinking = blocks.some((b) => b.type === 'thinking')
    return thinking ? `${who}: thinking` : null
  }

  if (message.type === 'error') {
    return tidy(`Turn failed: ${message.message || 'unknown error'}`)
  }

  if (message.type === 'result') {
    const result = message as typeof message & { subtype?: string; is_error?: boolean }
    if (result.is_error || result.subtype !== 'success') return 'Turn failed'
    return 'Turn complete'
  }

  // user messages carry tool results; they are rendered under the tool call
  // that asked for them rather than as rows of their own.
  return null
}
