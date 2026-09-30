import { z } from 'zod'

// Compose service names are already constrained by whatever `docker compose
// config` accepted, but a request body reaches this API before that check
// ever runs, so it gets its own regex: no leading dash (so it can never be
// read as a flag once it reaches argv), letters/digits/`.`/`_`/`-` only, one
// to 63 characters — the same length compose itself enforces.
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/
export const serviceNameSchema = z.string().regex(SERVICE_NAME_RE)

export const dockerPortSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']),
})

export const publishedPortSchema = dockerPortSchema.extend({
  hostIp: z.string(),
  hostPort: z.number().int().min(1).max(65535),
})

export const declaredPortSchema = z.object({
  containerPort: z.number().int(),
  publishedPort: z.number().int().nullable(),
  publishedRange: z.string().nullable(),
  protocol: z.enum(['tcp', 'udp']),
  hostIp: z.string().nullable(),
})

export const detectionSchema = z.object({
  hasCompose: z.boolean(),
  hasDockerfile: z.boolean(),
  composeFile: z.string().nullable(),
  composeOverrideFile: z.string().nullable(),
  dockerfile: z.string().nullable(),
})

export const projectDockerDetectionSchema = detectionSchema.extend({
  projectId: z.string().uuid(),
  slug: z.string(),
})

export const dockerDetectionListSchema = z.object({
  enabled: z.boolean(),
  projects: z.array(projectDockerDetectionSchema),
})

export const containerStateSchema = z.enum([
  'created',
  'running',
  'restarting',
  'removing',
  'paused',
  'exited',
  'dead',
])

export const dockerContainerSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  name: z.string(),
  service: z.string().nullable().openapi({
    description:
      'The compose service this container belongs to, or null for the plain-Dockerfile path.',
  }),
  image: z.string(),
  state: containerStateSchema,
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  ports: z.array(publishedPortSchema),
})

export const dockerServiceSchema = z.object({
  name: z.string(),
  image: z.string().nullable(),
  build: z.boolean(),
  profiles: z.array(z.string()),
  dependsOn: z.array(z.string()),
  declaredPorts: z.array(declaredPortSchema),
  containerIds: z.array(z.string()),
  state: z.enum(['running', 'partial', 'stopped', 'absent']),
})

export const hostAddressSchema = z.object({
  kind: z.enum(['tailscale', 'lan', 'loopback']),
  label: z.string(),
  host: z.string(),
})

export const daemonSchema = z.object({
  cliInstalled: z.boolean(),
  available: z.boolean(),
  version: z.string().nullable(),
  composeVersion: z.string().nullable(),
  error: z.string().nullable().openapi({ description: 'Trimmed stderr, at most 2000 characters.' }),
})

export const foreignStackSchema = z.object({
  name: z.string(),
  status: z.string(),
  configFiles: z.array(z.string()),
})

export const dockerImageSchema = z.object({
  reference: z.string(),
  exists: z.boolean(),
  builtAt: z.string().nullable(),
  exposedPorts: z.array(dockerPortSchema),
})

export const dockerStateSchema = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().nullable().openapi({
    description:
      "null = the project's own repo/ checkout; a session id = that session's own worktree.",
  }),
  projectPath: z.string().openapi({
    description:
      "Always the project's repo/ checkout, regardless of scope — see scopePath for the " +
      'directory this state was actually read from.',
  }),
  scopePath: z.string().openapi({
    description:
      'The directory this state was read from: equal to projectPath at repo scope, or the ' +
      "session's own worktree once ?sessionId is given.",
  }),
  composeProject: z.string().nullable(),
  daemon: daemonSchema,
  detection: detectionSchema,
  configError: z
    .string()
    .nullable()
    .openapi({
      description:
        'Trimmed stderr from a broken compose file, at most 2000 characters. A broken file is a ' +
        'legitimate project state: this endpoint still answers 200, with containers still ' +
        'populated from the running daemon, so stop/down stay usable even when start/restart do not.',
    }),
  services: z.array(dockerServiceSchema),
  containers: z.array(dockerContainerSchema),
  image: dockerImageSchema.nullable(),
  dockerfilePorts: z.array(dockerPortSchema).openapi({
    description:
      'Ports parsed from Dockerfile EXPOSE lines. The built image (`image.exposedPorts`) ' +
      'wins over this when both are known.',
  }),
  foreignStacks: z.array(foreignStackSchema).openapi({
    description:
      "Compose stacks using this project's compose file under a different project name — " +
      'started by a human running `docker compose up` directly. Never adopted; shown so the UI can warn.',
  }),
  hosts: z.array(hostAddressSchema),
  activeOperationId: z.string().uuid().nullable(),
  fetchedAt: z.string(),
})

export const dockerOperationKindSchema = z.enum(['up', 'stop', 'restart', 'down'])
export const dockerOperationStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed'])

export const dockerOperationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  kind: dockerOperationKindSchema,
  services: z.array(z.string()).openapi({ description: 'Empty means the whole stack.' }),
  status: dockerOperationStatusSchema,
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

// --- system-wide listing (GET /docker/containers, POST .../stop) ------------
//
// A distinct DTO family from dockerContainerSchema above, not a reuse of it:
// the system page lists EVERY container on the host, including ones no
// project in this install owns, so it needs a `composeProject`/`owner` pair
// dockerContainerSchema deliberately never carries (that schema is always
// already scoped to one project's own containers — see containers.ts).

