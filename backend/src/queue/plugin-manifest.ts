import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectPlugin } from '@/lib/paths'

/**
 * The plugin's name, which is also the namespace every agent in it is addressed
 * by: an agent file `tester.md` is `agentoo:tester` at the session, not
 * `tester`. Exported because the orchestrator's roster has to name specialists
 * in the form that actually resolves — a brief addressed to a bare name fails
 * to find an agent that is sitting right there.
 */
export const PLUGIN_NAME = 'agentoo'

/**
 * Make the project's symlink farm loadable as a Claude Code plugin.
 *
 * A directory is only recognised as a plugin if it holds
 * `.claude-plugin/plugin.json`; without it the agents and skills symlinked in
 * there are ignored, silently, at session time. Written at project setup and
 * again when a session starts, so projects created before this existed pick it
 * up on their next run rather than needing a repair step.
 *
 * Publishes by write-then-rename rather than a plain `writeFile`: this now
 * runs at the start of every turn (runner-options.ts), so once two turns in
 * the same project can be in flight together, a plain in-place write is a
 * window where a concurrent reader opens the file mid-write and gets
 * truncated JSON — the whole plugin then fails to load, silently, since the
 * caller downgrades that failure to a warning (see the try/catch around
 * `ensurePluginManifest` in library/service.ts). The temp file sits in the
 * same `.claude-plugin/` directory as its target, not `/tmp`, because
 * `rename()` is only atomic within a filesystem. Unlike the skill directories
 * `materialise` publishes, this target is a single file, so rename can
 * replace it outright — no ENOTEMPTY, no serialization needed here.
 */
export async function ensurePluginManifest(slug: string): Promise<string> {
  const root = projectPlugin(slug)
  const dir = `${root}/.claude-plugin`
  await mkdir(dir, { recursive: true })

  const finalPath = join(dir, 'plugin.json')
  const tempPath = join(dir, `.tmp-plugin-${randomUUID()}.json`)
  const content = `${JSON.stringify(
    {
      // Kebab-case and no spaces: the loader rejects anything else.
      name: PLUGIN_NAME,
      version: '1.0.0',
      description: 'Agents and skills selected for this project.',
    },
    null,
    2,
  )}\n`

  try {
    await writeFile(tempPath, content)
    await rename(tempPath, finalPath)
  } catch (error) {
    // A crashed or failed sync must not leave litter behind for the next one
    // to trip over.
    await rm(tempPath, { force: true })
    throw error
  }

  return root
}
