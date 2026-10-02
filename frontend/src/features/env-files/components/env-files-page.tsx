import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Skeleton } from '@/shared/ui/skeleton'
import { useListEnvFiles } from '../hooks/use-env-files'
import { groupEnvFilesByFolder } from '../lib/group-files'
import { AddEnvFileForm } from './add-env-file-form'
import { EnvFileCard } from './env-file-card'
import { HowItWorksDrawer } from './how-it-works-drawer'

function EnvFilesSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}

/**
 * A project's stored env files: what gets copied into every *new* session's
 * worktree, at the same path, so that worktree's own Docker Compose (or
 * anything else reading a `.env`) finds one — see `HowItWorksDrawer` for the
 * full explanation, surfaced here rather than assumed.
 *
 * Always reachable from the project sidebar, right after Docker
 * (sidebar.tsx's `nav.env`) — same reasoning as `DockerPage`'s own doc
 * comment: this page is what explains an empty store, not the nav.
 */
export function EnvFilesPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data, isPending, isError, error } = useListEnvFiles(projectId)
  const files = data?.files ?? []
  const groups = groupEnvFilesByFolder(files)

  // Keyed by path rather than a single ref: a card's root node, registered as
  // each `EnvFileCard` mounts (see its own `cardRef` prop) so `focusPath`
  // below can find a file that only just appeared in the list.
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const registerNode = useCallback((path: string, node: HTMLDivElement | null) => {
    if (node) nodes.current.set(path, node)
    else nodes.current.delete(path)
  }, [])

  // The path to scroll/focus once its card exists — set by the add form, for
  // both a freshly created file (whose card doesn't exist until the list
  // refetches, hence waiting on `files` below rather than acting immediately)
  // and a duplicate the form resolved to one already on screen.
  const [focusPath, setFocusPath] = useState<string | null>(null)
  useEffect(() => {
    if (!focusPath) return
    if (!files.some((file) => file.path === focusPath)) return // not in the list yet
    const node = nodes.current.get(focusPath)
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    node?.querySelector('textarea')?.focus()
    setFocusPath(null)
  }, [focusPath, files])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('envFiles.heading')}
        description={t('envFiles.lead')}
        actions={<HowItWorksDrawer />}
      />

      <AddEnvFileForm projectId={projectId} files={files} onAdded={setFocusPath} />

      {isPending && <EnvFilesSkeleton />}

      {isError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(error, t('envFiles.loadFailed'))}</AlertDescription>
        </Alert>
      )}

      {!isPending && !isError && files.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('envFiles.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('envFiles.empty.description')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {!isPending && !isError && files.length > 0 && (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <div key={group.folder || '.'} className="flex flex-col gap-3">
              <h2 className="font-mono text-sm font-medium text-muted-foreground">
                {group.folder ? `${group.folder}/` : t('envFiles.groups.root')}
              </h2>
              <div className="flex flex-col gap-3">
                {group.files.map((file) => (
                  <EnvFileCard
                    key={file.path}
                    projectId={projectId}
                    file={file}
                    cardRef={(node) => registerNode(file.path, node)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
