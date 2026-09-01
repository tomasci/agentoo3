import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { sshKeys } from '@/db/schema'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { checkComment, checkKeyName, deleteKeyFiles, generateKey, testKey } from '@/lib/ssh'
import type { CreateSshKeyInput, SshKeyDto } from './schema'

type SshKeyRow = typeof sshKeys.$inferSelect

function toDto(row: SshKeyRow): SshKeyDto {
  return {
    id: row.id,
    name: row.name,
    comment: row.comment,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestHost: row.lastTestHost,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listSshKeys(): Promise<SshKeyDto[]> {
  const rows = await db.select().from(sshKeys).orderBy(sshKeys.createdAt)
  return rows.map(toDto)
}

export async function createSshKey(input: CreateSshKeyInput): Promise<SshKeyDto> {
  // The name becomes a filename, so it is validated before any I/O.
  const nameCheck = checkKeyName(input.name)
  if (!nameCheck.ok) throw badRequest(nameCheck.reason ?? 'Invalid name')

  const comment = input.comment ?? ''
  const commentCheck = checkComment(comment)
  if (!commentCheck.ok) throw badRequest(commentCheck.reason ?? 'Invalid comment')

  const [existing] = await db.select().from(sshKeys).where(eq(sshKeys.name, input.name)).limit(1)
  if (existing) throw conflict(`A key named "${input.name}" already exists`)

  let generated: Awaited<ReturnType<typeof generateKey>>
  try {
    generated = await generateKey(input.name, comment)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Could not generate the key')
  }

  const [row] = await db
    .insert(sshKeys)
    .values({
      name: generated.name,
      comment: comment || null,
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      privateKeyPath: generated.privateKeyPath,
    })
    .returning()

  if (!row) throw new Error('Insert returned no row')
  return toDto(row)
}

export async function testSshKey(
  id: string,
  host: string,
): Promise<{ ok: boolean; message: string }> {
  const [row] = await db.select().from(sshKeys).where(eq(sshKeys.id, id)).limit(1)
  if (!row) throw notFound('SSH key')

  const result = await testKey(row.privateKeyPath, host)

  await db
    .update(sshKeys)
    .set({
      lastTestedAt: new Date(),
      lastTestHost: host,
      lastTestOk: result.ok,
      lastTestMessage: result.message,
    })
    .where(eq(sshKeys.id, id))

  logger.info(`Tested key ${row.name} against ${host}: ${result.ok ? 'ok' : 'failed'}`)
  return result
}

export async function deleteSshKey(id: string): Promise<void> {
  const [row] = await db.select().from(sshKeys).where(eq(sshKeys.id, id)).limit(1)
  if (!row) throw notFound('SSH key')

  // Projects referencing it are left in place; the column is ON DELETE SET NULL,
  // so they fall back to ssh's own defaults rather than disappearing.
  await db.delete(sshKeys).where(eq(sshKeys.id, id))
  await deleteKeyFiles(row.name)
  logger.info(`Deleted ssh key ${row.name}`)
}

/** The private key path for a project's key, if it has one. */
export async function keyPathFor(sshKeyId: string | null): Promise<string | undefined> {
  if (!sshKeyId) return undefined
  const [row] = await db.select().from(sshKeys).where(eq(sshKeys.id, sshKeyId)).limit(1)
  return row?.privateKeyPath
}
