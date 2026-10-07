// z comes from @hono/zod-openapi, not plain zod: its .openapi() is an
// instance-level patch (extendZodWithOpenApi mutates ZodType.prototype as a
// side effect of importing this module), so a schema built from this file's
// own z is guaranteed patched by the time its own top-level code runs — see
// features/env-files/schema.ts's identical header for the bug this avoids.
// This module is reachable standalone (tests import gitIdentityInputSchema
// directly, without ever going through routes.ts, which is what patches the
// prototype in the running app), so unlike most files in this feature it
// cannot rely on some earlier import having done that already.
import { z } from '@hono/zod-openapi'
import { checkBranchName } from '@/lib/branch-name'
import { hasControlChars } from '@/lib/text'

export const projectStatusSchema = z.enum(['pending', 'cloning', 'ready', 'needs_manual', 'failed'])

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  source: z.enum(['clone', 'existing', 'empty']),
  remoteUrl: z.string().nullable(),
  sourceName: z.string().nullable(),
  sshKeyId: z.string().uuid().nullable(),
  defaultBranch: z.string().nullable(),
  status: projectStatusSchema,
  lastError: z.string().nullable(),
  recoveryCommands: z.array(z.string()).nullable(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProjectDto = z.infer<typeof projectSchema>

// Exactly one source. `sourceName` is a folder name inside SOURCES_DIR, never a
// path — adoption is restricted to that directory by construction.
export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    remoteUrl: z.string().min(1).optional(),
    sourceName: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: 'Folder name inside SOURCES_DIR to adopt' }),
    empty: z
      .boolean()
      .optional()
      .openapi({ description: 'Create an empty git repository instead' }),
    sshKeyId: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: 'Clone using this SSH key. Needed for a private repo over ssh.' }),
  })
  .refine((v) => [v.remoteUrl, v.sourceName, v.empty].filter(Boolean).length === 1, {
    message: 'Provide exactly one of remoteUrl, sourceName or empty',
  })
export type CreateProjectInput = z.infer<typeof createProjectSchema>

export const errorSchema = z.object({
  error: z.string(),
  recoveryCommands: z.array(z.string()).optional(),
})

// Everything here is optional: a PATCH that only swaps the ssh key should not
// have to restate the name. `sshKeyId: null` clears it back to ssh defaults,
// and `defaultBranch: null` clears it back to auto-detect (the repo's current
// branch at the time each session starts), which is why both are nullable
// rather than merely optional.
export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    remoteUrl: z.string().min(1).optional(),
    sshKeyId: z.string().uuid().nullable().optional(),
    defaultBranch: z
      .string()
      .nullable()
      .optional()
      .refine((v) => v === undefined || v === null || checkBranchName(v).ok, {
        // See createSessionSchema.baseBranch for why this is a function
        // rather than the static messages the other fields here use.
        error: (issue) => {
          if (issue.input === null) return undefined
          const check = checkBranchName(String(issue.input))
          return check.ok ? undefined : check.reason
        },
      })
      .openapi({
        description:
          'Branch new session worktrees are cut from by default, brought up to date from the ' +
          'remote immediately before each one is cut. Not checked for existence here — a branch ' +
          'may legitimately not exist locally yet — only when a session actually starts.',
      }),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>

// --- git identity ----------------------------------------------------------
//
// Lives nowhere but the project repo's own `.git/config` (see
// `readRepoIdentity`/`configureRepoIdentity` in `@/lib/git`) — no database
// column backs this, and there is deliberately no field for it on
// `projectSchema` above: that schema is what `listProjects` returns for every
// project on every poll, and reading git config per row on every list would
// spawn a `git` process nobody asked for. These two endpoints are the only
// way to see or change it.

/** Both fields together, since a name with no email (or vice versa) is not a
 * usable git identity — `null` only ever means "not set", never "set to
 * empty". */
const gitIdentitySchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
})

export const gitIdentityStateSchema = z
  .object({
    available: z.boolean().openapi({
      description:
        'False when the project is not yet ready or its repo is missing/not a git repo — the ' +
        'other fields are then all null, never a 500.',
    }),
    configPath: z
      .string()
      .nullable()
      .openapi({
        description:
          'Absolute path of the config file a change here is written to — the same file a hand ' +
          'edit of .git/config already changes. Null when unavailable.',
      }),
    local: gitIdentitySchema.openapi({
      description: "Only this repository's own config, exactly what the Settings UI edits.",
    }),
    effective: gitIdentitySchema.openapi({
      description:
        'What a commit made in this repo right now would actually carry, once global/system ' +
        'config is also taken into account.',
    }),
  })
  .openapi('GitIdentityState')
export type GitIdentityStateDto = z.infer<typeof gitIdentityStateSchema>

// The value reaches `git config <key> <value>` as an argv entry (see
// configureRepoIdentity), so this is a shape check, not just a nicety:
// control characters (newline and tab included) could smuggle a second
// config line or corrupt the file, `<`/`>` have no legitimate place in either
// field, and a leading `-` is how a value gets misread as a flag rather than
// a value by *some* git subcommands. Checked identically for both fields,
// since both reach the exact same sink. `hasControlChars` (lib/text.ts) is a
// char-code scan, not a regex — see that module's own comment for why a
// regex spelling out this range is the wrong tool here.
const ANGLE_BRACKET_RE = /[<>]/
const EMAIL_SHAPE_RE = /^[^\s<>@]+@[^\s<>@]+$/

function gitIdentityValue(label: string, min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .refine((v) => !hasControlChars(v), `${label} may not contain control characters`)
    .refine((v) => !ANGLE_BRACKET_RE.test(v), `${label} may not contain "<" or ">"`)
    .refine((v) => !v.startsWith('-'), `${label} may not start with "-"`)
}

export const gitIdentityInputSchema = z
  .object({
    name: gitIdentityValue('Name', 1, 200),
    email: gitIdentityValue('Email', 3, 254).refine(
      (v) => EMAIL_SHAPE_RE.test(v),
      'Email must look like an address, e.g. name@example.com',
    ),
  })
  .openapi('GitIdentityInput')
export type GitIdentityInput = z.infer<typeof gitIdentityInputSchema>
