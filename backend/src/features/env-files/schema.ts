// z comes from @hono/zod-openapi, not plain zod: its .openapi() is an
// instance-level patch (extendZodWithOpenApi mutates ZodType.prototype as a
// side effect of importing this module), so a schema built from this file's
// own z is guaranteed patched by the time its own top-level code runs — see
// features/library/schema.ts's identical header for the bug this avoids: this
// module is reachable from materialize.ts, which createSession calls directly,
// so a worker process can load it well before anything else imports
// '@hono/zod-openapi', and whether '.openapi()' exists yet would otherwise
// depend on which module happened to get there first.
import { z } from '@hono/zod-openapi'
import { checkEnvFilePath } from './path-rules'

/** A dotenv file, not a general-purpose one — generous for how large these
 * get in practice (a handful of KV lines), while still bounding what one
 * project's store — and thus every new session's worktree — can grow to. */
export const ENV_FILE_MAX_CONTENT_BYTES = 64 * 1024

/** Keeps this a small, curated set a human reviews on the project's settings
 * page, not an arbitrary bulk file store. */
export const ENV_FILE_MAX_FILES_PER_PROJECT = 100

/**
 * A store-relative path, re-checked against `checkEnvFilePath` so the 400 a
 * client sees here names exactly which rule it broke, in the same words
 * materialize.ts logs when it re-runs this same check against whatever is
 * actually on disk before copying it into a worktree.
 */
export const envFilePathSchema = z
  .string()
  .min(1, 'path is required')
  .max(255, 'path must be 255 characters or fewer')
  .refine((v) => checkEnvFilePath(v).ok, {
    // Mirrors updateProjectSchema.defaultBranch (features/projects/schema.ts):
    // a function rather than a static message, so the issue carries the
    // specific rule this path broke instead of one generic "invalid path".
    error: (issue) => {
      const check = checkEnvFilePath(String(issue.input))
      return check.ok ? undefined : check.reason
    },
  })

const envFileContentSchema = z
  .string()
  .refine((v) => !v.includes('\0'), 'content may not contain a NUL byte')
  .refine(
    (v) => new TextEncoder().encode(v).length <= ENV_FILE_MAX_CONTENT_BYTES,
    `content may not exceed ${ENV_FILE_MAX_CONTENT_BYTES} bytes (${ENV_FILE_MAX_CONTENT_BYTES / 1024} KiB)`,
  )

export const envFileSchema = z.object({
  path: z.string().openapi({ description: 'Store-relative path, e.g. "server/.env"' }),
  content: z.string(),
  size: z
    .number()
    .int()
    .nonnegative()
    .openapi({ description: 'Size of content in bytes (UTF-8 encoded), as stored on disk' }),
  updatedAt: z.string().openapi({ description: 'ISO 8601 timestamp of the last write' }),
})
export type EnvFileDto = z.infer<typeof envFileSchema>

export const envFilesListSchema = z.object({ files: z.array(envFileSchema) })

export const putEnvFileSchema = z.object({
  path: envFilePathSchema,
  content: envFileContentSchema,
})
export type PutEnvFileInput = z.infer<typeof putEnvFileSchema>