export const containerOwnerKindSchema = z.enum(['compose', 'dockerfile', 'editor'])

export const containerOwnerSchema = z.object({
  kind: containerOwnerKindSchema,
  projectId: z.string().uuid(),
  projectName: z.string(),
  projectSlug: z.string(),
  sessionId: z.string().uuid().nullable().openapi({
    description: "null = the project's own repo/ checkout; a session id = that session's worktree.",
  }),
  sessionTitle: z.string().nullable(),
  branch: z.string().nullable(),
})

export const systemContainerSchema = z.object({
  id: z.string().openapi({
    description:
      'Full 64-hex container id, as `docker inspect` reports it — what the stop ' +
      'endpoint takes.',
  }),
  shortId: z.string(),
  name: z.string(),
  image: z.string(),
  state: containerStateSchema,
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  composeProject: z.string().nullable().openapi({
    description: 'The raw com.docker.compose.project label, or null for a non-compose container.',
  }),
  service: z.string().nullable(),
  ports: z.array(z.number().int().min(1).max(65535)).openapi({
    description:
      'Distinct published HOST port numbers, ascending — never a bind address. An IPv4 ' +
      '0.0.0.0 and an IPv6 [::] binding of the same port collapse to one entry.',
  }),
  owner: containerOwnerSchema.nullable().openapi({
    description:
      'null when the container carries no agentoo/compose ownership label this install ' +
      'recognises, or when it does but the project/session it names no longer exists here.',
  }),
})

export const dockerSystemSchema = z.object({
  enabled: z.boolean().openapi({
    description:
      'env.DOCKER_ENABLED — when false the stop endpoint answers 403. Listing still works: ' +
      'reads are never gated, same as GET /projects/{id}/docker.',
  }),
  daemon: daemonSchema.omit({ composeVersion: true }),
  containers: z.array(systemContainerSchema).openapi({
    description:
      'Every container on the docker host, ordered by name ascending so the list ' +
      'is stable across polls.',
  }),
  fetchedAt: z.string(),
})

export const stopSystemContainerResponseSchema = z.object({
  container: systemContainerSchema.nullable().openapi({
    description:
      'null means the stop succeeded and the daemon has since removed the container itself ' +
      '(a `docker run --rm` container auto-removes the moment it stops) — there is no fresher ' +
      'state left to report. Any other "not found" (a bad id, or the daemon already not knowing ' +
      'it before the stop was attempted) is a 404, never this null.',
  }),
})

export type ContainerOwnerDto = z.infer<typeof containerOwnerSchema>
export type SystemContainerDto = z.infer<typeof systemContainerSchema>
export type DockerSystemDto = z.infer<typeof dockerSystemSchema>

// --- requests ----------------------------------------------------------------

const servicesField = z
  .array(serviceNameSchema)
  .max(50)
  .optional()
  .openapi({ description: 'Omitted or empty means the whole stack.' })

export const upRequestSchema = z.object({
  services: servicesField,
  build: z.boolean().optional(),
  forceRecreate: z.boolean().optional(),
  removeOrphans: z.boolean().optional(),
  containerPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .openapi({ description: 'Plain-Dockerfile projects only; a 400 on a compose project.' }),
  hostPort: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .optional()
    .openapi({
      description:
        'Plain-Dockerfile projects only. Omitted lets the daemon allocate one — the running ' +
        'container is the only record of what it picked. Floored at 1024 so this never needs a ' +
        'privileged port.',
    }),
})

export const serviceSelectionSchema = z.object({ services: servicesField })

export const downRequestSchema = z.object({
  services: servicesField,
  removeVolumes: z.boolean().optional().openapi({
    description: 'Compose only. Defaults to false — cleanup never deletes a volume unasked.',
  }),
  removeImages: z.boolean().optional().openapi({
    description: 'Compose only. Defaults to false — cleanup never deletes an image unasked.',
  }),
})

export type DetectionDto = z.infer<typeof detectionSchema>
export type ProjectDockerDetectionDto = z.infer<typeof projectDockerDetectionSchema>
export type DockerDetectionListDto = z.infer<typeof dockerDetectionListSchema>
export type DockerContainerDto = z.infer<typeof dockerContainerSchema>
export type DockerServiceDto = z.infer<typeof dockerServiceSchema>
export type HostAddressDto = z.infer<typeof hostAddressSchema>
export type DaemonDto = z.infer<typeof daemonSchema>
export type ForeignStackDto = z.infer<typeof foreignStackSchema>
export type DockerImageDto = z.infer<typeof dockerImageSchema>
export type DockerStateDto = z.infer<typeof dockerStateSchema>
export type DockerOperationDto = z.infer<typeof dockerOperationSchema>
export type DockerOperationKind = z.infer<typeof dockerOperationKindSchema>
export type DockerOperationStatus = z.infer<typeof dockerOperationStatusSchema>
export type UpRequestInput = z.infer<typeof upRequestSchema>
export type ServiceSelectionInput = z.infer<typeof serviceSelectionSchema>
export type DownRequestInput = z.infer<typeof downRequestSchema>
