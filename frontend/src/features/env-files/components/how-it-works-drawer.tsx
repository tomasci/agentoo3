import { CircleHelpIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Code } from '@/shared/components'
import { Button } from '@/shared/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/shared/ui/drawer'

// One of the three real-world shapes the layout section walks through — the
// one that needs a code sample rather than a sentence.
const COMPOSE_SNIPPET = 'services:\n  server:\n    env_file: ./server/.env'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>
    </section>
  )
}

/**
 * The guide behind the env files page's "How it works" button — what the
 * store does, the three layouts it's meant to cover, the copy rules, and
 * where the files actually live. `PageHeader`'s `actions` slot
 * (env-files-page.tsx) is this component's only mount point, so it owns both
 * the trigger button and the drawer itself rather than splitting the two
 * across caller and callee.
 *
 * `swipeDirection="right"`, not the component's own `"down"` default: a
 * reference guide reads better as a side panel the reader can leave open
 * next to the files it explains than as a bottom sheet covering them.
 */
export function HowItWorksDrawer() {
  const { t } = useTranslation()

  return (
    <Drawer swipeDirection="right">
      <DrawerTrigger
        render={
          <Button type="button" variant="outline">
            <CircleHelpIcon />
            {t('envFiles.howItWorks.trigger')}
          </Button>
        }
      />
      <DrawerContent className="sm:[--drawer-content-width:28rem]">
        <DrawerHeader>
          <DrawerTitle>{t('envFiles.howItWorks.title')}</DrawerTitle>
          <DrawerDescription className="text-pretty">
            {t('envFiles.howItWorks.intro')}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-4">
          <Section title={t('envFiles.howItWorks.layouts.title')}>
            <p>{t('envFiles.howItWorks.layouts.rootOnly')}</p>
            <p>{t('envFiles.howItWorks.layouts.serverWebapp')}</p>
            <div className="flex flex-col gap-1.5">
              <p>{t('envFiles.howItWorks.layouts.compose')}</p>
              <Code block>{COMPOSE_SNIPPET}</Code>
            </div>
          </Section>

          <Section title={t('envFiles.howItWorks.rules.title')}>
            <ul className="list-disc space-y-1 pl-4">
              <li>{t('envFiles.howItWorks.rules.onCreateOnly')}</li>
              <li>{t('envFiles.howItWorks.rules.branchWins')}</li>
              <li>{t('envFiles.howItWorks.rules.keptOutOfGit')}</li>
              <li>{t('envFiles.howItWorks.rules.allowedNames')}</li>
            </ul>
          </Section>

          <Section title={t('envFiles.howItWorks.storage.title')}>
            <p>{t('envFiles.howItWorks.storage.location')}</p>
            <p>{t('envFiles.howItWorks.storage.untouched')}</p>
          </Section>
        </div>

        <DrawerFooter>
          <DrawerClose render={<Button type="button" variant="outline" />}>
            {t('common.close')}
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
