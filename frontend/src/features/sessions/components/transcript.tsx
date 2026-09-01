import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionMessage } from '../hooks/use-sessions'
import { buildTranscript, type TranscriptNode, textOf, toolCallsOf } from '../lib/transcript'
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
  const tools = toolCallsOf(message)

  if (!text && tools.length === 0) {
    // Nothing structured to show: the raw payload beats an empty box.
    return <pre className={styles.raw}>{JSON.stringify(message.payload, null, 2)}</pre>
  }

  return (
    <>
      {text && <p className={styles.text}>{text}</p>}
      {tools.map((tool) => (
        <div key={tool.id} className={styles.tool}>
          <span className={styles.toolName}>{tool.name}</span>
          <pre className={styles.toolInput}>{JSON.stringify(tool.input, null, 2)}</pre>
        </div>
      ))}
      {tools.length === 0 && !text && <span>{t('sessions.transcript.noContent')}</span>}
    </>
  )
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
          <p className={styles.delegationText}>{node.prompt}</p>
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
