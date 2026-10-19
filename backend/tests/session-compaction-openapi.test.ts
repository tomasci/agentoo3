// What the rendered OpenAPI document promises about compaction — the generated
// frontend client is built from that document, not from the zod schemas, so this
// is the contract the client code is written against: the two operation ids, the
// SessionCompaction component with every field present (null rather than
// absent), and exactly the error responses the routes can return.
//
// Rendered the way turn-mode-openapi.test.ts renders it, for the same reason: in
// a real subprocess, because producing the document constructs BullMQ queues.

import { expect, test } from 'bun:test'

const BACKEND_DIR = new URL('..', import.meta.url).pathname

type Schema = {
  type?: string
  format?: string
  nullable?: boolean
  enum?: (string | null)[]
  $ref?: string
  description?: string
  properties?: Record<string, Schema>
}
type Operation = {
  operationId?: string
  parameters?: { name: string; in: string; required?: boolean; schema: Schema }[]
  responses: Record<string, { content?: { 'application/json': { schema: Schema } } }>
}
type Spec = {
  paths: Record<string, { get?: Operation; post?: Operation }>
  components: {
    schemas: Record<string, { properties?: Record<string, Schema>; required?: string[] }>
  }
}

const spec = await (async (): Promise<Spec> => {
  const proc = Bun.spawn(['bun', 'run', 'openapi'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: 'unused', REDIS_URL: 'unused' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code, `bun run openapi failed:\n${stdout}\n${stderr}`).toBe(0)
  return (await Bun.file(`${BACKEND_DIR}openapi.json`).json()) as Spec
})()

const create = spec.paths['/api/sessions/{id}/compactions']?.post
const read = spec.paths['/api/sessions/{id}/compactions/{compactionId}']?.get

test('both operations exist under their agreed ids', () => {
  expect(create?.operationId).toBe('createSessionCompaction')
  expect(read?.operationId).toBe('getSessionCompaction')
})

test('creating answers 202 with the SessionCompaction component, and declares the errors it returns', () => {
  expect(create?.responses['202']?.content?.['application/json'].schema.$ref).toBe(
    '#/components/schemas/SessionCompaction',
  )
  // 404 unknown session, 409 running or project not ready, 503 queue down: every
  // one of them is returned by the handler, so every one is declared.
  expect(Object.keys(create?.responses ?? {}).sort()).toEqual(['202', '404', '409', '503'])
})

test('reading answers 200 with the same component, or 404', () => {
  expect(read?.responses['200']?.content?.['application/json'].schema.$ref).toBe(
    '#/components/schemas/SessionCompaction',
  )
  expect(Object.keys(read?.responses ?? {}).sort()).toEqual(['200', '404'])
})

test('both path parameters are uuids', () => {
  expect(create?.parameters?.map((p) => [p.name, p.in, p.schema.format])).toEqual([
    ['id', 'path', 'uuid'],
  ])
  expect(read?.parameters?.map((p) => [p.name, p.in, p.schema.format])).toEqual([
    ['id', 'path', 'uuid'],
    ['compactionId', 'path', 'uuid'],
  ])
})

test('SessionCompaction has exactly the agreed fields, all required, nullable where promised', () => {
  const component = spec.components.schemas.SessionCompaction
  expect(Object.keys(component?.properties ?? {}).sort()).toEqual(
    [
      'costUsd',
      'createdAt',
      'error',
      'finishedAt',
      'id',
      'method',
      'resultSessionId',
      'sourceSessionId',
      'startedAt',
      'status',
    ].sort(),
  )
  // A field the client reads must always be there: null, not absent.
  expect([...(component?.required ?? [])].sort()).toEqual(
    Object.keys(component?.properties ?? {}).sort(),
  )

  const p = component?.properties ?? {}
  expect(p.id).toMatchObject({ type: 'string', format: 'uuid' })
  expect(p.sourceSessionId?.type).toBe('string')
  expect(p.status?.enum).toEqual(['pending', 'running', 'succeeded', 'failed'])
  expect(p.method?.enum).toEqual(['sdk_compact', 'transcript_summary', null])
  expect(p.method?.nullable).toBe(true)
  expect(p.costUsd?.type).toBe('number')
  expect(p.costUsd?.nullable).toBeUndefined()
  for (const nullable of ['resultSessionId', 'error', 'startedAt', 'finishedAt']) {
    expect(p[nullable]?.nullable).toBe(true)
    expect(p[nullable]?.type).toBe('string')
  }
  expect(p.createdAt).toMatchObject({ type: 'string' })
  expect(p.createdAt?.nullable).toBeUndefined()
})

test("the message type description tells a client about 'compact_context'", () => {
  // SessionMessage is not a named component; the send-message response is
  // where a client first meets one inline.
  const sent = spec.paths['/api/sessions/{id}/messages']?.post?.responses['201']
  const type = sent?.content?.['application/json'].schema.properties?.type
  expect(type?.description).toContain('compact_context')
  expect(type?.description).toContain('prompt')
})
