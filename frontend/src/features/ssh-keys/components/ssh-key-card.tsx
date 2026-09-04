import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmDialog,
  CopyButton,
  Inline,
  Input,
  Stack,
} from '@/shared/ui'
import { type SshKey, useDeleteSshKey, useTestSshKey } from '../hooks/use-ssh-keys'
import styles from './ssh-key-card.module.scss'

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
    <Card as="article">
      <Stack gap={3}>
        <Inline justify="between" align="start" gap={3} wrap={false}>
          {/* `Stack`'s flex column turns these two `<code>` siblings (inline
              elements) into stacked block-level flex items, so no wrapper div
              or local class is needed just to put the fingerprint on its own
              line under the name. */}
          <Stack gap={1}>
            <h3 className={styles.name}>{sshKey.name}</h3>
            <Code>{sshKey.fingerprint}</Code>
            {sshKey.comment && <Code>{sshKey.comment}</Code>}
          </Stack>
          <Button type="button" disabled={remove.isPending} onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        </Inline>

        <Code block wrap>
          {sshKey.publicKey}
        </Code>

        <Inline gap={2}>
          <CopyButton value={sshKey.publicKey} label={t('sshKeys.copyPublic')} />
          <div className={styles.hostField}>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              aria-label={t('sshKeys.host')}
            />
          </div>
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
        </Inline>

        {/* No explicit "never tested" state: a key that has never been tested
            simply shows no result line, the same way an absent comment above
            renders nothing rather than "No comment". A tri-state message here
            would need new copy, and the locale files it would live in
            (src/shared/i18n) are outside the three files this migration owns. */}
        {result && <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </Stack>

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
    </Card>
  )
}
