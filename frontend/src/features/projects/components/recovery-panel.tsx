import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { Alert, Badge, Button, Code, CopyButton, Inline, Select, Stack } from '@/shared/ui'
import { type Project, useRetryProject, useUpdateProject } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { httpsEquivalent, isSshRemote } from '../lib/remote-url'
import styles from './recovery-panel.module.scss'

/**
 * One recovery route: a badge classifying it, a title, an explanation, and
 * whatever controls that route needs. Local to this file — the shape is
 * specific to the three routes below, not a candidate for `shared/ui`.
 */
function RecoveryOption({
  badge,
  title,
  explain,
  children,
}: {
  badge: ReactNode
  title: string
  explain: string
  children: ReactNode
}) {
  return (
    <section className={styles.option}>
      <Stack gap={2}>
        <Inline gap={2} align="baseline">
          {badge}
          <h5 className={styles.optionTitle}>{title}</h5>
        </Inline>
        <p className={styles.explain}>{explain}</p>
        {children}
      </Stack>
    </section>
  )
}

/**
 * Shown when setup failed on authentication.
 *
 * Three routes out rather than one, because the right answer depends on facts
 * the operator has and we do not — chiefly whether the repository is private.
 * SSH is never anonymous, so a *public* repo cloned over ssh fails exactly like
 * a private one, and for that case switching to https is far less work than
 * provisioning a deploy key.
 */
export function RecoveryPanel({ project }: { project: Project }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: sshKeys } = useSshKeys()
  const retry = useRetryProject()
  const update = useUpdateProject()
  const [selectedKey, setSelectedKey] = useState(project.sshKeyId ?? '')
  const [failure, setFailure] = useState<string | null>(null)

  const keys = sshKeys ?? []
  const sshRemote = isSshRemote(project.remoteUrl)
  const httpsUrl = httpsEquivalent(project.remoteUrl)
  const busy = retry.isPending || update.isPending

  const fail = (error: unknown) => setFailure(apiErrorMessage(error, t('projects.recovery.failed')))

  const useKeyAndRetry = () => {
    setFailure(null)
    update.mutate(
      { path: { id: project.id }, body: { sshKeyId: selectedKey || null } },
      {
        onSuccess: () => retry.mutate({ path: { id: project.id } }, { onError: fail }),
        onError: fail,
      },
    )
  }

  const switchToHttpsAndRetry = () => {
    if (!httpsUrl) return
    setFailure(null)
    update.mutate(
      // Clear the key as well: an https remote never uses one, and leaving it
      // set would be misleading.
      { path: { id: project.id }, body: { remoteUrl: httpsUrl, sshKeyId: null } },
      {
        onSuccess: () => retry.mutate({ path: { id: project.id } }, { onError: fail }),
        onError: fail,
      },
    )
  }

  const commands = project.recoveryCommands ?? []
  const keyOptions = [
    { value: '', label: t('projects.form.sshKeyNone') },
    ...keys.map((k) => ({
      value: k.id,
      label: k.comment ? `${k.name} — ${k.comment}` : k.name,
    })),
  ]

  return (
    <div className={styles.panel}>
      <Stack gap={3}>
        <h4 className={styles.heading}>{t('projects.recovery.heading')}</h4>

        {project.lastError && (
          <Alert tone="danger">
            <Code block wrap>
              {project.lastError}
            </Code>
          </Alert>
        )}

        <Stack gap={2}>
          {/* 1 — SSH key */}
          {sshRemote && (
            <RecoveryOption
              badge={
                <Badge tone="accent" variant="soft">
                  {t('projects.recovery.private')}
                </Badge>
              }
              title={t('projects.recovery.keyTitle')}
              explain={t('projects.recovery.keyExplain')}
            >
              {keys.length === 0 ? (
                <Inline gap={2}>
                  <Button type="button" onClick={() => void navigate({ to: '/ssh-keys' })}>
                    {t('projects.recovery.goToKeys')}
                  </Button>
                  <span className={styles.explain}>{t('projects.recovery.noKeysYet')}</span>
                </Inline>
              ) : (
                <Inline gap={2}>
                  <Select
                    options={keyOptions}
                    value={selectedKey}
                    onValueChange={(next) => setSelectedKey(next ?? '')}
                  />
                  <Button
                    type="button"
                    loading={busy}
                    loadingLabel={t('projects.recovery.working')}
                    disabled={!selectedKey}
                    onClick={useKeyAndRetry}
                  >
                    {t('projects.recovery.useKeyAndRetry')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void navigate({ to: '/ssh-keys' })}
                  >
                    {t('projects.recovery.manageKeys')}
                  </Button>
                </Inline>
              )}
            </RecoveryOption>
          )}

          {/* 2 — https, which needs no key at all for a public repo */}
          {sshRemote && httpsUrl && (
            <RecoveryOption
              badge={<Badge variant="outline">{t('projects.recovery.public')}</Badge>}
              title={t('projects.recovery.httpsTitle')}
              explain={t('projects.recovery.httpsExplain')}
            >
              <Stack gap={2} align="start">
                <Code wrap>{httpsUrl}</Code>
                <Button
                  type="button"
                  loading={busy}
                  loadingLabel={t('projects.recovery.working')}
                  onClick={switchToHttpsAndRetry}
                >
                  {t('projects.recovery.useHttpsAndRetry')}
                </Button>
              </Stack>
            </RecoveryOption>
          )}

          {/* 3 — do it by hand */}
          <RecoveryOption
            badge={<Badge variant="outline">{t('projects.recovery.manual')}</Badge>}
            title={t('projects.recovery.manualTitle')}
            explain={t('projects.recovery.manualExplain')}
          >
            <Stack gap={2} align="start">
              {commands.length > 0 && (
                <Code block wrap>
                  {commands.join('\n')}
                </Code>
              )}
              <Inline gap={2}>
                {commands.length > 0 && (
                  <CopyButton value={commands.join('\n')} label={t('projects.recovery.copy')} />
                )}
                <Button
                  type="button"
                  loading={retry.isPending}
                  loadingLabel={t('projects.recovery.checking')}
                  disabled={busy}
                  onClick={() => {
                    setFailure(null)
                    retry.mutate({ path: { id: project.id } }, { onError: fail })
                  }}
                >
                  {t('projects.recovery.checkAgain')}
                </Button>
              </Inline>
            </Stack>
          </RecoveryOption>
        </Stack>

        {failure && <Alert tone="danger">{failure}</Alert>}
      </Stack>
    </div>
  )
}
