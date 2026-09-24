import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { Code, CopyButton } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { type Project, useRetryProject, useUpdateProject } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { httpsEquivalent, isSshRemote } from '../lib/remote-url'

/**
 * One recovery route: a badge classifying it, a title, an explanation, and
 * whatever controls that route needs. Local to this file — the shape is
 * specific to the three routes below, not a candidate for `@/shared/components`.
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
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          {badge}
          <h5 className="text-base font-semibold">{title}</h5>
        </div>
        <p className="text-sm text-muted-foreground">{explain}</p>
        {children}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.recovery.heading')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {project.lastError && (
          <Alert variant="destructive">
            <AlertDescription>
              <Code block wrap>
                {project.lastError}
              </Code>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          {/* 1 — SSH key */}
          {sshRemote && (
            <RecoveryOption
              badge={<Badge variant="secondary">{t('projects.recovery.private')}</Badge>}
              title={t('projects.recovery.keyTitle')}
              explain={t('projects.recovery.keyExplain')}
            >
              {keys.length === 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={() => void navigate({ to: '/ssh-keys' })}>
                    {t('projects.recovery.goToKeys')}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {t('projects.recovery.noKeysYet')}
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    items={keyOptions}
                    value={selectedKey}
                    onValueChange={(next) => setSelectedKey(next ?? '')}
                  >
                    {/* Key names (plus an optional free-text comment) can run
                        long — a bounded, shrinkable width keeps this from
                        crowding out the buttons beside it, with an ellipsis
                        for whatever still overflows. */}
                    <SelectTrigger
                      aria-label={t('projects.form.sshKey')}
                      className="min-w-0 max-w-56"
                    >
                      <SelectValue className="min-w-0 truncate" />
                    </SelectTrigger>
                    <SelectContent>
                      {keyOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <span className="min-w-0 flex-1 truncate" title={option.label}>
                            {option.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" disabled={busy || !selectedKey} onClick={useKeyAndRetry}>
                    {busy && <Spinner data-icon="inline-start" />}
                    {t('projects.recovery.useKeyAndRetry')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void navigate({ to: '/ssh-keys' })}
                  >
                    {t('projects.recovery.manageKeys')}
                  </Button>
                </div>
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
              <div className="flex flex-col items-start gap-2">
                <Code wrap>{httpsUrl}</Code>
                <Button type="button" disabled={busy} onClick={switchToHttpsAndRetry}>
                  {busy && <Spinner data-icon="inline-start" />}
                  {t('projects.recovery.useHttpsAndRetry')}
                </Button>
              </div>
            </RecoveryOption>
          )}

          {/* 3 — do it by hand */}
          <RecoveryOption
            badge={<Badge variant="outline">{t('projects.recovery.manual')}</Badge>}
            title={t('projects.recovery.manualTitle')}
            explain={t('projects.recovery.manualExplain')}
          >
            <div className="flex flex-col items-start gap-2">
              {commands.length > 0 && (
                <Code block wrap>
                  {commands.join('\n')}
                </Code>
              )}
              <div className="flex flex-wrap items-center gap-2">
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
                  {retry.isPending && <Spinner data-icon="inline-start" />}
                  {t('projects.recovery.checkAgain')}
                </Button>
              </div>
            </div>
          </RecoveryOption>
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
