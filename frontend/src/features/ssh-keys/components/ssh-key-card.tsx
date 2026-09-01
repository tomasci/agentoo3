import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button, ConfirmDialog, CopyButton } from '@/shared/ui'
import { type SshKey, useDeleteSshKey, useTestSshKey } from '../hooks/use-ssh-keys'
import styles from './ssh-keys-page.module.scss'

export function SshKeyCard({ sshKey }: { sshKey: SshKey }) {
  const { t } = useTranslation()
  const [host, setHost] = useState('github.com')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const test = useTestSshKey()
  const remove = useDeleteSshKey()

  // The stored result is what the last test said; a fresh one replaces it.
  const result =
    test.data ??
    (sshKey.lastTestOk === null
      ? undefined
      : {
          ok: sshKey.lastTestOk,
          message: sshKey.lastTestMessage ?? '',
        })

  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div>
          <h3 className={styles.name}>{sshKey.name}</h3>
          <p className={styles.fingerprint}>{sshKey.fingerprint}</p>
          {sshKey.comment && <p className={styles.fingerprint}>{sshKey.comment}</p>}
        </div>
        <Button type="button" disabled={remove.isPending} onClick={() => setConfirmDelete(true)}>
          {t('common.delete')}
        </Button>
      </div>

      <pre className={styles.pubkey}>{sshKey.publicKey}</pre>

      <div className={styles.actions}>
        <CopyButton value={sshKey.publicKey} label={t('sshKeys.copyPublic')} />
        <input
          className={styles.hostInput}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          aria-label={t('sshKeys.host')}
        />
        <Button
          type="button"
          disabled={test.isPending}
          onClick={() => {
            setError(null)
            test.mutate(
              { path: { id: sshKey.id }, body: { host } },
              { onError: (e) => setError(apiErrorMessage(e, t('sshKeys.testFailed'))) },
            )
          }}
        >
          {test.isPending ? t('sshKeys.testing') : t('sshKeys.test')}
        </Button>
        {result && (
          <span className={`${styles.testResult} ${result.ok ? styles.ok : styles.bad}`}>
            {result.message}
          </span>
        )}
        {error && <span className={styles.error}>{error}</span>}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('sshKeys.deleteTitle')}
        description={t('sshKeys.deleteConfirm', { name: sshKey.name })}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate({ path: { id: sshKey.id } }, { onSettled: () => setConfirmDelete(false) })
        }
      />
    </article>
  )
}
