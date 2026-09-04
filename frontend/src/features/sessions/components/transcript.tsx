import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Button,
  Card,
  Code,
  Collapsible,
  DefinitionList,
  EmptyState,
  Markdown,
} from '@/shared/ui'
import type { SessionMessage } from '../hooks/use-sessions'
import { formatFullTime, formatTime } from '../lib/format'
import {
  buildTranscript,
  type ToolResult,
  type TranscriptNode,
  textOf,
  thinkingOf,
  toolCallsOf,
} from '../lib/transcript'
import styles from './transcript.module.scss'

type TaskStatus = Extract<TranscriptNode, { kind: 'task' }>['status']

// The row border used to recolour accent for every delegated task regardless
// of status; Collapsible has no className escape hatch to carry that, so the
// signal now lives entirely in the badge tone. A task starts 'running'
// (accent) and stays that way until a task_updated or task_notification
// resolves it — 'completed' gets its own 'success' tone rather than reusing
// the untoned 'neutral' look: a badge that carries no colour at all reads as
// "nothing observed yet", which is exactly what a task this code has simply
// never heard the end of also looks like. A clean finish should look like one.
const TASK_TONE: Record<TaskStatus, 'accent' | 'success' | 'danger'> = {
  running: 'accent',
  completed: 'success',
  failed: 'danger',
  killed: 'danger',
}

/** How much of a tool result to show before asking for a click. A Bash call
 * can return megabytes; showing none of it was the bug this fixes, but
 * showing all of it inline would trade one unreadable row for another. */
const RESULT_CLAMP = 4000

function ToolResultView({ result }: { result: ToolResult }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const long = result.text.length > RESULT_CLAMP
  const shown = expanded || !long ? result.text : `${result.text.slice(0, RESULT_CLAMP)}…`

  const body = (
    <>
      <Code block wrap>
        {shown}
      </Code>
      {long && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('sessions.transcript.showLess') : t('sessions.transcript.showMore')}
        </Button>
      )}
    </>
  )

  // is_error is the one channel a reader cannot afford to miss, so it borrows
  // Alert's danger tone rather than the plain, unannounced result block below.
  if (result.isError) {
    return <Alert tone="danger">{body}</Alert>
  }

  return (
    <div className={styles.result}>
      <span className={styles.resultLabel}>{t('sessions.transcript.result')}</span>
      {body}
    </div>
  )
}

function MessageBody({
  message,
  results,
}: {
  message: SessionMessage
  /** This message's own tool calls, paired with what they returned, keyed by
   * tool_use_id — empty for a message with no calls, or whose call has not
   * been answered yet. */
  results: Record<string, ToolResult>
}) {
  const { t } = useTranslation()
  const text = textOf(message)
  const thinking = thinkingOf(message)
  const tools = toolCallsOf(message)
  const error =
    message.type === 'error'
      ? String((message.payload as { message?: unknown })?.message ?? '')
      : ''
  // The runner's own note about something that happened between turns —
  // background work lost when a turn closed, a continuation being sent. Same
  // payload shape as an error but deliberately not the danger tone: it is
  // reporting a recovery, not a failure.
  const notice =
    message.type === 'notice'
      ? String((message.payload as { message?: unknown })?.message ?? '')
      : ''

  if (!text && !thinking && !error && !notice && tools.length === 0) {
    // Nothing recognised. The payload is a last resort, not the normal case.
    return (
      <Code block wrap>
        {JSON.stringify(message.payload, null, 2)}
      </Code>
    )
  }

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="warning">{notice}</Alert>}
      {/* Agent output is markdown, and reads as noise without it. */}
      {text && <Markdown compact>{text}</Markdown>}
      {thinking && (
        <div className={styles.thinking}>
          <span className={styles.thinkingLabel}>{t('sessions.transcript.thinking')}</span>
          <Markdown compact>{thinking}</Markdown>
        </div>
      )}
      {tools.map((tool) => {
        const result = results[tool.id]
        return (
          <div key={tool.id} className={styles.tool}>
            <span className={styles.toolName}>{tool.name}</span>
            <ToolInput input={tool.input} />
            {result && <ToolResultView result={result} />}
          </div>
        )
      })}
    </>
  )
}

/**
 * A tool's arguments.
 *
 * Most are one or two short fields, and a JSON dump of `{"command": "..."}`
 * hides the one line anybody wants behind punctuation and escaping. Long string
 * values are shown as themselves; anything else falls back to formatted JSON.
 */
