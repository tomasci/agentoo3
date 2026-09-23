// editorProxyRouter with editorEnabled fixed to false for this file's entire
// run — a separate file from editor-proxy-http.scenarios.ts because
// `editorEnabled` (env.ts) is computed once at module load and cannot be
// flipped mid-file (see that file's own comment, and
// editor-service-disabled.scenarios.ts's identical one, for why).

import { expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname

const realEnv = { ...(await import(`${B}/env.ts`)) } as { env: Record<string, unknown> }
mock.module(`${B}/env.ts`, () => ({
  env: { ...realEnv.env, DOCKER_ENABLED: true, EDITOR_ENABLED: false },
  hasClaudeCredential: false,
  editorEnabled: false,
}))

// The disabled check has to come first — resolving scope (a project lookup,
// then a session lookup) before ever checking the flag would mean a disabled
// deployment still leaks whether a given project/session id exists.
mock.module(`${B}/features/projects/service.ts`, () => ({
  getProject: async () => {
    throw new Error('must not be reached: the disabled check comes first')
  },
}))
mock.module(`${B}/features/sessions/service.ts`, () => ({
  getSessionLocation: async () => {
    throw new Error('must not be reached: the disabled check comes first')
  },
}))

const { editorProxyRouter, editorProxyPath } = await import(`${B}/features/editor/proxy.ts`)

const testApp = new OpenAPIHono()
testApp.route('/api', editorProxyRouter)

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const BASE = editorProxyPath(PROJECT_ID, SESSION_ID).slice(0, -1)

test('a plain GET through the proxy is a 403 when the feature is disabled', async () => {
  const res = await testApp.request(`${BASE}/`, { headers: { host: 'myhost:3000' } })
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toContain('disabled')
})

test('a WebSocket upgrade attempt is also a 403, before any upstream dial', async () => {
  const res = await testApp.request(`${BASE}/`, {
    headers: {
      host: 'myhost:3000',
      origin: 'http://myhost:3000',
      connection: 'Upgrade',
      upgrade: 'websocket',
    },
  })
  expect(res.status).toBe(403)
})
