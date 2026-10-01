import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logger } from '@/shared/lib/logger'
import { Button } from '@/shared/ui/button'

/**
 * Copy to clipboard, with a fallback.
 *
 * navigator.clipboard is unavailable on a plain-HTTP origin outside localhost —
 * which is exactly how this app is served over the tailnet — so the legacy
 * execCommand path is the one that will usually run, not a curiosity.
 *
 * `compact` swaps the labelled outline button for an icon-only ghost one —
 * the transcript puts one of these next to every message's timestamp, where
 * a text label would compete with the content it sits beside. It carries no
 * visible text of its own, so the copy/copied state has to live in
 * `aria-label`/`title` instead of the button's rendered text.
 */
export function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: string
  label?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  // The pending "flip back to copy" timeout, so a second click within 1.5s of
  // the first doesn't get its own "copied" state cut short by the first
  // click's timer.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const el = document.createElement('textarea')
        el.value = value
        el.setAttribute('readonly', '')
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        let copiedOk: boolean
        try {
          copiedOk = document.execCommand('copy')
        } finally {
          // Must run whether execCommand throws or returns normally, or the
          // hidden textarea leaks into <body> on every failed click.
          document.body.removeChild(el)
        }
        // execCommand signals failure by returning false, not by throwing.
        if (!copiedOk) throw new Error('execCommand(copy) reported failure')
      }
      clearTimeout(resetTimer.current)
      setCopied(true)
      resetTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      logger.warn('Copy failed; select the text manually', error)
    }
  }

  const text = copied ? t('common.copied') : t('common.copy')

  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={text}
        title={text}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    )
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </Button>
  )
}