function ToolInput({ input }: { input: unknown }) {
  const { t } = useTranslation()
  if (input === null || input === undefined) return null

  if (typeof input === 'object' && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>)
    if (entries.length > 0) {
      return (
        <DefinitionList
          layout="stacked"
          items={entries.map(([key, value]) => ({
            id: key,
            term: key,
            description: (
              <Code block wrap>
                {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
              </Code>
            ),
          }))}
        />
      )
    }
    // A tool like ListAgents takes nothing: `JSON.stringify({}, null, 2)`
    // printed a bare `{}`, which reads as a broken call rather than one that
    // genuinely has no arguments.
    return <p className={styles.noArgs}>{t('sessions.transcript.noArguments')}</p>
  }

  return (
    <Code block wrap>
      {JSON.stringify(input, null, 2)}
    </Code>
  )
}

/**
 * When a message arrived, quiet enough not to compete with it: short `HH:MM`
 * on the row, the full date on hover. Renders nothing for a message whose
 * `createdAt` is missing or unparsable rather than showing "Invalid Date".
 */
function Timestamp({ createdAt, className }: { createdAt: string; className?: string }) {
  const time = formatTime(createdAt)
  if (!time) return null
  return (
    <span className={className} title={formatFullTime(createdAt) ?? undefined}>
      {time}
    </span>
  )
}

function Node({ node }: { node: TranscriptNode }) {
  const { t } = useTranslation()

  if (node.kind === 'prompt') {
    return (
      <div className={styles.prompt}>
        <span className={styles.promptCaption}>
          <span className={styles.promptLabel}>{t('sessions.transcript.you')}</span>
          <Timestamp createdAt={node.createdAt} className={styles.promptTime} />
        </span>
        {node.text}
      </div>
    )
  }

  // The turn's closing reply: open, full size, and the thing you came to read.
  if (node.kind === 'answer') {
    return (
      <div className={styles.answer}>
        <Timestamp createdAt={node.createdAt} className={styles.answerTime} />
        <Markdown>{node.text}</Markdown>
      </div>
    )
  }

  // Collapsible only renders its meta slot when this is truthy, so an
  // unparsable createdAt must produce undefined here, not an element that
  // renders empty.
  const meta = formatTime(node.createdAt) && <Timestamp createdAt={node.createdAt} />

  if (node.kind === 'event') {
    return (
      <Collapsible title={node.message.title ?? ''} meta={meta}>
        <MessageBody message={node.message} results={node.results} />
      </Collapsible>
    )
  }

  return (
    <Collapsible
      title={node.title}
      badge={{ label: node.agent, tone: TASK_TONE[node.status] }}
      // Live progress, but only while it means something: on a finished task the
      // last ping is just whatever it happened to be doing when it stopped.
      note={node.status === 'running' ? node.progress : null}
      meta={meta}
    >
      {/* The instruction the orchestrator wrote. Shown first and in full: it is
          the only place the delegation is visible. */}
      {node.prompt && (
        <div className={styles.delegation}>
          <span className={styles.delegationLabel}>
            {t('sessions.transcript.delegatedPrompt', { agent: node.agent })}
          </span>
          <Markdown compact>{node.prompt}</Markdown>
        </div>
      )}
      {/* A backgrounded Bash call, not a delegation: no prompt, and no child
          messages either, so this is the only thing the row has to show. */}
      {node.command && (
        <div className={styles.command}>
          <span className={styles.commandLabel}>{t('sessions.transcript.command')}</span>
          <Code block wrap>
            {node.command}
          </Code>
        </div>
      )}
      {node.children.length > 0 && (
        <div className={styles.children}>
          {node.children.map((child) => (
            <Node key={child.id} node={child} />
          ))}
        </div>
      )}
    </Collapsible>
  )
}

export function Transcript({ messages }: { messages: SessionMessage[] }) {
  const { t } = useTranslation()
  const nodes = buildTranscript(messages)

  if (nodes.length === 0) {
    // padding="none": EmptyState's own size variant already supplies it, and
    // Card adds the dashed border round it.
    return (
      <Card variant="dashed" padding="none">
        <EmptyState title={t('sessions.transcript.empty')} />
      </Card>
    )
  }

  return (
    <div className={styles.transcript}>
      {nodes.map((node) => (
        <Node key={node.id} node={node} />
      ))}
    </div>
  )
}
