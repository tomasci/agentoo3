// The wire contract for the editor feature — see /tmp/agentoo-editor/design.md
// section 6 ("API contract"). Reuses two enums from features/docker/schema.ts
// (containerStateSchema, dockerOperationStatusSchema) rather than redeclaring
// them: an editor container reports the identical set of docker container
// states, and an editor start job reports the identical queued/running/
// succeeded/failed lifecycle a docker operation does. Importing the other
// direction — docker/* importing from here — is what must never happen (see
// container.ts's own header); a schema-only import the other way is fine.

import { z } from 'zod'
import { containerStateSchema, dockerOperationStatusSchema } from '@/features/docker/schema'

export const editorStateSchema = z.enum(['stopped', 'starting', 'running', 'unresponsive'])

export const editorOperationOutputLineSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
  at: z.string(),
})

export const editorOperationSchema = z.object({
  id: z.string().uuid(),
  status: dockerOperationStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  output: z.array(editorOperationOutputLineSchema).openapi({
    description: 'Up to the last 200 lines this start produced, each capped at 2000 characters.',
  }),
})

export const editorStatusSchema = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
  enabled: z.boolean().openapi({
    description: 'DOCKER_ENABLED && EDITOR_ENABLED. This endpoint still answers 200 when false.',
  }),
  daemon: z.object({
    cliInstalled: z.boolean(),
    available: z.boolean(),
    error: z.string().nullable(),
  }),
  state: editorStateSchema,
  proxyPath: z.string().openapi({
    description:
      'The iframe src: /api/projects/{id}/sessions/{sessionId}/editor/proxy/. Only load it once ' +
      'state is running or unresponsive.',
  }),
  worktreePath: z.string(),
  image: z.string(),
  idleTimeoutSeconds: z.number().int(),
  container: z
    .object({
      name: z.string(),
      state: containerStateSchema,
      startedAt: z.string().nullable(),
    })
    .nullable(),
  operation: editorOperationSchema.nullable().openapi({
    description: 'The latest start requested for this session, kept for 1 hour.',
  }),
  fetchedAt: z.string(),
})

export type EditorState = z.infer<typeof editorStateSchema>
export type EditorOperationOutputLine = z.infer<typeof editorOperationOutputLineSchema>
export type EditorOperationDto = z.infer<typeof editorOperationSchema>
export type EditorStatusDto = z.infer<typeof editorStatusSchema>

// --- GET /editors: every editor holding a running-cap slot -------------------
//
// A second, independent response shape from editorStatusSchema above: that
// one describes ONE session's own editor; this describes the box's shared
// cap itself, and who (of this install's own sessions) is currently using a
// slot of it — see service.ts's `listRunningEditors` for how each field here
// is actually produced.

export const editorHealthSchema = z.enum(['in-use', 'idle', 'unresponsive']).openapi({
  description:
    "From this editor's own /healthz: 'in-use' (a heartbeat within the last 60s — in practice, a " +
    "connected browser tab), 'idle' (reachable, but nobody has been connected for at least that " +
    "long), or 'unresponsive' (no answer at all, or one that didn't parse).",
})

export const runningEditorSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string(),
  sessionId: z.string().uuid(),
  sessionTitle: z
    .string()
    .nullable()
    .openapi({ description: 'Null when the session has no title yet.' }),
  branch: z.string().nullable(),
  containerName: z.string(),
  startedAt: z.string().nullable().openapi({ description: "The container's own start time." }),
  health: editorHealthSchema,
  lastActiveAt: z.string().nullable().openapi({
    description: "This editor's last heartbeat. Null when code-server has never seen one.",
  }),
})

export const runningEditorsSchema = z.object({
  enabled: z.boolean().openapi({
    description:
      'editorEnabled. When false, every count below is 0 and `editors` is empty — a ' +
      'disabled feature has never started a container, not a server fault.',
  }),
  cap: z.number().int().openapi({ description: 'EDITOR_MAX_RUNNING.' }),
  running: z
    .number()
    .int()
    .openapi({
      description:
        'Every editor container `running` on this box, across every agentoo install sharing this ' +
        'docker daemon — the exact same count a start request compares against the cap.',
    }),
  otherInstallsRunning: z
    .number()
    .int()
    .openapi({
      description:
        "`running` minus this install's own running editors — never broken out individually: this " +
        "install has no business (or ability) to name a sibling install's sessions.",
    }),
  editors: z.array(runningEditorSchema).openapi({
    description:
      "This install's own running editors whose session still resolves, sorted idle first, then " +
      'unresponsive, then in-use (within each group, oldest lastActiveAt first, nulls first). An ' +
      'editor whose session (or project) has since been deleted is left out here — still counted ' +
      'in `running` above — until the reaper removes it, within its own 5-minute schedule.',
  }),
  fetchedAt: z.string(),
})

export type EditorHealth = z.infer<typeof editorHealthSchema>
export type RunningEditorDto = z.infer<typeof runningEditorSchema>
export type RunningEditorsDto = z.infer<typeof runningEditorsSchema>
