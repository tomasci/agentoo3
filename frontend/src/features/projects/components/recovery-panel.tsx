import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { Button, CopyButton } from '@/shared/ui'
import { type Project, useRetryProject, useUpdateProject } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { httpsEquivalent, isSshRemote } from '../lib/remote-url'
import styles from './recovery-panel.module.scss'

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

  return (
    <div className={styles.panel}>
      <h4 className={styles.heading}>{t('projects.recovery.heading')}</h4>

      {project.lastError && <pre className={styles.error}>{project.lastError}</pre>}

      <div className={styles.options}>
        {/* 1 — SSH key */}
        {sshRemote && (
          <section className={styles.option}>
            <div className={styles.optionHead}>
              <span className={`${styles.badge} ${styles.recommended}`}>
                {t('projects.recovery.private')}
              </span>
              <h5 className={styles.optionTitle}>{t('projects.recovery.keyTitle')}</h5>
            </div>
            <p className={styles.explain}>{t('projects.recovery.keyExplain')}</p>

            {keys.length === 0 ? (
              <div className={styles.row}>
                <Button type="button" onClick={() => void navigate({ to: '/ssh-keys' })}>
                  {t('projects.recovery.goToKeys')}
                </Button>
                <span className={styles.explain}>{t('projects.recovery.noKeysYet')}</span>
              </div>
            ) : (
              <div className={styles.row}>
                <select
                  className={styles.select}
                  value={selectedKey}
                  onChange={(e) => setSelectedKey(e.target.value)}
                  aria-label={t('projects.form.sshKey')}
                >
                  <option value="">{t('projects.form.sshKeyNone')}</option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                      {k.comment ? ` — ${k.comment}` : ''}
                    </option>
                  ))}
                </select>
                <Button type="button" disabled={busy || !selectedKey} onClick={useKeyAndRetry}>
                  {busy ? t('projects.recovery.working') : t('projects.recovery.useKeyAndRetry')}
                </Button>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void navigate({ to: '/ssh-keys' })}
                >
                  {t('projects.recovery.manageKeys')}
                </button>
              </div>
            )}
          </section>
        )}

        {/* 2 — https, which needs no key at all for a public repo */}
        {sshRemote && httpsUrl && (
          <section className={styles.option}>
            <div className={styles.optionHead}>
              <span className={styles.badge}>{t('projects.recovery.public')}</span>
              <h5 className={styles.optionTitle}>{t('projects.recovery.httpsTitle')}</h5>
            </div>
            <p className={styles.explain}>{t('projects.recovery.httpsExplain')}</p>
            <div className={styles.row}>
              <code className={styles.mono}>{httpsUrl}</code>
            </div>
            <div className={styles.row} style={{ marginTop: '0.5rem' }}>
              <Button type="button" disabled={busy} onClick={switchToHttpsAndRetry}>
                {busy ? t('projects.recovery.working') : t('projects.recovery.useHttpsAndRetry')}
              </Button>
            </div>
          </section>
        )}

        {/* 3 — do it by hand */}
        <section className={styles.option}>
          <div className={styles.optionHead}>
            <span className={styles.badge}>{t('projects.recovery.manual')}</span>
            <h5 className={styles.optionTitle}>{t('projects.recovery.manualTitle')}</h5>
          </div>
          <p className={styles.explain}>{t('projects.recovery.manualExplain')}</p>

          {commands.length > 0 && (
            <div className={styles.commands}>
              {commands.map((line) => (
                <code key={line}>{line}</code>
              ))}
            </div>
          )}

          <div className={styles.row}>
            {commands.length > 0 && (
              <CopyButton value={commands.join('\n')} label={t('projects.recovery.copy')} />
            )}
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setFailure(null)
                retry.mutate({ path: { id: project.id } }, { onError: fail })
              }}
            >
              {retry.isPending
                ? t('projects.recovery.checking')
                : t('projects.recovery.checkAgain')}
            </Button>
          </div>
        </section>
      </div>

      {failure && <p className={styles.failure}>{failure}</p>}
    </div>
  )
}
