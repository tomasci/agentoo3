import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logger } from '@/shared/lib/logger'
import { Button } from './button'

/**
 * Copy to clipboard, with a fallback.
 *
 * navigator.clipboard is unavailable on a plain-HTTP origin outside localhost —
 * which is exactly how this app is served over the tailnet — so the legacy
 * execCommand path is the one that will usually run, not a curiosity.
 */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

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
        document.execCommand('copy')
        document.body.removeChild(el)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      logger.warn('Copy failed; select the text manually', error)
    }
  }

  return (
    <Button type="button" onClick={() => void copy()}>
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </Button>
  )
}
