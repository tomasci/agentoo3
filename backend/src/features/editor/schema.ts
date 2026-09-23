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
