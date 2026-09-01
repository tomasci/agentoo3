import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { pageAtom } from '@/shared/store/ui'
import { Button, CopyButton } from '@/shared/ui'
import { type Project, useRetryProject } from '../hooks/use-projects'
import styles from './recovery-panel.module.scss'

/**
 * Shown when a clone failed on authentication.
 *
 * The server deliberately never prompts for credentials (git runs with prompts
 * disabled), so a private repo cannot be cloned unattended. The way out is for
 * the operator to run the clone themselves over SSH, where git *can* ask for a
 * passphrase, and then tell us to look again.
 */
export function RecoveryPanel({ project }: { project: Project }) {
  const { t } = useTranslation()
  const retry = useRetryProject()
  const [, setPage] = useAtom(pageAtom)

  // An ssh remote with no key attached has a much better answer than "run these
  // commands by hand": generate a deploy key and select it.
  const isSshRemote = Boolean(project.remoteUrl && !project.remoteUrl.startsWith('http'))
  const suggestKey = isSshRemote && !project.sshKeyId

  const commands = project.recoveryCommands ?? []
  const asText = commands.join('\n')

  return (
    <div className={styles.panel}>
      <h4 className={styles.heading}>{t('projects.recovery.heading')}</h4>
      <p className={styles.explain}>{t('projects.recovery.explain')}</p>

      {suggestKey && (
        <p className={styles.explain}>
          {t('projects.recovery.suggestKey')}{' '}
          <button type="button" className={styles.link} onClick={() => setPage('ssh-keys')}>
            {t('projects.recovery.goToKeys')}
          </button>
        </p>
      )}

      {project.lastError && <pre className={styles.error}>{project.lastError}</pre>}

      {commands.length > 0 && (
        <div className={styles.commands}>
          {commands.map((line) => (
            <code key={line}>{line}</code>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        {commands.length > 0 && <CopyButton value={asText} label={t('projects.recovery.copy')} />}
        <Button
          type="button"
          disabled={retry.isPending}
          onClick={() => retry.mutate({ path: { id: project.id } })}
        >
          {retry.isPending ? t('projects.recovery.checking') : t('projects.recovery.checkAgain')}
        </Button>
      </div>
    </div>
  )
}
