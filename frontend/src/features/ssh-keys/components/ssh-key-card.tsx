import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Code, ConfirmDialog, CopyButton } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemHeader,
  ItemTitle,
} from '@/shared/ui/item'
import { type SshKey, useDeleteSshKey, useTestSshKey } from '../hooks/use-ssh-keys'

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
    <Item variant="outline" render={<article />}>
      <ItemHeader>
        <ItemContent>
          <ItemTitle>{sshKey.name}</ItemTitle>
          {/* Plain text, not a bordered `Code` box: `ItemDescription` is a
              `line-clamp-2` `<p>`, and a box's border overflows its own line
              box, so a clipping ancestor cuts the top border off. The
              fingerprint is also the one thing here with no copy button, so
              it must stay readable in full rather than clamped or truncated
              mid-token. */}
          <ItemDescription className="line-clamp-none wrap-anywhere font-mono">
            {sshKey.fingerprint}
          </ItemDescription>
          {sshKey.comment && (
            <ItemDescription className="line-clamp-none">{sshKey.comment}</ItemDescription>
          )}
        </ItemContent>
        <ItemActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => setConfirmDelete(true)}
          >
            {t('common.delete')}
          </Button>
        </ItemActions>
      </ItemHeader>

      <div className="flex w-full basis-full flex-col gap-3">
        <Code block wrap>
          {sshKey.publicKey}
        </Code>

        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={sshKey.publicKey} label={t('sshKeys.copyPublic')} />
          {/* A short hostname, not a field that should stretch to match the
              buttons either side of it in the row. */}
          <Input
            className="w-40 flex-none"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            aria-label={t('sshKeys.host')}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
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
        </div>

        {/* No explicit "never tested" state: a key that has never been tested
            simply shows no result line, the same way an absent comment above
            renders nothing rather than "No comment". */}
        {result &&
          (result.ok ? (
            <Alert role="status">
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          ))}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
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
    </Item>
  )
}
