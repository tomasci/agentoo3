// Runs a `*.scenarios.ts` file as its own `bun test` subprocess.
//
// Every `*.scenarios.ts` file next to this one mocks `@/env.ts` and/or
// `ioredis` wholesale for the span of its own run — needed because resolving
// a session's editor scope means driving the REAL resolveDockerScope (and, in
// turn, the REAL operations.ts lock/record logic) against controlled
// fixtures. bun:test's own docs describe `mock.module()` as overwriting an
// ALREADY-LOADED module's exports in place, which is only safe for a mock
// whose entire *process* it owns: `bun test tests/` otherwise runs every test
// file inside ONE shared process with ONE shared module registry, and this
// codebase's async, interleaved test execution means another file's own use
// of the SAME module (env.ts's `PROJECTS_DIR`, or `ioredis` itself) can
// observe the mock mid-flight — this was caught, concretely, as
// system.test.ts's disk-fallback path and lib/events.ts's pub/sub tests
// intermittently reading back an editor test's own temp PROJECTS_DIR / fake
// Redis class instead of their own.
//
// A subprocess gives each `*.scenarios.ts` file a private module registry
// instead — the exact same reasoning the `*-db-child.ts` convention already
// uses for a real Postgres cluster (see attachments-db.test.ts's own header),
// just for module-registry isolation rather than a stateful external
// resource. `stdout`/`stderr` are inherited so a failure's real assertion
// output — not just "exit 1" — shows up directly in this run's own output.

const BACKEND_DIR = new URL('..', import.meta.url).pathname

export async function runIsolatedScenarios(scenariosFile: string): Promise<void> {
  const proc = Bun.spawn(['bun', 'test', `./tests/${scenariosFile}`], {
    cwd: BACKEND_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`${scenariosFile} failed in its own isolated process (exit code ${code})`)
  }
}
