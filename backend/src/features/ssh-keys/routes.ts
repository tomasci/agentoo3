import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorSchema } from '@/features/projects/schema'
import { createSshKeySchema, sshKeySchema, testResultSchema, testSshKeySchema } from './schema'
import { createSshKey, deleteSshKey, listSshKeys, testSshKey } from './service'

const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

export const sshKeysRouter = new OpenAPIHono()

sshKeysRouter.openapi(
  createRoute({
    method: 'get',
    path: '/ssh-keys',
    tags: ['ssh-keys'],
    summary: 'List SSH keys',
    description: 'Public halves only. No endpoint returns a private key.',
    responses: { 200: json(z.array(sshKeySchema), 'Keys') },
  }),
  async (c) => c.json(await listSshKeys(), 200),
)

sshKeysRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ssh-keys',
    tags: ['ssh-keys'],
    summary: 'Generate an ed25519 key pair',
    description:
      'Generates with no passphrase, because the server clones unattended and ' +
      'nobody is there to type one. Add the returned public key to your git host ' +
      'as a deploy key, then use the test endpoint to confirm it works.',
    request: { body: json(createSshKeySchema, 'Key to generate') },
    responses: {
      201: json(sshKeySchema, 'Generated'),
      400: json(errorSchema, 'Invalid input'),
      409: json(errorSchema, 'A key with that name exists'),
    },
  }),
  async (c) => c.json(await createSshKey(c.req.valid('json')), 201),
)

sshKeysRouter.openapi(
  createRoute({
    method: 'post',
    path: '/ssh-keys/{id}/test',
    tags: ['ssh-keys'],
    summary: 'Check whether a host accepts this key',
    description:
      'Runs `ssh -T` against the host. GitHub and GitLab refuse a shell and exit ' +
      'non-zero even on success, so the greeting is what is inspected, not the exit code.',
    request: { params: idParam, body: json(testSshKeySchema, 'Host to try') },
    responses: { 200: json(testResultSchema, 'Result'), 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { host } = c.req.valid('json')
    return c.json(await testSshKey(id, host), 200)
  },
)

sshKeysRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/ssh-keys/{id}',
    tags: ['ssh-keys'],
    summary: 'Delete a key and remove its files',
    description:
      'Projects using it keep working but fall back to ssh defaults, since the ' +
      'reference is ON DELETE SET NULL.',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: json(errorSchema, 'Not found') },
  }),
  async (c) => {
    await deleteSshKey(c.req.valid('param').id)
    return c.body(null, 204)
  },
)
