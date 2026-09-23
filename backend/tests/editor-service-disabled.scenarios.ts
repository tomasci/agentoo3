// requestEditorStart/requestEditorStop/getEditorStatus with editorEnabled
// fixed to false for this file's entire run — a separate file from
// editor-service.test.ts because `editorEnabled` (env.ts) is computed once at
// module load and cannot be flipped mid-file (see that file's own comment on
// why); this file only ever needs the one, disabled-from-the-start value.

import { expect, mock, test } from 'bun:test'
import './setup-env'

const B = new URL('../src', import.meta.url).pathname

const realEnv = { ...(await import(`${B}/env.ts`)) } as { env: Record<string, unknown> }
mock.module(`${B}/env.ts`, () => ({
  env: { ...realEnv.env, DOCKER_ENABLED: false, EDITOR_ENABLED: true },
  hasClaudeCredential: false,
  editorEnabled: false,
}))

// Neither project/session resolution nor the docker CLI should ever be
// reached once the disabled check refuses first — both throw if called at
// all, which is what proves the ordering (design's own step 1, "flags (403)
// before anything else").
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

const { requestEditorStart, requestEditorStop } = await import(`${B}/features/editor/service.ts`)
const { AppError } = await import(`${B}/lib/errors.ts`)

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const cliThatMustNotBeCalled = {
  run: () => {
    throw new Error('must not be reached: the disabled check comes first')
  },
  stream: () => {
    throw new Error('must not be reached: the disabled check comes first')
  },
}

test('start is refused with 403 before the project/session/daemon are ever touched', async () => {
  await expect(
    requestEditorStart(PROJECT_ID, SESSION_ID, cliThatMustNotBeCalled as never),
  ).rejects.toMatchObject({ status: 403 })
})

test('stop is refused with 403 the same way', async () => {
  await expect(
    requestEditorStop(PROJECT_ID, SESSION_ID, cliThatMustNotBeCalled as never),
  ).rejects.toMatchObject({ status: 403 })
})

test('the 403 names which flag is responsible', async () => {
  try {
    await requestEditorStart(PROJECT_ID, SESSION_ID, cliThatMustNotBeCalled as never)
    throw new Error('expected requestEditorStart to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as InstanceType<typeof AppError>).message).toContain('disabled')
  }
})
