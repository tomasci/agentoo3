import {
  ChevronRightIcon,
  FileIcon,
  FileXIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { memo, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/features/system'
import { Code, DefinitionList, Markdown, StatusBadge, type Tone } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/shared/ui/attachment'
import { Button } from '@/shared/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import type { SessionMessage } from '../hooks/use-sessions'
import { isInlineImage, sessionFileUrl } from '../lib/attachments'
import { formatFullTime, formatTime } from '../lib/format'
import {
  buildTranscript,
  type MessageFile,
  modelOf,
  type ToolResult,
  type TranscriptNode,
  textOf,
  thinkingOf,
  toolCallsOf,
} from '../lib/transcript'

type TaskStatus = Extract<TranscriptNode, { kind: 'task' }>['status']

// A task starts 'running' (accent) and stays that way until a task_updated or
// task_notification resolves it — 'completed' gets its own 'success' tone
// rather than reusing the untoned 'neutral' look: a badge that carries no
// colour at all reads as "nothing observed yet", which is exactly what a task
// this code has simply never heard the end of also looks like. A clean finish
// should look like one.
const TASK_TONE: Record<TaskStatus, Tone> = {
  running: 'accent',
  completed: 'success',
  failed: 'danger',
  killed: 'danger',
}

/** How much of a tool result to show before asking for a click. A Bash call
 * can return megabytes; showing none of it was the bug this fixes, but
 * showing all of it inline would trade one unreadable row for another. */
const RESULT_CLAMP = 4000

/**
 * A row that is a heading until you open it — every task/event node in the
 * transcript renders through this. Composed straight from `ui/collapsible`
 * (unstyled by design) rather than a shared pattern: the badge/note/meta
 * trailing slots here are specific to a transcript row, not a general
 * disclosure API.
 */
function TranscriptDisclosure({
  title,
  badge,
  note,
  meta,
  children,
}: {
  title: ReactNode
  badge?: { label: string; tone: Tone }
  note?: ReactNode
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <Collapsible className="min-w-0 overflow-hidden rounded-md border bg-background">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
        />
        {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {note && (
          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
            {note}
          </span>
        )}
        {meta && (
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-1 gap-3 border-t p-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

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
  // Alert's destructive variant rather than the plain, unannounced result
  // block below.
  if (result.isError) {
    return (
      <Alert variant="destructive">
        <OctagonXIcon />
        <AlertDescription>{body}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-1">
      <span className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
        {t('sessions.transcript.result')}
      </span>
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
  // payload shape as an error but deliberately not the destructive variant:
  // it is reporting a recovery, not a failure.
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
      {error && (
        <Alert variant="destructive">
          <OctagonXIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert role="status">
          <TriangleAlertIcon />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {/* Agent output is markdown, and reads as noise without it. */}
      {text && <Markdown compact>{text}</Markdown>}
      {thinking && (
        <div className="border-l-2 pl-3 text-muted-foreground italic">
          <span className="mb-2 block text-[0.6875rem] font-normal not-italic uppercase tracking-wide">
            {t('sessions.transcript.thinking')}
          </span>
          <Markdown compact>{thinking}</Markdown>
        </div>
      )}
      {tools.map((tool) => {
        const result = results[tool.id]
        return (
          <div key={tool.id} className="grid grid-cols-1 gap-2">
            {/* Not model prose, so `Markdown`'s own wrapping rule never covers
                it — but an MCP tool name (`mcp__server__tool`) is a single
                unbroken token up to 128 characters, so this is the one label
                left that could still push the row wider than the viewport. */}
            <span className="wrap-anywhere font-mono text-sm text-primary">{tool.name}</span>
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
    return (
      <p className="m-0 text-xs text-muted-foreground italic">
        {t('sessions.transcript.noArguments')}
      </p>
    )
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

/** A `MessageFile` entry once every field the wire lets go null is actually
 * present — the shape `AttachmentItem` below needs to render something real. */
interface ReadyAttachment {
  id: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
}

/** Narrows one `message.files` entry to `ReadyAttachment`, or `null` for
 * anything the "file removed" placeholder has to cover instead: a
 * hard-deleted file (`id`/`mimeType`/`sizeBytes`/`status` all null together),
 * or one merely flipped to `missing`/`unreadable` by a GC pass that has not
 * (yet) deleted its row. */
function readyAttachment(file: MessageFile): ReadyAttachment | null {
  if (
    file.status !== 'ready' ||
    file.id === null ||
    file.mimeType === null ||
    file.sizeBytes === null
  ) {
    return null
  }
  // originalFilename is nullable on the wire independently of the rest, but
  // the one case the schema names for that — a link written before the
  // column existed, whose file has since also disappeared — already fails
  // the `status !== 'ready'` check above, so this is a fallback for an
  // invariant break, not a path this app expects to take.
  return {
    id: file.id,
    originalFilename: file.originalFilename ?? file.id,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }
}

/**
 * One file a prompt carried. An image gets a thumbnail that opens a `Dialog`
 * lightbox; anything else is a chip linking at the hand-built download route
 * (`lib/attachments.ts` — the OpenAPI router does not carry this one, see its
 * own comment for why). Both cases wrap the whole `Attachment` tile in the
 * real control (a `<button>` or an `<a>`) rather than only an inner icon, so
 * the filename and size are part of what the control announces.
 */
function AttachmentItem({ sessionId, file }: { sessionId: string; file: ReadyAttachment }) {
  const [open, setOpen] = useState(false)
  // Flips true only if the browser itself fails to load the thumbnail — a
  // GC race between the file list request and the download, say. Never
  // trusted as the sole signal that a file is gone (see `readyAttachment`
  // above); this only ever guards against a broken `<img>`, which the "never
  // a broken image" acceptance criterion is explicitly about.
  const [broken, setBroken] = useState(false)
  const url = sessionFileUrl(sessionId, file.id)
  const isImage = isInlineImage(file.mimeType) && !broken

  const tile = (
    <Attachment state="done" size="sm">
      <AttachmentMedia variant={isImage ? 'image' : 'icon'}>
        {isImage ? (
          <img src={url} alt={file.originalFilename} onError={() => setBroken(true)} />
        ) : (
          <FileIcon aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{file.originalFilename}</AttachmentTitle>
        <AttachmentDescription>{formatBytes(file.sizeBytes)}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )

  if (isImage) {
    return (
      <>
        <button type="button" className="block text-left" onClick={() => setOpen(true)}>
          {tile}
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{file.originalFilename}</DialogTitle>
            </DialogHeader>
            <img
              src={url}
              alt={file.originalFilename}
              className="mx-auto block max-h-[70vh] max-w-full rounded-sm"
            />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <a href={url} download={file.originalFilename} className="block">
      {tile}
    </a>
  )
}

/**
 * The attachments a `prompt` node carried — read straight off `message.files`,
 * resolved server-side from `message_files` (see `buildTranscript`). No
 * in-memory pairing and no second fetch: a reload, a second tab and a prompt
 * loaded from history all render from the exact same data a live send does.
 */
function PromptAttachments({ sessionId, files }: { sessionId: string; files: MessageFile[] }) {
  const { t } = useTranslation()

  return (
    <AttachmentGroup className="mt-2">
      {files.map((file, i) => {
        const ready = readyAttachment(file)
        if (!ready) {
          return (
            <Attachment key={file.id ?? `removed-${i}`} state="idle" size="sm">
              <AttachmentMedia>
                <FileXIcon aria-hidden="true" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle className="italic">
                  {t('sessions.attachments.removed')}
                </AttachmentTitle>
              </AttachmentContent>
            </Attachment>
          )
        }
        return <AttachmentItem key={ready.id} sessionId={sessionId} file={ready} />
      })}
    </AttachmentGroup>
  )
}

function Node({ node, sessionId }: { node: TranscriptNode; sessionId: string }) {
  const { t } = useTranslation()

  if (node.kind === 'prompt') {
    return (
      <div className="ml-auto max-w-[min(46rem,100%)] rounded-lg border bg-primary/5 px-3 py-2 whitespace-pre-wrap wrap-anywhere">
        <span className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
            {t('sessions.transcript.you')}
          </span>
          <Timestamp
            createdAt={node.createdAt}
            className="text-[0.6875rem] text-muted-foreground tabular-nums"
          />
        </span>
        {node.text}
        {node.files.length > 0 && <PromptAttachments sessionId={sessionId} files={node.files} />}
      </div>
    )
  }

  // The turn's closing reply: open, full size, and the thing you came to read.
  if (node.kind === 'answer') {
    const time = formatTime(node.createdAt) && (
      <Timestamp
        createdAt={node.createdAt}
        className="text-[0.6875rem] text-muted-foreground tabular-nums"
      />
    )
    // An unparsable createdAt and an absent model must produce no wrapper at
    // all, not an empty one — an always-rendered meta span would itself be a
    // second child of the answer's single-column grid even with nothing
    // visible inside it.
    return (
      <div className="grid grid-cols-1 gap-1 rounded-lg border bg-background px-3 py-2">
        {(time || node.model) && (
          <span className="justify-self-end">
            {time}
            {node.model && (
              <span
                className="ml-2 text-[0.6875rem] text-muted-foreground"
                title={t('sessions.transcript.model', { model: node.model })}
              >
                {node.model}
              </span>
            )}
          </span>
        )}
        <Markdown>{node.text}</Markdown>
      </div>
    )
  }

  // The disclosure only renders its meta slot when this is truthy, so an
  // unparsable createdAt must produce undefined here, not an element that
  // renders empty.
  const time = formatTime(node.createdAt) && <Timestamp createdAt={node.createdAt} />

  if (node.kind === 'event') {
    // Absent from most rows (a tool_result, a system frame) — only an
    // `assistant`/`user` message names the model that produced it.
    const model = modelOf(node.message)
    // Either, not `time` alone: gating on the timestamp only meant a row with
    // a real model but an unparsable createdAt lost the model along with it —
    // the same "nothing to show" rule as the answer branch above, which
    // already renders on `time || node.model`.
    const meta = (time || model) && (
      <>
        {time}
        {model && (
          <span className="ml-2" title={t('sessions.transcript.model', { model })}>
            {model}
          </span>
        )}
      </>
    )
    return (
      <TranscriptDisclosure title={node.message.title ?? ''} meta={meta}>
        <MessageBody message={node.message} results={node.results} />
      </TranscriptDisclosure>
    )
  }

  // A group whose own task_started has not loaded yet, and that has not
  // picked up an agent from a task_progress ping either (see buildTranscript):
  // nothing here is a guess, so it gets a neutral badge and a translated
  // placeholder rather than an accent-toned row claiming to be running
  // something specific it has no basis for naming.
  const pending = !node.agent
  const pendingLabel = t('sessions.transcript.pendingTask')

  return (
    <TranscriptDisclosure
      title={node.title || pendingLabel}
      badge={{
        label: node.agent || pendingLabel,
        tone: pending ? 'neutral' : TASK_TONE[node.status],
      }}
      // Live progress, but only while it means something: on a finished task the
      // last ping is just whatever it happened to be doing when it stopped.
      note={node.status === 'running' ? node.progress : null}
      meta={time}
    >
      {/* The instruction the orchestrator wrote. Shown first and in full: it is
          the only place the delegation is visible. */}
      {node.prompt && (
        <div className="rounded-sm border bg-muted p-3">
          <span className="mb-2 block text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
            {t('sessions.transcript.delegatedPrompt', { agent: node.agent })}
          </span>
          <Markdown compact>{node.prompt}</Markdown>
        </div>
      )}
      {/* A backgrounded Bash call, not a delegation: no prompt, and no child
          messages either, so this is the only thing the row has to show. */}
      {node.command && (
        <div className="rounded-sm border bg-muted p-3">
          <span className="mb-2 block text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
            {t('sessions.transcript.command')}
          </span>
          <Code block wrap>
            {node.command}
          </Code>
        </div>
      )}
      {node.children.length > 0 && (
        <div className="ml-2 grid grid-cols-1 gap-2 border-l-2 pl-3">
          {node.children.map((child) => (
            <Node key={child.id} node={child} sessionId={sessionId} />
          ))}
        </div>
      )}
    </TranscriptDisclosure>
  )
}

function TranscriptView({
  messages,
  sessionId = '',
}: {
  messages: SessionMessage[]
  sessionId?: string
}) {
  const { t } = useTranslation()
  // Keyed on the array identity, which React Query keeps stable between
  // fetches: rebuilding the tree is O(every message in the session), and it was
  // running on every render rather than only when a message arrived.
  const nodes = useMemo(() => buildTranscript(messages), [messages])

  if (nodes.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>{t('sessions.transcript.empty')}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-2">
      {nodes.map((node) => (
        // No `content-visibility` here any more. It bounded the layout cost
        // of the composer's own JS auto-grow, which ran on every keystroke;
        // the composer now auto-grows with CSS `field-sizing: content`
        // (shared/ui/textarea.tsx), so there is nothing left recomputing
        // layout that often for this to bound. What it cost instead: a
        // never-rendered row reported a flat 6rem guess, so scrolling up
        // through unseen history grew content *above* the reader as each row
        // resolved to its real height — engines with scroll anchoring
        // (Chrome, Firefox) silently absorbed that, but it is exactly the
        // "flickers and jumps" a reader without one sees. The wrapper itself
        // stays: `data-transcript-row` is the contract session-page.tsx's
        // scroll-position compensation selects on inside the scroll
        // container, one per top-level node, in document order, and only a
        // top-level node ever carries it.
        <div key={node.id} data-transcript-row="">
          <Node node={node} sessionId={sessionId} />
        </div>
      ))}
    </div>
  )
}

/**
 * Memoised because the composer's `text` state lives in the same component that
 * renders this one, so every keystroke re-rendered the whole transcript — an
 * entire tree rebuild plus every row, synchronously, per character. The
 * controlled textarea could not keep up and silently dropped the keystrokes
 * typed during the render, progressively worse the longer the session got.
 */
export const Transcript = memo(TranscriptView)
