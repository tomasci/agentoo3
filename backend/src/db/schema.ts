import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// --- projects -----------------------------------------------------------------

// A project is cloned from a remote, adopted from a folder in SOURCES_DIR, or
// created empty. All three end up as one directory under PROJECTS_DIR.
export const projectSourceEnum = pgEnum('project_source', ['clone', 'existing', 'empty'])

// 'needs_manual' is the interesting one: a private-repo clone failed, and the
// user has to authenticate over SSH themselves before we can continue.
export const projectStatusEnum = pgEnum('project_status', [
  'pending',
  'cloning',
  'ready',
  'needs_manual',
  'failed',
])

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Directory name under PROJECTS_DIR. Derived from the name, kept stable.
    slug: text('slug').notNull(),
    source: projectSourceEnum('source').notNull(),
    // For 'existing': the folder name under SOURCES_DIR it was adopted from.
    // Kept so the sources listing can mark it as taken.
    sourceName: text('source_name'),
    // Null for 'existing' projects that have no remote configured.
    remoteUrl: text('remote_url'),
    // Which key to authenticate the clone with. Null uses ssh's own defaults.
    sshKeyId: uuid('ssh_key_id').references(() => sshKeys.id, { onDelete: 'set null' }),
    defaultBranch: text('default_branch'),
    status: projectStatusEnum('status').notNull().default('pending'),
    // Populated when status is 'needs_manual' or 'failed'.
    lastError: text('last_error'),
    // Commands we hand the user to run over SSH to resolve auth themselves.
    recoveryCommands: jsonb('recovery_commands').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_slug_key').on(t.slug), index('projects_status_idx').on(t.status)],
)

// --- ssh keys -----------------------------------------------------------------

// Only the public half is stored. The private key lives on disk at 0600 and its
// path is recorded here, so a database dump never contains key material and the
// API has nothing private to leak.
export const sshKeys = pgTable(
  'ssh_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    comment: text('comment'),
    publicKey: text('public_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    privateKeyPath: text('private_key_path').notNull(),
    // Result of the last connectivity test, so the UI can say whether the key
    // has actually been authorised on the host yet.
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestHost: text('last_test_host'),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ssh_keys_name_key').on(t.name)],
)

// --- library assignments ------------------------------------------------------

// Agents and skills are markdown in LIBRARY_DIR, not rows. This table records
// only which of them a project uses, so the prompt bodies stay in files where
// they can be edited and diffed.
export const libraryKindEnum = pgEnum('library_kind', ['agent', 'skill'])

export const projectLibraryItems = pgTable(
  'project_library_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: libraryKindEnum('kind').notNull(),
    // Library item name, e.g. 'orchestrator' or 'testing'.
    name: text('name').notNull(),
    // Per-project overrides applied on top of the file's frontmatter
    // (model, effort, tools, maxTurns). Null means use the file as-is.
    overrides: jsonb('overrides').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_library_items_key').on(t.projectId, t.kind, t.name),
    index('project_library_items_project_idx').on(t.projectId),
  ],
)

// --- sessions -----------------------------------------------------------------

export const sessionStatusEnum = pgEnum('session_status', [
  'idle',
  'queued',
  'running',
  'interrupted',
  'completed',
  'failed',
])

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title'),
    status: sessionStatusEnum('status').notNull().default('idle'),

    // Which agent drives the main thread. Must be a role:orchestrator agent.
    orchestrator: text('orchestrator'),

    // Git isolation. Null on non-git projects, where sessions share repo/.
    worktreePath: text('worktree_path'),
    branch: text('branch'),

    // What the worktree above was actually cut from. All three stay null on
    // the shared-checkout path (worktree creation failed, or the project is
    // not a git repo at all) — a base branch on a session that never got its
    // own worktree would describe code it is not actually running.
    baseBranch: text('base_branch'),
    baseSha: text('base_sha'),
    // Why the base may be stale: no remote, the network being down, a
    // rejected key, or the branch missing from the remote. Its own column
    // rather than lastError, because session-run.worker.ts clears lastError
    // to null at the start of every turn — this note would last one turn and
    // then silently vanish.
    baseNote: text('base_note'),

    // The Agent SDK's own session id, needed to resume after a worker restart.
    sdkSessionId: text('sdk_session_id'),

    // Caps for this session, passed through to the SDK.
    maxBudgetUsd: integer('max_budget_usd'),
    lastError: text('last_error'),

    // Rolling totals across every turn, from each run's result message.
    totalCostUsd: doublePrecision('total_cost_usd').notNull().default(0),
    // Next seq to hand out. Kept on the session so a turn can allocate without
    // a max(seq) scan, and so gaps never appear after a failed insert.
    nextSeq: integer('next_seq').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_project_idx').on(t.projectId), index('sessions_status_idx').on(t.status)],
)

