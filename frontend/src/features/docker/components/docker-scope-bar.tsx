import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { type Session, useSessions } from '@/features/sessions'
import { Alert, Field, Select, type SelectOption, Stack } from '@/shared/ui'
import styles from './docker-scope-bar.module.scss'

/**
 * Not a real session id — Ark's `Select` needs a value for every option, and
 * `undefined` (what `sessionId` actually is at repo scope) is not one.
 *
 * Exported so docker-page.test.tsx can drive the switcher by value without
 * hard-coding this sentinel a second time.
 */
export const REPO_SCOPE = '__repo__'

type T = (key: string, opts?: Record<string, unknown>) => string

function sessionLabel(session: Session, t: T): string {
  return session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) })
}

/** The banner's own wording — name *and* branch, so "which session" never
 *  has to be guessed from a title alone (sessions from the same idea often
 *  share a similar title; the branch is what actually differs). */
function sessionDescriptor(session: Session, t: T): string {
  const name = sessionLabel(session, t)
  return session.branch ? `${name} (${session.branch})` : name
}

interface DockerScopeBarProps {
  projectId: string
  /** Absent means the project's own repo/ checkout — the same convention
   *  the query param and every hook in this feature already use. */
  sessionId?: string
}

/**
 * Which checkout this page is pointed at, and a control to point it
 * somewhere else instead.
 *
 * A compose stack started against a session's worktree renders identically
 * to one started against the project's own repo/ checkout — same services,
 * same containers, same everything else this page shows — so this banner is
 * the one thing here whose entire job is making sure nobody mistakes one
 * scope for the other, or starts a stack in the wrong one by not noticing
 * which tab they were already on.
 *
 * Only an isolated session has a worktree of its own to run docker in — a
 * shared-checkout session 400s (backend/src/features/docker/scope.ts) — so
 * the switcher never offers one at all, rather than offering it and then
 * showing the rejection.
 *
 * Reads the sessions list itself rather than taking it as a prop: nothing
 * else on this page needs it, and `useSessions` (features/sessions) is
 * already the shared, cached way anything reads a project's sessions.
 */
export function DockerScopeBar({ projectId, sessionId }: DockerScopeBarProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const sessions = useSessions(projectId)

  const isolated = (sessions.data ?? []).filter((s) => s.isolated)
  const current = isolated.find((s) => s.id === sessionId)

  const options: SelectOption[] = [
    { value: REPO_SCOPE, label: t('docker.scope.repoOption') },
    ...isolated.map((s) => ({
      value: s.id,
      label: sessionLabel(s, t),
      description: s.branch ?? undefined,
    })),
  ]
  // The URL can name a session this project's own list does not (yet) agree
  // with — still loading, or a link followed after the session stopped
  // being isolated or was deleted — and the trigger has to show *something*
  // rather than fall back to its placeholder, which would read as "no scope
  // chosen" when one very much has been.
  if (sessionId && !current) {
    options.push({ value: sessionId, label: t('docker.scope.unknownSession') })
  }

  const goTo = (value: string | null) => {
    if (!value || value === (sessionId ?? REPO_SCOPE)) return
    if (value === REPO_SCOPE) {
      void navigate({ to: '/projects/$projectId/docker', params: { projectId } })
    } else {
      void navigate({
        to: '/projects/$projectId/sessions/$sessionId/docker',
        params: { projectId, sessionId: value },
      })
    }
  }

  return (
    <Alert tone="accent">
      <Stack gap={3}>
        <p>
          {sessionId
            ? t('docker.scope.sessionBanner', {
                name: current ? sessionDescriptor(current, t) : t('docker.scope.unknownSession'),
              })
            : t('docker.scope.repoBanner')}
        </p>
        <div className={styles.switcher}>
          <Field label={t('docker.scope.switcherLabel')} labelHidden>
            <Select
              options={options}
              value={sessionId ?? REPO_SCOPE}
              onValueChange={goTo}
              size="sm"
            />
          </Field>
        </div>
      </Stack>
    </Alert>
  )
}
