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
//
// It also marks its database as disposable (see startTempCluster), and that
// marker is what lets anything destructive run against it: every DB child
// refuses to start without it (disposable-db-guard.ts), and the bulk-delete
// guard triggers from migration 0015 step aside for it, so the suite's resets
// can still delete every project. A test that needs those triggers live asks
// for the guarded database as well (TempClusterOptions.guardedDatabase).

import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listen } from 'bun'
import {
  DISPOSABLE_DB_SETTING,
  DISPOSABLE_GUARDED_VALUE,
  DISPOSABLE_VALUE,
} from './disposable-db-guard'

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

/** The superuser every temp server is initdb'd with. Trust auth, no password. */
export const SUPERUSER = 'tester'

/** A started, empty server: no databases beyond initdb's own. */
export interface TempServer {
  /** The Postgres bin directory (initdb, psql, pg_dump, pg_restore, ...). */
  bin: string
  port: number
  /** postgres://<user>@127.0.0.1:<port>/<database>; the superuser by default. */
  url: (database: string, user?: string) => string
  /** psql -v ON_ERROR_STOP=1 as the superuser; throws with its stderr. */
  psql: (database: string, args: string[]) => Promise<void>
  stop: () => Promise<void>
}

/**
 * initdb and start a server, nothing more. startTempCluster is what nearly
 * every test wants; this is for the few that set the database up themselves
 * (migrate-after-restore.test.ts migrates as a non-superuser owner).
 *
 * `fsync=off` and `full_page_writes=off`: this cluster is deleted at the end
 * of the file, so durability across a crash is worth nothing and costs a
 * second of test time.
 */
export async function startTempServer(): Promise<TempServer> {
  const bin = postgresBinDir()
  if (!bin) throw new Error('No Postgres server binaries found')

  const dir = await mkdtemp(join(tmpdir(), 'agentoo-pg-'))
  const data = join(dir, 'data')
  const sockets = join(dir, 'sockets')
  await mkdir(sockets, { recursive: true })
  const port = freePort()

  const stop = async () => {
    await run(
      [join(bin, 'pg_ctl'), '-D', data, '-m', 'immediate', '-w', 'stop'],
      'pg_ctl stop',
    ).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }

  try {
    await run(
      [join(bin, 'initdb'), '-D', data, '-U', SUPERUSER, '--auth=trust', '-E', 'UTF8'],
      'initdb',
    )
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
  } catch (error) {
    await stop()
    throw error
  }

  return {
    bin,
    port,
    url: (database, user = SUPERUSER) => `postgres://${user}@127.0.0.1:${port}/${database}`,
    psql: (database, args) =>
      run(
        [
          join(bin, 'psql'),
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '-q',
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-U',
          SUPERUSER,
          '-d',
          database,
          ...args,
        ],
        'psql',
      ),
    stop,
  }
}

export interface TempClusterOptions {
  /**
   * Also create `guarded_test`: a copy of the freshly migrated database,
   * marked agentoo.disposable_test_db = 'guarded' instead of 'on'. Still a
   * throwaway database as far as assertDisposableTestDb is concerned, so a DB
   * child may run against it, but the bulk-delete guard triggers stay live
   * there, exactly as in production. The only way to get them live inside a
   * temp cluster: they read the marker from the database's own settings, so
   * nothing a connection sends can switch them back on in a database marked
   * 'on'.
   */
  guardedDatabase?: boolean
}

export interface Cluster {
  /** The migrated database, marked 'on': the guard triggers step aside. */
  connectionString: string
  /** Set only with { guardedDatabase: true }: the same schema, guard live. */
  guardedConnectionString?: string
  stop: () => Promise<void>
}

/**
 * initdb, start, create a database, apply every migration in order, then mark
 * the database disposable (and, if asked, copy it into a guarded one first).
 */
export async function startTempCluster(
  migrationsDir: string,
  options: TempClusterOptions = {},
): Promise<Cluster> {
  const server = await startTempServer()
  const { psql } = server
  try {
    await psql('postgres', ['-c', 'create database attachments_test'])
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
    for (const name of files) await psql('attachments_test', ['-f', join(migrationsDir, name)])

    if (options.guardedDatabase) {
      // A template copy rather than a second migration run: same schema,
      // a fraction of the time. Database-level settings are not part of a
      // template, so it starts with no marker of its own.
      await psql('postgres', ['-c', 'create database guarded_test template attachments_test'])
      await psql('postgres', [
        '-c',
        `alter database guarded_test set ${DISPOSABLE_DB_SETTING} = '${DISPOSABLE_GUARDED_VALUE}'`,
      ])
    }

    // The disposable marker. ALTER DATABASE ... SET, which only a superuser
    // can do for this parameter, rather than anything a connection could
    // carry: the guard triggers and assertDisposableTestDb both read it from
    // pg_db_role_setting, never current_setting(). After migrating, so that
    // no migration ever runs with it on. Never set this on a real database.
    await psql('postgres', [
      '-c',
      `alter database attachments_test set ${DISPOSABLE_DB_SETTING} = '${DISPOSABLE_VALUE}'`,
    ])
  } catch (error) {
    await server.stop()
    throw error
  }

  return {
    connectionString: server.url('attachments_test'),
    guardedConnectionString: options.guardedDatabase ? server.url('guarded_test') : undefined,
    stop: server.stop,
  }
}