// --- messages -----------------------------------------------------------------

// Every SDK message, verbatim. This is the source of truth for history, not the
// JSONL files Claude Code writes to disk: those are keyed to filesystem paths
// and are an internal format.
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Monotonic per session, so the stream can be replayed in order and a
    // reconnecting client can ask for everything after a known point.
    seq: integer('seq').notNull(),
    // SDK message type: 'assistant' | 'user' | 'system' | 'result' | ... plus
    // 'prompt', ours, for a message the human typed. The SDK never emits that
    // type, so the two cannot be confused.
    type: text('type').notNull(),
    // True on a 'prompt' row that no turn has answered yet. This is the queue of
    // messages sent while a turn was already running.
    pending: boolean('pending').notNull().default(false),
    // Set when the message came from inside a subagent's context.
    parentToolUseId: text('parent_tool_use_id'),
    // Collapsed-row heading, derived from the SDK's own signals at write time
    // (task_started.description, task_progress.summary, tool_use_summary) and
    // stored so history renders identically without re-deriving it.
    title: text('title'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('messages_session_seq_key').on(t.sessionId, t.seq)],
)

// --- session files --------------------------------------------------------

// 'missing' is set by the GC job when a row's blob is gone from disk (a
// dangling row — see storage_anomalies below); the manifest and the per-turn
// announcement both omit it, so an agent is never pointed at a Read that will
// fail. 'unreadable' exists for a file that later turns out to be unopenable
// (e.g. corrupt on disk); nothing sets it at upload time today.
export const sessionFileStatusEnum = pgEnum('session_file_status', [
  'ready',
  'missing',
  'unreadable',
])

// One row per uploaded file. Bytes live on disk (see features/attachments/
// storage.ts); this is metadata only — Postgres never holds a blob.
export const sessionFiles = pgTable(
  'session_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // The name the human uploaded. Never used to build a path — see
    // storedName — so it can hold anything, including characters that would
    // be unsafe on disk.
    originalFilename: text('original_filename').notNull(),
    // The on-disk basename: `<file-uuid>-<sanitized-name>`. Generated, never
    // derived from user input directly, which is what keeps a `.claude`
    // subdirectory from ever being possible inside an uploads dir (see the
    // `.claude` trap in runner-options.ts).
    storedName: text('stored_name').notNull(),
    // Sniffed from content server-side, never the client's declared type and
    // never the extension alone. See features/attachments/sniff.ts.
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),
    status: sessionFileStatusEnum('status').notNull().default('ready'),
    // Line count for text-ish files, page count for PDFs — computed once
    // while the upload streams to disk (or, for PDFs, in one bounded extra
    // read right after) and cached here. The alternative — recomputing them
    // by re-reading every file's bytes each time ATTACHMENTS.md regenerates,
    // which happens on every upload and delete — would turn every mutation
    // into an O(session size) disk read.
    lineCount: integer('line_count'),
    pageCount: integer('page_count'),
    // Null until a turn has told the agent about this file. Set once, at
    // announcement time, by session-run.worker.ts — never diffed from a
    // timestamp, which would break on an interrupted turn, the auto-recovery
    // continuation path, or several messages queued during a long turn.
    announcedSeq: integer('announced_seq'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft delete: a user-deleted file keeps its row so a past message that
    // referenced it (see message_files) still resolves to something instead
    // of a broken join, and so its checksum can be re-uploaded later without
    // colliding with a row that no longer represents a real file.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('session_files_session_idx').on(t.sessionId),
    // Dedup is scoped to a session, and only among files still present — a
    // deleted file's checksum must not block re-adding the same content
    // later. A partial unique index expresses that at the database level
    // rather than only in the service layer's check-then-insert.
    uniqueIndex('session_files_session_checksum_key')
      .on(t.sessionId, t.checksum)
      .where(sql`${t.deletedAt} is null`),
  ],
)

