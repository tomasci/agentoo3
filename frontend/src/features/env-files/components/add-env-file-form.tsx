import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { type EnvFile, usePutEnvFile } from '../hooks/use-env-files'
import { checkEnvFilePath } from '../lib/path-rules'
import { FormField } from './form-field'

// Offered only while the store is empty, and only ever the two shapes a
// first-time reader is most likely to want — this is a nudge, not a catalog
// of every path path-rules.ts allows.
const SUGGESTIONS = ['.env', 'server/.env']

interface AddEnvFileFormProps {
  projectId: string
  files: EnvFile[]
  /** The list query's own `isSuccess` — `false` while it's still loading or
   * after it failed, in which case `files` above is `[]` whether or not the
   * store actually has anything in it. The duplicate guard below only ever
   * sees `files`, so on an unloaded list it can't tell a real empty store
   * from "unknown", and PUT is an upsert: a false negative there would
   * silently overwrite whatever is already saved. Disabling the form (and the
   * submit below) until this is `true` is what keeps that from happening. */
  filesLoaded: boolean
  /** Fires with the path just created, or the existing one a duplicate
   * resolved to — the page uses this to scroll/focus that file's card. */
  onAdded: (path: string) => void
}

/**
 * Adds a path to the store with empty content: this and `EnvFileCard`'s own
 * Save button are the same PUT (`usePutEnvFile`'s one request body), so a
 * file and its parent folders exist, and show up in the list, before a
 * single byte is typed into it.
 */
export function AddEnvFileForm({ projectId, files, filesLoaded, onAdded }: AddEnvFileFormProps) {
  const { t } = useTranslation()
  const put = usePutEnvFile(projectId)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (candidate: string) => {
    // Belt-and-suspenders alongside the disabled Input/Button below: a click
    // already in flight when the list finishes loading (or failing) must not
    // slip through on a button that was enabled a tick ago.
    if (!filesLoaded) return

    const trimmed = candidate.trim()
    if (!trimmed) return

    // Adding a path already in the store would silently wipe out whatever
    // was saved there — scrolling to it instead is what "add" means for a
    // file that already exists.
    const existing = files.find((file) => file.path === trimmed)
    if (existing) {
      setError(null)
      setPath('')
      onAdded(existing.path)
      return
    }

    const check = checkEnvFilePath(trimmed)
    if (!check.ok) {
      setError(t(check.messageKey))
      return
    }

    setError(null)
    put.mutate(
      { path: { id: projectId }, body: { path: trimmed, content: '' } },
      {
        onSuccess: (file) => {
          setPath('')
          onAdded(file.path)
        },
        onError: (e) => setError(apiErrorMessage(e, t('envFiles.add.failed'))),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-end">
        <div className="w-full min-w-0 sm:max-w-sm">
          <FormField label={t('envFiles.add.label')} error={error}>
            {(field) => (
              <Input
                placeholder="server/.env"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit(path)
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                disabled={!filesLoaded}
                {...field}
              />
            )}
          </FormField>
        </div>
        <Button
          type="button"
          onClick={() => submit(path)}
          disabled={put.isPending || !path.trim() || !filesLoaded}
        >
          {put.isPending && <Spinner data-icon="inline-start" />}
          {t('envFiles.add.submit')}
        </Button>
      </div>

      {filesLoaded && files.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{t('envFiles.add.suggestionsLabel')}</span>
          {SUGGESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              variant="outline"
              size="sm"
              className="font-mono"
              disabled={put.isPending}
              onClick={() => submit(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
