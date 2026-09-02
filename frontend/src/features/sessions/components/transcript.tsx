import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '@/shared/ui'
import type { SessionMessage } from '../hooks/use-sessions'
import {
  buildTranscript,
  type TranscriptNode,
  textOf,
  thinkingOf,
  toolCallsOf,
} from '../lib/transcript'
import styles from './transcript.module.scss'

/** A row that is a heading until you open it. */
function Collapsible({
  title,
  badge,
  badgeClass,
  note,
  className,
  defaultOpen = false,
  children,
}: {
  title: string
  badge?: string
  badgeClass?: string
  note?: string | null
  className?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`${styles.row} ${className ?? ''}`}>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">
          ▶
        </span>
        {badge && <span className={`${styles.agent} ${badgeClass ?? ''}`}>{badge}</span>}
        <span className={styles.title}>{title}</span>
        {note && <span className={styles.note}>{note}</span>}
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  )
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
    return <pre className={styles.code}>{JSON.stringify(message.payload, null, 2)}</pre>
  }

  return (
    <>
      {error && <p className={styles.errorText}>{error}</p>}
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
        <dl className={styles.args}>
          {entries.map(([key, value]) => (
            <div key={key} className={styles.arg}>
              <dt className={styles.argKey}>{key}</dt>
              <dd className={styles.argValue}>
                {typeof value === 'string' ? (
                  <pre className={styles.code}>{value}</pre>
                ) : (
                  <pre className={styles.code}>{JSON.stringify(value, null, 2)}</pre>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )
    }
  }

  return <pre className={styles.code}>{JSON.stringify(input, null, 2)}</pre>
}

function Node({ node }: { node: TranscriptNode }) {
  const { t } = useTranslation()

  if (node.kind === 'prompt') {
    return (
      <div className={styles.prompt}>
        <span className={styles.promptLabel}>{t('sessions.transcript.you')}</span>
        {node.text}
      </div>
    )
  }

  // The turn's closing reply: open, full size, and the thing you came to read.
  if (node.kind === 'answer') {
    return (
      <div className={styles.answer}>
        <Markdown>{node.text}</Markdown>
      </div>
    )
  }

  if (node.kind === 'event') {
    return (
      <Collapsible title={node.message.title ?? ''}>
        <MessageBody message={node.message} />
      </Collapsible>
    )
  }

  const badgeClass =
    node.status === 'running'
      ? styles.agentRunning
      : node.status === 'failed' || node.status === 'killed'
        ? styles.agentFailed
        : undefined

  return (
    <Collapsible
      title={node.title}
      badge={node.agent}
      badgeClass={badgeClass}
      // Live progress, but only while it means something: on a finished task the
      // last ping is just whatever it happened to be doing when it stopped.
      note={node.status === 'running' ? node.progress : null}
      className={styles.task}
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
    return <p className={styles.empty}>{t('sessions.transcript.empty')}</p>
  }

  return (
    <div className={styles.transcript}>
      {nodes.map((node) => (
        <Node key={node.id} node={node} />
      ))}
    </div>
  )
}
