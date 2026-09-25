import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, PageHeader, StatusBadge, toast } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { useAgents, useProjectLibrary, useSetProjectLibrary, useSkills } from '../hooks/use-library'

/**
 * Which global agents and skills this project uses.
 *
 * The library holds one copy of each; a project selects from it. Editing an
 * agent therefore changes it for every project using it, which is the point of
 * a global library rather than per-project copies.
 */
export function ProjectLibraryPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const skills = useSkills()
  const assigned = useProjectLibrary(projectId)
  const save = useSetProjectLibrary(projectId)

  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!assigned.data) return
    setSelectedAgents(assigned.data.agents)
    setSelectedSkills(assigned.data.skills)
  }, [assigned.data])

  const toggle = (list: string[], set: (v: string[]) => void, name: string) =>
    set(list.includes(name) ? list.filter((n) => n !== name) : [...list, name])

  const dirty =
    assigned.data !== undefined &&
    (JSON.stringify([...selectedAgents].sort()) !==
      JSON.stringify([...assigned.data.agents].sort()) ||
      JSON.stringify([...selectedSkills].sort()) !==
        JSON.stringify([...assigned.data.skills].sort()))

  const onSave = () => {
    setError(null)
    save.mutate(
      { path: { id: projectId }, body: { agents: selectedAgents, skills: selectedSkills } },
      {
        // A toast survives this component unmounting (e.g. the tab closing
        // right after save), which a local timeout-driven message cannot.
        onSuccess: () => toast.add({ title: t('library.assign.saved'), type: 'success' }),
        onError: (e) => setError(apiErrorMessage(e, t('library.assign.failed'))),
      },
    )
  }

  const agentsList = agents.data ?? []
  const skillsList = skills.data ?? []
  const isPending = agents.isPending || skills.isPending
  const isError = agents.isError || skills.isError
  const empty = agentsList.length === 0 && skillsList.length === 0

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted-foreground">{t('library.assign.intro')}</p>

      {isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(agents.error ?? skills.error, t('library.loadFailed'))}
          </AlertDescription>
        </Alert>
      )}

      {!isError && isPending && <Loading label={t('common.loading')} block />}

      {!isError && !isPending && empty && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('library.assign.emptyLibrary')}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Link to="/library" className={buttonVariants({ variant: 'default' })}>
              {t('library.assign.goToLibrary')}
            </Link>
          </EmptyContent>
        </Empty>
      )}

      {!isError && !isPending && !empty && (
        <>
          {agentsList.length > 0 && (
            <div className="flex flex-col gap-3">
              <PageHeader level={2} title={t('library.agents')} />
              <div className="flex flex-col gap-2">
                {agentsList.map((agent) => (
                  <Field
                    key={agent.name}
                    orientation="horizontal"
                    className="rounded-md border px-3 py-2 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={`assign-agent-${agent.name}`}
                      checked={selectedAgents.includes(agent.name)}
                      onCheckedChange={() => toggle(selectedAgents, setSelectedAgents, agent.name)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`assign-agent-${agent.name}`}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span>{agent.name}</span>
                          <StatusBadge tone={agent.role === 'orchestrator' ? 'accent' : 'neutral'}>
                            {t(`library.role.${agent.role}`)}
                          </StatusBadge>
                        </span>
                      </FieldLabel>
                      <FieldDescription>{agent.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </div>
            </div>
          )}

          {skillsList.length > 0 && (
            <div className="flex flex-col gap-3">
              <PageHeader level={2} title={t('library.skills')} />
              <div className="flex flex-col gap-2">
                {skillsList.map((skill) => (
                  <Field
                    key={skill.name}
                    orientation="horizontal"
                    className="rounded-md border px-3 py-2 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={`assign-skill-${skill.name}`}
                      checked={selectedSkills.includes(skill.name)}
                      onCheckedChange={() => toggle(selectedSkills, setSelectedSkills, skill.name)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`assign-skill-${skill.name}`}>{skill.name}</FieldLabel>
                      <FieldDescription>{skill.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!dirty || save.isPending} onClick={onSave}>
                {save.isPending ? t('common.working') : t('common.save')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('library.assign.hint')}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