// Which turn first surfaced a file to the agent — "attached at turn N" made
// explicit, for the UI paperclip, and the one place a message can still name
// a file whose row was later hard-deleted (gc.ts's cleanup can remove a
// dangling_row or a checksum_mismatch outright — see reconcile.ts). Populated
// by session-run.worker.ts when it stamps announcedSeq, linking the prompt
// message that carried the announcement to every file it just announced. The
// worker itself never reads this table back — it reads announcedSeq on the
// file row to decide what is new. One consumer per fact.
//
// `fileId` is nullable, ON DELETE SET NULL rather than cascade: a cascade
// here is what used to leave a message with nothing at all to say about an
// attachment whose row cleanup later removed (acceptance criterion 11 — "a
// message referencing an attachment whose row was cleaned up still renders,
// showing a 'file removed' placeholder" — had no way to hold with the link
// itself gone too). `originalFilename` is denormalised alongside it for the
// same reason: once fileId is null, it is the only thing left that can still
// say *which* file this was — nullable because a schema migration cannot
// retroactively know a name for a link created before this column existed.
export const messageFiles = pgTable(
  'message_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => sessionFiles.id, { onDelete: 'set null' }),
    originalFilename: text('original_filename'),
  },
  (t) => [
    index('message_files_message_idx').on(t.messageId),
    // Only meaningful while fileId is still live: several links for the same
    // message legitimately end up with a null fileId once cleanup clears it,
    // and Postgres already treats NULLs as distinct in a unique index, so the
    // WHERE is what keeps the original one-link-per-file guarantee for the
    // case that still matters without also forbidding that.
    uniqueIndex('message_files_message_file_key')
      .on(t.messageId, t.fileId)
      .where(sql`${t.fileId} is not null`),
  ],
)

// --- storage anomalies -----------------------------------------------------

// Exactly four classes, by design — see features/attachments/gc.ts:
//   orphan_blob        bytes on disk with no DB row
//   dangling_row       a DB row whose blob is missing (breaks a turn)
//   orphan_session_dir a storage-root directory whose session_id has no
//                       matching session row
//   checksum_mismatch  a row's size/checksum disagrees with the file on disk
export const storageAnomalyClassEnum = pgEnum('storage_anomaly_class', [
  'orphan_blob',
  'dangling_row',
  'orphan_session_dir',
  'checksum_mismatch',
])

// Persisted rather than computed on page load, so the page is instant and so
// an anomaly seen on three consecutive runs reads differently from one seen
// once mid-upload. Not deleted when it disappears — resolvedAt is set instead
// — so a flapping problem stays visible in history.
//
// sessionId and fileId carry no foreign key on purpose: for two of the four
// classes (orphan_blob, orphan_session_dir) the whole point is that the
// session or file they'd reference may not exist any more, or never matched
// one to begin with.
export const storageAnomalies = pgTable(
  'storage_anomalies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    class: storageAnomalyClassEnum('class').notNull(),
    sessionId: uuid('session_id'),
    fileId: uuid('file_id'),
    path: text('path'),
    originalFilename: text('original_filename'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    detail: text('detail'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('storage_anomalies_class_idx').on(t.class),
    index('storage_anomalies_session_idx').on(t.sessionId),
    // Two upsert keys, one per identity a class is found by: orphan_blob and
    // orphan_session_dir are filesystem-keyed (no row, so path is what
    // repeats across runs); dangling_row and checksum_mismatch are row-keyed
    // (path may be absent or wrong, so fileId is what repeats). Postgres
    // never treats two NULLs as colliding in a unique index, so the classes
    // that leave the other column NULL never spuriously conflict with each
    // other here.
    uniqueIndex('storage_anomalies_class_path_key').on(t.class, t.path),
    uniqueIndex('storage_anomalies_class_file_key').on(t.class, t.fileId),
  ],
)

// --- relations ----------------------------------------------------------------

export const projectsRelations = relations(projects, ({ one, many }) => ({
  sessions: many(sessions),
  libraryItems: many(projectLibraryItems),
  sshKey: one(sshKeys, { fields: [projects.sshKeyId], references: [sshKeys.id] }),
}))

export const sshKeysRelations = relations(sshKeys, ({ many }) => ({
  projects: many(projects),
}))

export const projectLibraryItemsRelations = relations(projectLibraryItems, ({ one }) => ({
  project: one(projects, { fields: [projectLibraryItems.projectId], references: [projects.id] }),
}))

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  project: one(projects, { fields: [sessions.projectId], references: [projects.id] }),
  messages: many(messages),
  files: many(sessionFiles),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
  files: many(messageFiles),
}))

export const sessionFilesRelations = relations(sessionFiles, ({ one, many }) => ({
  session: one(sessions, { fields: [sessionFiles.sessionId], references: [sessions.id] }),
  messages: many(messageFiles),
}))

export const messageFilesRelations = relations(messageFiles, ({ one }) => ({
  message: one(messages, { fields: [messageFiles.messageId], references: [messages.id] }),
  file: one(sessionFiles, { fields: [messageFiles.fileId], references: [sessionFiles.id] }),
}))
