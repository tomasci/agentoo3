import { useAtom } from 'jotai'
import { XIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/shared/components'
import { env } from '@/shared/config/env'
import { logger } from '@/shared/lib/logger'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Separator } from '@/shared/ui/separator'
import { useDismissWhatsNew } from '../hooks/use-dismiss-whats-new'
import { useWhatsNew } from '../hooks/use-whats-new'
import { releases } from '../model/changelog'
import { whatsNewOpenAtom } from '../model/open-state'
import { ReleaseEntry } from './release-entry'

/**
 * The operator's "Update installed" screen, mounted once in app/root-layout.tsx's
 * `Shell` (never providers.tsx — see that file's own comment on why: the bare
 * editor launcher route renders with no Shell at all, and this must not show
 * there). Fully controlled by `whatsNewOpenAtom`; it never renders its own
 * `DialogTrigger` — the only two things that open it are the auto-open effect
 * below and the status bar's version button (use-open-whats-new.ts).
 *
 * Full-screen with a blurred backdrop is a deliberate exception to "don't
 * restyle a shadcn component" (frontend/README.md's "Styling"), the same kind
 * the status bar's own `HostMetric` already carries by name: the operator
 * asked for a full-viewport screen with the app visibly blurred behind it,
 * which the default centered, capped-width popup can't give.
 */
export function WhatsNewScreen() {
  const { t, i18n } = useTranslation()
  const { data } = useWhatsNew()
  const [mode, setMode] = useAtom(whatsNewOpenAtom)
  const dismiss = useDismissWhatsNew()

  // Latches shut the moment the screen has been shown once this page load —
  // by this effect itself, or by the operator opening it manually (the status
  // bar's button) before GET /whats-new even answered — so a later refetch
  // that still says pending, or an answer that only now arrives, never shows
  // the screen a second time or takes over an open the operator already
  // started. Set directly in the render body, the same way `markdown-editor.tsx`
  // mutates its own refs outside an effect: this needs to be true *before* the
  // effect below can run for a `data?.pending` that lands the same commit, not
  // one tick later. Nothing here is ever dismissed by a manual close, so if
  // the install is still pending, the next page load auto-opens properly.
  const autoOpenedRef = useRef(false)
  if (mode !== null) autoOpenedRef.current = true
  useEffect(() => {
    if (autoOpenedRef.current || !data?.pending) return
    autoOpenedRef.current = true
    setMode('installed')
  }, [data?.pending, setMode])

  const installedVersion = data?.installedVersion ?? env.appVersion

  // Called only with `false`: nothing here renders a DialogTrigger, so Base
  // UI only ever reaches this from an Esc press, an outside press, or the
  // close affordances inside DialogContent (the feature's own "X" below and
  // the DialogClose-wrapped footer button) — every route the brief calls
  // "close" by.
  const handleOpenChange = (open: boolean) => {
    if (open) return
    const wasInstalled = mode === 'installed'
    const installedAt = data?.installedAt
    setMode(null)
    if (!wasInstalled || !installedAt) return
    dismiss.mutate(
      { body: { installedAt } },
      {
        onError: (error) => {
          // Never traps the operator behind a failed request — the screen is
          // already closed above, regardless of how this turns out. The toast
          // stays a localized, generic message rather than the raw request
          // error: apiErrorMessage would otherwise surface something like
          // "Request failed with status code 500" verbatim, which names
          // nothing the operator can act on. The raw error still reaches the
          // logger, for anyone actually debugging it.
          logger.warn('Could not dismiss the what’s new screen', error)
          toast.add({ type: 'error', title: t('whatsNew.dismissFailed') })
        },
      },
    )
  }

  return (
    <Dialog open={mode !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background/60 p-0 text-foreground ring-0 backdrop-blur-lg sm:max-w-none"
      >
        <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-4 px-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] pr-[calc(env(safe-area-inset-right)+1.5rem)] pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pl-[calc(env(safe-area-inset-left)+1.5rem)]">
          <div className="flex shrink-0 items-start justify-between gap-4">
            <DialogHeader>
              <DialogTitle className="text-xl">
                {mode === 'installed'
                  ? t('whatsNew.installedTitle', { version: installedVersion })
                  : t('whatsNew.manualTitle')}
              </DialogTitle>
              <DialogDescription>
                {mode === 'installed'
                  ? t('whatsNew.installedSubtitle')
                  : t('whatsNew.manualSubtitle', { version: installedVersion })}
              </DialogDescription>
            </DialogHeader>

            {/* The feature's own close "X" rather than DialogContent's
                generated one (`showCloseButton={false}` above): the generated
                one is positioned `absolute top-2 right-2` against the popup
                itself, which ignores the safe-area padding this screen
                otherwise insets everything by, and its screen-reader label is
                a hardcoded English "Close" (frontend/README.md's "A known
                i18n gap"). Rendered here, inside the same padded column as
                everything else, with a translated name instead. */}
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={t('whatsNew.closeX')}
                />
              }
            >
              <XIcon aria-hidden="true" />
            </DialogClose>
          </div>

          {/* `<section>` with an aria-label picks up the implicit "region"
              landmark role on its own — no `role="region"` needed, which
              would otherwise also pull in a second, unrelated biome warning
              (lint/a11y/useSemanticElements) on the same element as the
              tabIndex ignore below; biome's suppression comment only covers
              the line directly under it, not the whole element, so the two
              can't share one ignore comment above the opening tag.

              `p-1 -m-1`: without it the focus ring (`focus-visible:ring-3`,
              drawn at this element's own edge) sits flush against the
              changelog text, since neither this section nor the `<ol>` it
              wraps carries any padding of its own. The negative margin
              cancels the padding's own footprint so the list still lines up
              with the header above — the same technique
              idea-board-page.tsx's own comment on its card strip uses, for
              the same reason. */}
          <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable changelog list with nothing to activate — a button would promise interactivity that isn't there; it still needs a stop in the tab order, the only way a keyboard user (no scroll wheel, no touch) can reach and scroll it at all.
            tabIndex={0}
            aria-label={t('whatsNew.changelogLabel')}
            className="min-h-0 flex-1 -m-1 overflow-y-auto p-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ol className="flex flex-col gap-5">
              {releases.map((release, index) => (
                <li key={release.version}>
                  {index > 0 && <Separator className="mb-5" />}
                  <ReleaseEntry release={release} language={i18n.language} />
                </li>
              ))}
            </ol>
          </section>

          <DialogFooter className="mx-0 mb-0 justify-center rounded-none border-0 bg-transparent p-0 pt-2 sm:justify-center">
            <DialogClose render={<Button className="w-full sm:w-auto" />}>
              {t('whatsNew.close')}
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
