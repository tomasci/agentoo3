// Takes one Postgres backup now, exactly as the worker's daily job does —
// same directory, same naming, same lock, same retention — so a backup taken
// by hand before something risky is just the newest backup on the list:
//
//   sudo systemd-run --uid=agentoo --gid=agentoo --working-directory=/opt/agentoo/backend \
//     -p EnvironmentFile=/opt/agentoo/.env --wait --pipe --quiet bun run backup
//
// It needs the install's own DATABASE_URL and BACKUPS_DIR, which systemd
// hands the services from /opt/agentoo/.env and nothing puts in an operator's
// shell. That file is readable by root only, so systemd-run rather than
// `sudo -u agentoo bun --env-file=...`: bun skips an --env-file it cannot
// read without a word, and this would then fail on a missing DATABASE_URL.
// Runs whatever BACKUPS_ENABLED says (that switch is for the scheduled job),
// waits for a backup already in progress rather than overlapping it, and
// exits non-zero if it failed. Never touches Redis: this goes through
// features/backups/service.ts directly, not the queue.

import { closeDb } from '@/db/client'
import { runDbBackup } from '@/features/backups/service'

const result = await runDbBackup({ reason: 'manual' })
await closeDb()
if (result.status === 'created') console.log(result.path)
process.exit(result.status === 'failed' ? 1 : 0)
