import { mkdir, writeFile } from 'node:fs/promises'
import { projectPlugin } from '@/lib/paths'

/**
 * Make the project's symlink farm loadable as a Claude Code plugin.
 *
 * A directory is only recognised as a plugin if it holds
 * `.claude-plugin/plugin.json`; without it the agents and skills symlinked in
 * there are ignored, silently, at session time. Written at project setup and
 * again when a session starts, so projects created before this existed pick it
 * up on their next run rather than needing a repair step.
 */
export async function ensurePluginManifest(slug: string): Promise<string> {
  const root = projectPlugin(slug)
  await mkdir(`${root}/.claude-plugin`, { recursive: true })
  await writeFile(
    `${root}/.claude-plugin/plugin.json`,
    `${JSON.stringify(
      {
        // Kebab-case and no spaces: the loader rejects anything else.
        name: 'agentoo',
        version: '1.0.0',
        description: 'Agents and skills selected for this project.',
      },
      null,
      2,
    )}\n`,
  )
  return root
}
