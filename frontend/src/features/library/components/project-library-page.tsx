import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui'
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
  const [saved, setSaved] = useState(false)

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
    setSaved(false)
    save.mutate(
      { path: { id: projectId }, body: { agents: selectedAgents, skills: selectedSkills } },
      {
        onSuccess: () => {
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        },
        onError: (e) => setError(apiErrorMessage(e, t('library.assign.failed'))),
      },
    )
  }

  const empty = (agents.data ?? []).length === 0 && (skills.data ?? []).length === 0

  return (
    <div className={styles.page}>
      <p className={styles.intro}>{t('library.assign.intro')}</p>

      {empty && !agents.isPending && (
        <p className={styles.empty}>
          {t('library.assign.emptyLibrary')}{' '}
          <Link to="/library" className={styles.nameLink}>
            {t('library.assign.goToLibrary')}
          </Link>
        </p>
      )}

      {(agents.data ?? []).length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.title}>{t('library.agents')}</h2>
          <div className={styles.assignList}>
            {(agents.data ?? []).map((agent) => (
              <label key={agent.name} className={styles.assignItem}>
                <input
                  type="checkbox"
                  checked={selectedAgents.includes(agent.name)}
                  onChange={() => toggle(selectedAgents, setSelectedAgents, agent.name)}
                />
                <span className={styles.assignBody}>
                  <span className={styles.assignName}>
                    {agent.name}{' '}
                    <span
                      className={`${styles.role} ${agent.role === 'orchestrator' ? styles.orchestrator : ''}`}
                    >
                      {t(`library.role.${agent.role}`)}
                    </span>
                  </span>
                  <span className={styles.assignDesc}>{agent.description}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {(skills.data ?? []).length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.title}>{t('library.skills')}</h2>
          <div className={styles.assignList}>
            {(skills.data ?? []).map((skill) => (
              <label key={skill.name} className={styles.assignItem}>
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(skill.name)}
                  onChange={() => toggle(selectedSkills, setSelectedSkills, skill.name)}
                />
                <span className={styles.assignBody}>
                  <span className={styles.assignName}>{skill.name}</span>
                  <span className={styles.assignDesc}>{skill.description}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {!empty && (
        <div className={styles.controls}>
          <Button type="button" disabled={!dirty || save.isPending} onClick={onSave}>
            {save.isPending ? t('common.working') : t('common.save')}
          </Button>
          {saved && <span className={styles.hint}>{t('library.assign.saved')}</span>}
          {error && <span className={styles.error}>{error}</span>}
          <span className={styles.hint}>{t('library.assign.hint')}</span>
        </div>
      )}
    </div>
  )
}
