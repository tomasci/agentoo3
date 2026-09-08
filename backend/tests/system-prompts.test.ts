// GET/PUT/DELETE for the operator-editable prompt registry, exercised through
// the actual router rather than by calling the service functions straight —
// the blank-body rejection is a zod rule on the route's request schema, not a
// check the service repeats, so calling updatePrompt() directly would miss it
// entirely and pass on a bug a real client would hit immediately.
//
// LIBRARY_DIR is mutated on the already-parsed `env` object, not via
// process.env — see the identical `withLibraryDir` helper in
// idea-serialize.test.ts. `@/env` parses process.env once at first import and
// bun shares the module registry across every test file in the run (see
// setup-env.ts), so by the time this file loads, something earlier in the
// suite has almost certainly already imported `@/env` and frozen LIBRARY_DIR
// at its default — which is /opt/agentoo/library on a real box, not a
// scratch directory. Setting process.env.LIBRARY_DIR here would silently do
// nothing and this suite would read and write the real, deployed library
// instead of a tmp one. Mutating the parsed `env.LIBRARY_DIR` field directly
// sidesteps that: every path helper in library/index.ts reads it fresh, per
// call.

import { afterAll, beforeAll, expect, test } from 'bun:test'

import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { env } from '../src/env'
import { getPrompt } from '../src/features/system/prompts'
import { systemRouter } from '../src/features/system/routes'
import { IDEA_PROMPT_INSTRUCTION_FALLBACK } from '../src/library/idea-prompt'
import { AppError, errorBody } from '../src/lib/errors'
import { openApiValidationHook } from '../src/lib/openapi-hook'

const NAME = 'idea-to-prompt'
const dir = await mkdtemp(join(tmpdir(), 'agentoo-system-prompts-'))
const previousLibraryDir = env.LIBRARY_DIR

beforeAll(() => {
  env.LIBRARY_DIR = dir
})

afterAll(async () => {
  env.LIBRARY_DIR = previousLibraryDir
  await rm(dir, { recursive: true, force: true })
})

// Mounted exactly the way createApp() mounts every feature router (app.ts),
// without pulling in the whole app: none of these routes touch the database
// or the queue, so nothing here needs the mocking api-error-envelope.test.ts
// needs for sessionsRouter.
const parent = new OpenAPIHono({ defaultHook: openApiValidationHook })
// AppError -> status code is app.ts's job (createApp's own onError) once this
// router is mounted under the real app; mirrored here so a thrown 404 reads
// as one rather than the generic 500 Hono gives an uncaught error otherwise —
// see sessionsRouter.onError (sessions/routes.ts) for the same need.
parent.onError((error, c) => {
  if (error instanceof AppError) return c.json(errorBody(error), error.status as 400)
  throw error
})
parent.route('/api', systemRouter)

const path = (name: string) => `/api/system/prompts/${name}`
const putJson = (name: string, body: unknown) =>
  parent.request(path(name), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('no file on disk: GET reports source "default" with a non-empty built-in body', async () => {
  const res = await parent.request(path(NAME))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.source).toBe('default')
  expect(body.name).toBe(NAME)
  expect(typeof body.body).toBe('string')
  expect(body.body.length).toBeGreaterThan(0)
  expect(body.body).toBe(IDEA_PROMPT_INSTRUCTION_FALLBACK)
})

test('PUT saves the body, then GET reports source "file" with it round-tripped', async () => {
  const putRes = await putJson(NAME, { body: 'Be terse. Always name the file you mean.' })
  expect(putRes.status).toBe(200)
  const saved = await putRes.json()
  expect(saved.source).toBe('file')
  expect(saved.body).toBe('Be terse. Always name the file you mean.')

  const getRes = await parent.request(path(NAME))
  expect(getRes.status).toBe(200)
  const read = await getRes.json()
  expect(read.source).toBe('file')
  expect(read.body).toBe('Be terse. Always name the file you mean.')
})

test('PUT with a blank body 400s naming the rule, and leaves the saved file untouched', async () => {
  const before = await (await parent.request(path(NAME))).json()

  const res = await putJson(NAME, { body: '   ' })
  expect(res.status).toBe(400)
  const failure = await res.json()
  expect(failure.error).toBe('Validation failed')
  expect(
    (failure.issues as Array<{ message: string }>).some((issue) =>
      issue.message.toLowerCase().includes('blank'),
    ),
  ).toBe(true)

  const after = await (await parent.request(path(NAME))).json()
  expect(after).toEqual(before)
})

test('DELETE reverts to the built-in default, not a copy of it written back to disk', async () => {
  const res = await parent.request(path(NAME), { method: 'DELETE' })
  expect(res.status).toBe(200)
  const reset = await res.json()
  expect(reset.source).toBe('default')
  expect(reset.body).toBe(IDEA_PROMPT_INSTRUCTION_FALLBACK)

  const getRes = await parent.request(path(NAME))
  expect((await getRes.json()).source).toBe('default')
})

test('an unknown prompt name is a 404', async () => {
  const res = await parent.request(path('not-a-known-prompt'))
  expect(res.status).toBe(404)
})

// Tested against the service function directly rather than over HTTP: a
// single path *segment* cannot literally contain '/', so exercising this over
// `parent.request` would only be a test of URL-encoding semantics, not of the
// guard this is actually about. The guard itself — checkLibraryName's shape
// check, reused exactly as agents and skills do — is synchronous and pure, so
// asserting against it directly is both the more precise test and the one
// that cannot pass by accident of how a router happens to decode %2F.
test('a name containing ../ is rejected before it ever reaches the filesystem', async () => {
  const error = await getPrompt('../../../../etc/passwd').catch((e: unknown) => e)
  expect((error as { status: number }).status).toBe(400)
  // checkLibraryName's shape check rejects it before promptPath() (and thus
  // insideLibrary's outside-the-root guard, library/index.ts) is ever reached
  // — nothing is read or written for a name shaped like this.
})
