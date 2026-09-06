// A throwaway Postgres cluster in /tmp, for the one test file that needs a
// real database.
//
// The rest of this suite fakes `db` (see session-recovery.test.ts) because the
// query shapes it exercises are simple enough to fake honestly. The
// attachments reconciliation job is not: it turns on partial unique indexes,
// `on conflict do update`, cascade deletes and a transaction, and a fake that
// answered all of those would be a re-implementation of Postgres, not a test
// of the job. So this initdb's a private cluster on a kernel-assigned port,
// applies the real migration files to it, and throws the whole directory away
// afterwards. It never touches the deployment's own database.

import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listen } from 'bun'

/** The bin directory of an installed server, or undefined if there is none. */
export function postgresBinDir(): string | undefined {
  const fromPath = Bun.which('initdb')
  if (fromPath) return fromPath.slice(0, fromPath.lastIndexOf('/'))
  const root = '/usr/lib/postgresql'
  if (!existsSync(root)) return undefined
  const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a))
  for (const version of versions) {
    const bin = join(root, version, 'bin')
    if (existsSync(join(bin, 'initdb'))) return bin
  }
  return undefined
}

/** A port the kernel just handed out, released again immediately — the same
 * trick setup-env.ts uses to keep two concurrent runs off one another. */
function freePort(): number {
  const probe = listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

async function run(cmd: string[], label: string): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`${label} failed (${code}): ${stderr.trim()}`)
}

export interface Cluster {
  connectionString: string
  stop: () => Promise<void>
}

/**
 * initdb, start, create a database, apply every migration in order.
 *
 * `fsync=off` and `full_page_writes=off`: this cluster is deleted at the end
 * of the file, so durability across a crash is worth nothing and costs a
 * second of test time.
 */
export async function startTempCluster(migrationsDir: string): Promise<Cluster> {
  const bin = postgresBinDir()
  if (!bin) throw new Error('No Postgres server binaries found')

  const dir = await mkdtemp(join(tmpdir(), 'agentoo-pg-'))
  const data = join(dir, 'data')
  const sockets = join(dir, 'sockets')
  await mkdir(sockets, { recursive: true })
  const port = freePort()

  await run([join(bin, 'initdb'), '-D', data, '-U', 'tester', '--auth=trust', '-E', 'UTF8'], 'initdb')
  await run(
    [
      join(bin, 'pg_ctl'),
      '-D',
      data,
      '-o',
      // The default unix_socket_directories is /var/run/postgresql, which
      // this user cannot write to — the server refuses to start without a
      // socket directory of its own even when only TCP is used.
      `-p ${port} -h 127.0.0.1 -k ${sockets} -c fsync=off -c full_page_writes=off`,
      '-l',
      join(dir, 'server.log'),
      '-w',
      '-t',
      '30',
      'start',
    ],
    'pg_ctl start',
  )

  const stop = async () => {
    await run([join(bin, 'pg_ctl'), '-D', data, '-m', 'immediate', '-w', 'stop'], 'pg_ctl stop').catch(
      () => {},
    )
    await rm(dir, { recursive: true, force: true })
  }

  try {
    const psql = (database: string, args: string[]) =>
      run([join(bin, 'psql'), '-v', 'ON_ERROR_STOP=1', '-q', '-h', '127.0.0.1', '-p', String(port), '-U', 'tester', '-d', database, ...args], 'psql')

    await psql('postgres', ['-c', 'create database attachments_test'])
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
    for (const name of files) await psql('attachments_test', ['-f', join(migrationsDir, name)])
  } catch (error) {
    await stop()
    throw error
  }

  return { connectionString: `postgres://tester@127.0.0.1:${port}/attachments_test`, stop }
}
