// What the rendered OpenAPI document promises about `mode` on
// POST /api/sessions/{id}/messages — the generated frontend client is built from
// that document, not from the zod schema. The property that matters is that
// `mode` is *optional* in the request: a client generated from a document that
// listed it as required would fail to compile for every caller that still sends
// only `{ text }`, and the schema accepting such a body would not have shown it.
//
// Rendered the way editor-openapi.test.ts renders it, for the same reason: in a
// real subprocess, because producing the document constructs BullMQ queues.

import { expect, test } from 'bun:test'

const BACKEND_DIR = new URL('..', import.meta.url).pathname

test('mode is an optional code|qa enum on the send-message request body', async () => {
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

  const spec = (await Bun.file(`${BACKEND_DIR}openapi.json`).json()) as {
    paths: Record<
      string,
      {
        post?: {
          requestBody?: {
            required?: boolean
            content: {
              'application/json': {
                schema: {
                  properties: Record<string, { type?: string; enum?: string[]; default?: unknown }>
                  required?: string[]
                }
              }
            }
          }
        }
      }
    >
  }
  const body = spec.paths['/api/sessions/{id}/messages']?.post?.requestBody
  const schema = body?.content['application/json'].schema

  expect(schema?.required).toEqual(['text'])
  expect(schema?.properties.mode?.enum).toEqual(['code', 'qa'])
  expect(schema?.properties.mode?.default).toBe('code')
  expect(schema?.properties.text?.type).toBe('string')
})
