// Shared plumbing for the learning-verify-* suites: spawn one child script in
// a fresh process (Bun's mock.module is process-wide, and @/env parses
// process.env once, at first import — the same reasons every *-db-child.ts
// here runs in a child) and collect the JSON facts it prints after a
// `__FACTS__` marker. Not itself a test file.

import { join } from 'node:path'

export const BACKEND = new URL('..', import.meta.url).pathname

export type Facts = Record<string, Record<string, unknown>>

export interface ChildResult {
  facts: Facts
  error: string
}

/** Every credential the developer's own shell might carry, stripped so a
 * child decides for itself whether it has one. */
const CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

export async function runChild(
  script: string,
  env: Record<string, string | undefined>,
  timeoutMs = 180_000,
): Promise<ChildResult> {
  const base: Record<string, string | undefined> = { ...process.env }
  for (const key of CREDENTIAL_KEYS) delete base[key]
  const child = Bun.spawn(['bun', join(BACKEND, 'tests', script)], {
    cwd: BACKEND,
    env: { ...base, LOG_LEVEL: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(killer)
  const marker = stdout.lastIndexOf('__FACTS__')
  if (code !== 0 || marker === -1) {
    const errAt = stdout.indexOf('__ERROR__')
    const failure = errAt === -1 ? stderr.slice(-4000) || stdout.slice(-4000) : stdout.slice(errAt)
    return { facts: {}, error: `${script} exited ${code}: ${failure}` }
  }
  return {
    facts: JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim().split('\n')[0] ?? '{}') as Facts,
    error: '',
  }
}

/** Reads one named group of facts, failing loudly (with the child's own
 * error) when the child never produced it. */
export function factReader(result: () => ChildResult) {
  return <T = Record<string, unknown>>(key: string): T => {
    const value = result().facts[key]
    if (!value) throw new Error(`child produced no "${key}" facts (child error: ${result().error})`)
    return value as T
  }
}
