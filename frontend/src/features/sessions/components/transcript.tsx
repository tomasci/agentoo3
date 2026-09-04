import { useTranslation } from 'react-i18next'
import { Alert, Card, Code, Collapsible, DefinitionList, EmptyState, Markdown } from '@/shared/ui'
import type { SessionMessage } from '../hooks/use-sessions'
import { formatFullTime, formatTime } from '../lib/format'
import {
  buildTranscript,
  type TranscriptNode,
  textOf,
  thinkingOf,
  toolCallsOf,
} from '../lib/transcript'
import styles from './transcript.module.scss'

type TaskStatus = Extract<TranscriptNode, { kind: 'task' }>['status']

// The row border used to recolour accent for every delegated task regardless
// of status; Collapsible has no className escape hatch to carry that, so the
// signal now lives entirely in the badge tone. 'completed' maps to 'neutral',
// which is exactly the untoned badge look the old code fell back to for
// anything that wasn't running or failed/killed.
const TASK_TONE: Record<TaskStatus, 'neutral' | 'accent' | 'danger'> = {
  running: 'accent',
  completed: 'neutral',
  failed: 'danger',
  killed: 'danger',
}

function MessageBody({ message }: { message: SessionMessage }) {
  const { t } = useTranslation()
  const text = textOf(message)
  const thinking = thinkingOf(message)
  const tools = toolCallsOf(message)
  const error =
    message.type === 'error'
      ? String((message.payload as { message?: unknown })?.message ?? '')
      : ''

  if (!text && !thinking && !error && tools.length === 0) {
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
      {/* Agent output is markdown, and reads as noise without it. */}
      {text && <Markdown compact>{text}</Markdown>}
      {thinking && (
        <div className={styles.thinking}>
          <span className={styles.thinkingLabel}>{t('sessions.transcript.thinking')}</span>
          <Markdown compact>{thinking}</Markdown>
        </div>
      )}
      {tools.map((tool) => (
        <div key={tool.id} className={styles.tool}>
          <span className={styles.toolName}>{tool.name}</span>
          <ToolInput input={tool.input} />
        </div>
      ))}
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
        <MessageBody message={node.message} />
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
