import { PencilIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { toast } from '@/shared/components'
import { Input } from '@/shared/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { useUpdateSession } from '../hooks/use-sessions'
import { MAX_TITLE_LENGTH } from '../lib/title'

type TitledSession = { id: string; title: string | null }

// Nothing else holds focus: an input that was disabled or unmounted drops it
// to <body>. Focus is only handed back in that case, so a response that
// arrives late cannot pull it out of whatever the reader has since moved on to
// — the composer, say — and send their next keystrokes into the title.
const focusIsFree = () => !document.activeElement || document.activeElement === document.body

/**
 * The session page's heading, renamed in place: at rest the title is a button,
 * a click turns it into an input. Allowed in every status — renaming touches
 * nothing a running turn reads.
 *
 * The `<h1>` itself is always rendered, so the header keeps one heading with
 * the same layout either way and the actions that follow it stay its next
 * sibling.
 */
export function SessionTitle({ session }: { session: TitledSession }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Whether the edit ended on the keyboard (Enter, Escape), in which case the
  // title button gets focus back rather than leaving it on <body>.
  const refocusRef = useRef(false)

  const placeholder = t('sessions.untitled', { id: session.id.slice(0, 8) })
  const title = session.title ?? placeholder

  useEffect(() => {
    if (editing || !refocusRef.current) return
    refocusRef.current = false
    if (focusIsFree()) headingRef.current?.querySelector('button')?.focus()
  }, [editing])

  return (
    <h1 ref={headingRef} className="flex min-w-0 flex-1 items-center text-base font-semibold">
      {editing ? (
        <TitleEditor
          session={session}
          placeholder={placeholder}
          onDone={(refocus) => {
            refocusRef.current = refocus
            setEditing(false)
          }}
        />
      ) : (
        <Tooltip>
          {/* The hint rides along as the button's description rather than
              replacing its label: the visible title stays the accessible name,
              so the heading still reads as the session's title to a screen
              reader. `-ml-1.5` cancels the button's own padding, so the text
              sits exactly where the bare heading used to put it. */}
          <TooltipTrigger
            type="button"
            aria-description={t('sessions.renameHint')}
            onClick={() => setEditing(true)}
            className="group -ml-1.5 flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="truncate">{title}</span>
            <PencilIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </TooltipTrigger>
          <TooltipContent>{t('sessions.renameHint')}</TooltipContent>
        </Tooltip>
      )}
    </h1>
  )
}

/**
 * The input half. Enter, blur and Escape each end the edit, and Enter and
 * Escape each *also* cause a blur — by disabling the input while the save is
 * pending, and by unmounting it — so `exitedRef` is what keeps one gesture
 * from being handled twice: the first of them to run takes the exit and every
 * later one finds it already taken. Only a failed save gives the exit back,
 * so the reader can fix the value and try again.
 */
function TitleEditor({
  session,
  placeholder,
  onDone,
}: {
  session: TitledSession
  placeholder: string
  /** `refocus` is true when the keyboard ended the edit. */
  onDone: (refocus: boolean) => void
}) {
  const { t } = useTranslation()
  const update = useUpdateSession()
  const inputRef = useRef<HTMLInputElement>(null)
  const exitedRef = useRef(false)
  // The raw title, not the displayed one: an untitled session starts empty
  // with the fallback only as a placeholder, so leaving it alone cannot
  // "rename" it to the fallback text.
  const current = session.title ?? ''
  const [value, setValue] = useState(current)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // A disabled input loses focus, and nothing hands it back when the save
  // fails and the input is enabled again — without this, Escape and blur
  // would both stop working on a value the reader still has to fix.
  const pending = update.isPending
  useEffect(() => {
    if (!pending && focusIsFree()) inputRef.current?.focus()
  }, [pending])

  const exit = (refocus: boolean) => {
    exitedRef.current = true
    onDone(refocus)
  }

  const save = (refocus: boolean) => {
    if (exitedRef.current) return
    const next = value.trim()
    if (next === '' || next === current) {
      exit(refocus)
      return
    }
    exitedRef.current = true
    update.mutate(
      { path: { id: session.id }, body: { title: next } },
      {
        onSuccess: () => onDone(refocus),
        onError: (e) => {
          exitedRef.current = false
          toast.add({ type: 'error', title: apiErrorMessage(e, t('sessions.renameFailed')) })
        },
      },
    )
  }

  const cancel = () => {
    if (!exitedRef.current) exit(true)
  }

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => save(false)}
      onKeyDown={(e) => {
        // An Enter or Escape that is choosing or dismissing an IME candidate
        // belongs to the IME, not to this field.
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          e.preventDefault()
          save(true)
        } else if (e.key === 'Escape') {
          // Nothing above this field should also react to the Escape that
          // cancels it.
          e.stopPropagation()
          cancel()
        }
      }}
      disabled={pending}
      maxLength={MAX_TITLE_LENGTH}
      placeholder={placeholder}
      aria-label={t('sessions.form.title')}
      className="-ml-1.5 h-7 flex-1 px-1.5 text-base font-semibold md:text-base"
    />
  )
}
