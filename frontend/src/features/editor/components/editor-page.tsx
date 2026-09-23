import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { useSession } from '@/features/sessions'
import { Alert, Button, Code, EmptyState, Inline, Spinner, Stack, toast } from '@/shared/ui'
import { useEditorStart, useEditorStatus, useEditorStop } from '../hooks/use-editor'
import styles from './editor-page.module.scss'
import { EditorStartLog } from './editor-start-log'

const SECONDS_PER_MINUTE = 60

/**
 * A session's own code-server (VS Code in the browser) — a container with no
 * network of its own and no persistence (design doc's "Runtime" section),
 * reached here only through the backend's same-origin HTTP+WebSocket proxy at
 * `status.proxyPath`.
 *
 * Mirrors `DockerPage` (features/docker/components/docker-page.tsx) in shape
 * — poll a status, gate on enabled/daemon/state, surface the one operation in
 * flight — but shares no code with it: `features/editor` owns a different
 * Docker primitive (one code-server container, not a compose stack) and is
 * not allowed to import from `features/docker` at all, so the two features
 * can change independently of one another.
 *
 * Full-bleed (editor-page.module.scss, shared/store/tabs.ts's
 * `isFullBleedPath`): the workbench iframe is the page, not something sitting
 * inside one.
 *
 * Never starts anything on mount. A tab remembers whatever route it was last
 * on (shared/store/tabs.ts) and restores it on reload — auto-starting here
 * would mean just reopening the app spins up containers as a side effect.
 */
export function EditorPage({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const status = useEditorStatus(projectId, sessionId)
  const start = useEditorStart(projectId, sessionId)
  const stop = useEditorStop(projectId, sessionId)

  const fail = (fallbackKey: string) => (error: unknown) =>
    toast({ title: apiErrorMessage(error, t(fallbackKey)), tone: 'danger' })

  const triggerStart = () =>
    start.mutate(
      { path: { id: projectId, sessionId } },
      { onError: fail('editor.errors.startFailed') },
    )
  const triggerStop = () =>
    stop.mutate(
      { path: { id: projectId, sessionId } },
      { onError: fail('editor.errors.stopFailed') },
    )

  // The same "Session <short id>" fallback SessionPage and DockerScopeBar use
  // while the session query is still loading, or for one with no title.
  const sessionName = session.data?.title ?? t('sessions.untitled', { id: sessionId.slice(0, 8) })
  const sessionDescriptor = session.data?.branch
    ? `${sessionName} (${session.data.branch})`
    : sessionName

  const data = status.data
  // 'unresponsive' is one slow health check away from 'running' again, not a
  // reason to treat the workbench as unreachable — both states keep the
  // iframe, the "open in new tab" link and the header's own Stop control.
  const reachable = data?.state === 'running' || data?.state === 'unresponsive'
  const minutes = data ? Math.round(data.idleTimeoutSeconds / SECONDS_PER_MINUTE) : 0

  let body: ReactNode
  if (status.isPending) {
    body = (
      <div className={styles.content}>
        <Spinner label={t('common.loading')} block />
      </div>
    )
  } else if (status.isError || !data) {
    body = (
      <div className={styles.content}>
        <Alert tone="danger">{apiErrorMessage(status.error, t('editor.loadFailed'))}</Alert>
      </div>
    )
  } else if (!data.enabled) {
    body = (
      <div className={styles.content}>
        <EmptyState title={t('editor.empty.title')} description={t('editor.empty.description')} />
      </div>
    )
  } else if (!data.daemon.cliInstalled || !data.daemon.available) {
    body = (
      <div className={styles.content}>
        <Alert
          tone="danger"
          title={
            data.daemon.cliInstalled
              ? t('editor.daemon.unavailableTitle')
              : t('editor.daemon.notInstalledTitle')
          }
        >
          <Stack gap={2}>
            <p>
              {data.daemon.cliInstalled
                ? t('editor.daemon.unavailable')
                : t('editor.daemon.notInstalled')}
            </p>
            {data.daemon.error && (
              <Code block wrap>
                {data.daemon.error}
              </Code>
            )}
          </Stack>
        </Alert>
      </div>
    )
  } else if (data.state === 'stopped') {
    body = (
      <div className={styles.content}>
        <Stack gap={4}>
          {data.operation?.status === 'failed' && (
            <Alert tone="danger" title={t('editor.operationFailed')}>
              <Stack gap={3}>
                {data.operation.error && <p>{data.operation.error}</p>}
                <EditorStartLog operation={data.operation} />
              </Stack>
            </Alert>
          )}
          <Button type="button" loading={start.isPending} onClick={triggerStart}>
            {t('editor.start')}
          </Button>
        </Stack>
      </div>
    )
  } else if (data.state === 'starting') {
    body = (
      <div className={styles.content}>
        <Stack gap={4}>
          <Spinner label={t('editor.state.startingTitle')} block />
          <p>{t('editor.state.startingNote')}</p>
          <EditorStartLog operation={data.operation} />
        </Stack>
      </div>
    )
  } else {
    // 'running' or 'unresponsive'. The iframe is the very same DOM node
    // across a transition between the two: it is rendered unconditionally
    // here, with the banner above it appearing/disappearing as a sibling
    // rather than wrapping or replacing it — one slow health check must not
    // throw away a workbench full of unsaved editor state.
    body = (
      <div className={styles.body}>
        {data.state === 'unresponsive' && (
          <Alert
            tone="warning"
            title={t('editor.state.unresponsiveTitle')}
            action={
              <Inline gap={2}>
                <Button type="button" size="sm" loading={start.isPending} onClick={triggerStart}>
                  {t('editor.restart')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={stop.isPending}
                  onClick={triggerStop}
                >
                  {t('editor.stop')}
                </Button>
              </Inline>
            }
          >
            {t('editor.state.unresponsiveBody')}
          </Alert>
        )}
        <iframe
          src={data.proxyPath}
          title={t('editor.iframeTitle', { name: sessionDescriptor })}
          allow="clipboard-read; clipboard-write"
          className={styles.frame}
        />
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('editor.heading')}</h1>
        <span className={styles.meta}>{sessionDescriptor}</span>
        {data?.enabled && minutes > 0 && (
          <span className={styles.idleNote}>{t('editor.idleNote', { count: minutes })}</span>
        )}
        <div className={styles.actions}>
          {reachable && data && (
            <a href={data.proxyPath} target="_blank" rel="noopener">
              {t('editor.openInNewTab')}
            </a>
          )}
          {reachable && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={stop.isPending}
              onClick={triggerStop}
            >
              {t('editor.stop')}
            </Button>
          )}
          <Button asChild variant="secondary" size="sm">
            <Link to="/projects/$projectId/sessions/$sessionId" params={{ projectId, sessionId }}>
              {t('editor.backToSession')}
            </Link>
          </Button>
        </div>
      </header>

      {/* Non-blocking: editing, highlighting and IntelliSense all work over
          plain HTTP. Only webviews, the Markdown preview and clipboard access
          need a secure context — see the design doc's own "Risks" §7. */}
      {window.isSecureContext === false && (
        <Alert tone="warning">{t('editor.insecureContext')}</Alert>
      )}

      {body}
    </div>
  )
}
