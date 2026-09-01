import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui'
import { useAgents, useSkills } from '../hooks/use-library'
import styles from './library.module.scss'

export function LibraryPage() {
  const { t } = useTranslation()
  const agents = useAgents()
  const skills = useSkills()

  return (
    <div className={styles.page}>
      <p className={styles.intro}>{t('library.intro')}</p>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.title}>{t('library.agents')}</h2>
          <Link to="/library/agents/new">
            <Button type="button">{t('library.newAgent')}</Button>
          </Link>
        </div>

        {agents.isError && (
          <p className={styles.error}>{apiErrorMessage(agents.error, t('library.loadFailed'))}</p>
        )}
        {agents.isPending && <p className={styles.empty}>{t('common.loading')}</p>}
        {!agents.isPending && (agents.data ?? []).length === 0 && (
          <p className={styles.empty}>{t('library.noAgents')}</p>
        )}

        {(agents.data ?? []).length > 0 && (
          <div className={styles.wrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>{t('library.table.name')}</th>
                  <th className={styles.th}>{t('library.table.role')}</th>
                  <th className={styles.th}>{t('library.table.description')}</th>
                  <th className={styles.th}>{t('library.table.model')}</th>
                  <th className={styles.th}>{t('library.table.usedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {(agents.data ?? []).map((agent) => (
                  <tr key={agent.name} className={styles.row}>
                    <td className={styles.td}>
                      <Link
                        to="/library/agents/$name"
                        params={{ name: agent.name }}
                        className={styles.nameLink}
                      >
                        {agent.name}
                      </Link>
                    </td>
                    <td className={styles.td}>
                      <span
                        className={`${styles.role} ${agent.role === 'orchestrator' ? styles.orchestrator : ''}`}
                      >
                        {t(`library.role.${agent.role}`)}
                      </span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.muted}>{agent.description}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.mono}>{agent.model ?? '—'}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.muted}>
                        {t('library.usedByCount', { count: agent.usedByProjects })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.title}>{t('library.skills')}</h2>
          <Link to="/library/skills/new">
            <Button type="button">{t('library.newSkill')}</Button>
          </Link>
        </div>

        {skills.isPending && <p className={styles.empty}>{t('common.loading')}</p>}
        {!skills.isPending && (skills.data ?? []).length === 0 && (
          <p className={styles.empty}>{t('library.noSkills')}</p>
        )}

        {(skills.data ?? []).length > 0 && (
          <div className={styles.wrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>{t('library.table.name')}</th>
                  <th className={styles.th}>{t('library.table.description')}</th>
                  <th className={styles.th}>{t('library.table.files')}</th>
                  <th className={styles.th}>{t('library.table.usedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {(skills.data ?? []).map((skill) => (
                  <tr key={skill.name} className={styles.row}>
                    <td className={styles.td}>
                      <Link
                        to="/library/skills/$name"
                        params={{ name: skill.name }}
                        className={styles.nameLink}
                      >
                        {skill.name}
                      </Link>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.muted}>{skill.description}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.mono}>
                        {skill.extraFiles.length > 0
                          ? t('library.bundledCount', { count: skill.extraFiles.length })
                          : '—'}
                      </span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.muted}>
                        {t('library.usedByCount', { count: skill.usedByProjects })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
