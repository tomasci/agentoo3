import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq, isNotNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { env } from '@/env'
import { isGitRepo } from '@/lib/git'

const sourceSchema = z.object({
  name: z.string(),
  path: z.string(),
  isGitRepo: z.boolean(),
  // Already adopted by a project, so it cannot be adopted again.
  adopted: z.boolean(),
  adoptedBy: z.string().nullable().openapi({ description: 'Name of the project using it' }),
})

const sourcesResponseSchema = z.object({
  dir: z.string().openapi({ description: 'Put folders here to make them adoptable' }),
  entries: z.array(sourceSchema),
})

export const sourcesRouter = new OpenAPIHono()

sourcesRouter.openapi(
  createRoute({
    method: 'get',
    path: '/sources',
    tags: ['sources'],
    summary: 'Folders available to adopt as projects',
    description:
      'Lists directories in SOURCES_DIR. Adoption is restricted to this directory, ' +
      'so a project cannot be pointed at an arbitrary path on the server.',
    responses: {
      200: {
        content: { 'application/json': { schema: sourcesResponseSchema } },
        description: 'Sources',
      },
    },
  }),
  async (c) => {
    let names: string[] = []
    try {
      const entries = await readdir(env.SOURCES_DIR, { withFileTypes: true })
      names = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
    } catch {
      // A missing directory is not an error: it just has nothing in it yet, and
      // the response still tells the operator where to put things.
      names = []
    }

    const taken = new Map(
      (
        await db
          .select({ name: projects.name, sourceName: projects.sourceName })
          .from(projects)
          .where(isNotNull(projects.sourceName))
      ).map((r) => [r.sourceName as string, r.name]),
    )

    const entries = await Promise.all(
      names.sort().map(async (name) => {
        const path = join(env.SOURCES_DIR, name)
        let gitRepo = false
        try {
          if ((await stat(path)).isDirectory()) gitRepo = await isGitRepo(path)
        } catch {
          gitRepo = false
        }
        return {
          name,
          path,
          isGitRepo: gitRepo,
          adopted: taken.has(name),
          adoptedBy: taken.get(name) ?? null,
        }
      }),
    )

    return c.json({ dir: env.SOURCES_DIR, entries }, 200)
  },
)

export { eq }
