import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Inline,
  PageHeader,
  Spinner,
  Stack,
  toast,
} from '@/shared/ui'
import { useAgents, useProjectLibrary, useSetProjectLibrary, useSkills } from '../hooks/use-library'
import styles from './library.module.scss'

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
        onSuccess: () => toast({ title: t('library.assign.saved') }),
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
    <Stack gap={8}>
      <p className={styles.intro}>{t('library.assign.intro')}</p>

      {isError && (
        <Alert>{apiErrorMessage(agents.error ?? skills.error, t('library.loadFailed'))}</Alert>
      )}

      {!isError && isPending && <Spinner label={t('common.loading')} block />}

      {!isError && !isPending && empty && (
        <EmptyState
          title={t('library.assign.emptyLibrary')}
          action={
            <Link to="/library">
              <Button type="button">{t('library.assign.goToLibrary')}</Button>
            </Link>
          }
        />
      )}

      {!isError && !isPending && !empty && (
        <>
          {agentsList.length > 0 && (
            <Stack gap={3}>
              <PageHeader level={2} title={t('library.agents')} />
              <Stack gap={2}>
                {agentsList.map((agent) => (
                  <div key={agent.name} className={styles.assignItem}>
                    <Checkbox
                      label={
                        <Inline gap={2}>
                          <span>{agent.name}</span>
                          <Badge
                            tone={agent.role === 'orchestrator' ? 'accent' : 'neutral'}
                            variant="outline"
                          >
                            {t(`library.role.${agent.role}`)}
                          </Badge>
                        </Inline>
                      }
                      description={agent.description}
                      checked={selectedAgents.includes(agent.name)}
                      onCheckedChange={() => toggle(selectedAgents, setSelectedAgents, agent.name)}
                    />
                  </div>
                ))}
              </Stack>
            </Stack>
          )}

          {skillsList.length > 0 && (
            <Stack gap={3}>
              <PageHeader level={2} title={t('library.skills')} />
              <Stack gap={2}>
                {skillsList.map((skill) => (
                  <div key={skill.name} className={styles.assignItem}>
                    <Checkbox
                      label={skill.name}
                      description={skill.description}
                      checked={selectedSkills.includes(skill.name)}
                      onCheckedChange={() => toggle(selectedSkills, setSelectedSkills, skill.name)}
                    />
                  </div>
                ))}
              </Stack>
            </Stack>
          )}

          <Stack gap={3}>
            {error && <Alert>{error}</Alert>}
            <Inline gap={3}>
              <Button type="button" disabled={!dirty || save.isPending} onClick={onSave}>
                {save.isPending ? t('common.working') : t('common.save')}
              </Button>
              <span className={styles.hint}>{t('library.assign.hint')}</span>
            </Inline>
          </Stack>
        </>
      )}
    </Stack>
  )
}
