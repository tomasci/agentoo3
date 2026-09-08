import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
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

    // Touched by a timer inside a running turn. Proves the *worker process* is
    // alive and holding the turn — not that the agent itself is making
    // progress. Exists because updatedAt freezes the moment the turn is
    // claimed, so a healthy 40-minute turn and a worker that died mid-turn
    // are otherwise indistinguishable from the row alone.
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_project_idx').on(t.projectId),
    index('sessions_status_idx').on(t.status),
    // Only 'running' sessions have a heartbeat worth scanning for — a stalled
    // watchdog query over every idle/completed session would be pure waste.
    index('sessions_heartbeat_idx').on(t.heartbeatAt).where(sql`${t.status} = 'running'`),
  ],
)

// --- messages -----------------------------------------------------------------

// A board switches on this exhaustively, so it is a pgEnum rather than text: an
// unconstrained column that silently gained a fourteenth value is how a card
// ends up stuck in a column forever instead of the switch failing loudly.
export const turnOutcomeEnum = pgEnum('turn_outcome', [
  'completed',
  'stopped_turn_limit',
  'stopped_api_error',
  'stopped_execution_error',
  'stopped_over_budget',
  'failed',
  'stalled',
  'continuing',
  'drained',
  'interrupted',
  'unknown',
  'abandoned',
  'stranded',
])

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

    // The five columns below are meaningful only on a 'prompt' row — the same
    // "nullable and only meaningful for one type" shape `pending` above and
    // session_files.announcedSeq already have.
    //
    // Stamped when a turn claims this prompt.
    turnStartedAt: timestamp('turn_started_at', { withTimezone: true }),
    // Null means no verdict has been rendered yet — that null-ness *is* the
    // state machine. Nothing derives a turn's state from timestamp
    // arithmetic against turnStartedAt; it is read as present-or-absent only.
    turnEndedAt: timestamp('turn_ended_at', { withTimezone: true }),
    turnOutcome: turnOutcomeEnum('turn_outcome'),
    // The human-readable sentence. Its own column rather than a read of
    // sessions.lastError, because the next turn's claim resets lastError to
    // null — exactly the trap sessions.baseNote already documents above, and
    // for the same reason.
    turnDetail: text('turn_detail'),
    // Set on an auto-continuation prompt to point at the prompt whose turn
    // spawned it, so a continuation chain is reconstructible from the
    // transcript alone, with no live observer required.
    continuesMessageId: uuid('continues_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_session_seq_key').on(t.sessionId, t.seq),
    // Finding turns that were claimed but never rendered a verdict.
    index('messages_turn_open_idx')
      .on(t.sessionId)
      .where(sql`${t.turnStartedAt} is not null and ${t.turnEndedAt} is null`),
    // Finding abandoned prompts. Also helps the existing pendingFor query,
    // which scans today.
    index('messages_pending_idx').on(t.sessionId).where(sql`${t.pending}`),
  ],
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

// Two storage roots now feed this table (sessions, ideas), each producing
// anomalies keyed either by path or by row:
//   orphan_blob             bytes on disk with no DB row, either root
//   dangling_row            a session_files row whose blob is missing
//   orphan_session_dir      a session storage-root dir with no matching
//                           session row
//   checksum_mismatch       a session_files row's size/checksum disagrees
//                           with the file on disk
//   orphan_idea_dir         an idea storage-root dir with no matching idea row
//   idea_dangling_row       an idea_files row whose blob is missing
//   idea_checksum_mismatch  an idea_files row's size/checksum disagrees with
//                           the file on disk
//
// orphan_blob generalises across both roots unchanged, because it is keyed on
// `path` and paths are globally unique regardless of which root they live
// under. The two row-keyed classes per root cannot generalise the same way:
// they are keyed on (class, fileId) and remediation deletes from a specific
// table (session_files vs idea_files), so each root needs its own class to
// discriminate. Carrying that in `class` rather than in a new column is the
// cheapest place to put it — class is already half of both unique keys below
// and half of every remediation branch in gc.ts.
export const storageAnomalyClassEnum = pgEnum('storage_anomaly_class', [
  'orphan_blob',
  'dangling_row',
  'orphan_session_dir',
  'checksum_mismatch',
  'orphan_idea_dir',
  'idea_dangling_row',
  'idea_checksum_mismatch',
])

// Persisted rather than computed on page load, so the page is instant and so
// an anomaly seen on three consecutive runs reads differently from one seen
// once mid-upload. Not deleted when it disappears — resolvedAt is set instead
// — so a flapping problem stays visible in history.
//
// sessionId and fileId carry no foreign key on purpose: for the orphan
// classes (orphan_blob, orphan_session_dir, orphan_idea_dir) the whole point
// is that the session, idea or file they'd reference may not exist any more,
// or never matched one to begin with.
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
    // never treats two NULLs as colliding in a unique index, so a class that
    // truly always leaves the other column NULL can never spuriously conflict
    // on it. That does NOT cover orphan_blob: gc.ts fills fileId in for every
    // blob whose on-disk name carries a uuid prefix, which is the normal
    // case, not the NULL one — so two orphan blobs that share a file id under
    // different paths satisfy this index and collide on class_file_key. See
    // upsertAnomaly in gc.ts for how that collision is arbitrated.
    uniqueIndex('storage_anomalies_class_path_key').on(t.class, t.path),
    uniqueIndex('storage_anomalies_class_file_key').on(t.class, t.fileId),
  ],
)

// --- ideas ----------------------------------------------------------------------

// A per-project kanban board. Dropping a card into 'selected_for_development'
// is what a background sweep watches for to start a handoff; every other
// status is either not yet ready for that (backlog, todo) or already past it
// (in_progress_dev, verification, done).
export const ideaStatusEnum = pgEnum('idea_status', [
  'backlog',
  'todo',
  'selected_for_development',
  'in_progress_dev',
  'verification',
  'done',
])

export const ideas = pgTable(
  'ideas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: ideaStatusEnum('status').notNull().default('backlog'),
    // Where this card sits within its column — board placement, nothing to do
    // with block reading order (see idea_blocks.seq below). A plain float so
    // a drag lands between its new neighbours at their midpoint, and moving
    // one card never has to renumber the rest of the column.
    boardPosition: doublePrecision('board_position').notNull(),
    // Set at handoff, when the idea is picked off 'selected_for_development'
    // and a session is created for it; null before that. ON DELETE SET NULL:
    // deleting the session must not delete the idea — the card keeps its
    // history (its runs, prompts, comments) even once the session backing it
    // is gone.
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    // These three mirror what createSession accepts, because the session is
    // created lazily at handoff rather than when the idea is — they have to
    // be chosen up front, on the card, before there is a session to hold them.
    orchestrator: text('orchestrator'),
    baseBranch: text('base_branch'),
    maxBudgetUsd: integer('max_budget_usd'),
    // Next seq to hand out for this idea's blocks. Modelled deliberately on
    // sessions.nextSeq above, for the identical reason: kept on the row so an
    // insert can allocate without a max(seq) scan, and so a failed insert
    // never leaves a gap that a reader would mistake for a missing block.
    nextSeq: integer('next_seq').notNull().default(0),
    // Why a handoff could not proceed (prompt generation failed, no session
    // could be created, ...) — surfaced on the card so the user knows why it
    // is stuck rather than it silently not advancing.
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ideas_project_idx').on(t.projectId),
    // The board's only read shape: every idea for a project, grouped by
    // column and ordered within it.
    index('ideas_project_status_idx').on(t.projectId, t.status, t.boardPosition),
  ],
)

// A container the user drops blocks into on the canvas; it becomes a heading
// when the canvas is serialized into a prompt.
export const ideaGroups = pgTable(
  'idea_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    title: text('title').notNull(),
    x: doublePrecision('x').notNull().default(0),
    y: doublePrecision('y').notNull().default(0),
    w: doublePrecision('w'),
    h: doublePrecision('h'),
  },
  (t) => [index('idea_groups_idea_idx').on(t.ideaId)],
)

export const ideaBlockKindEnum = pgEnum('idea_block_kind', [
  'note',
  'requirement',
  'example',
  'link',
  'image',
])

// `seq` is reading order, and is what the prompt serializer sorts by; `x`/`y`
// are presentation only, and the serializer never sees them. A single column
// cannot be both a place on a plane and a place in a sequence — if it tried,
// nudging a card four pixels would silently reorder the generated prompt.
export const ideaBlocks = pgTable(
  'idea_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    // ON DELETE SET NULL: deleting a group must not delete the blocks it
    // contains — they fall back to ungrouped rather than disappearing.
    groupId: uuid('group_id').references(() => ideaGroups.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    kind: ideaBlockKindEnum('kind').notNull(),
    body: text('body').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    x: doublePrecision('x').notNull().default(0),
    y: doublePrecision('y').notNull().default(0),
    w: doublePrecision('w'),
    h: doublePrecision('h'),
  },
  (t) => [
    // Mirrors messages_session_seq_key above: one reading-order slot per idea.
    uniqueIndex('idea_blocks_idea_seq_key').on(t.ideaId, t.seq),
    index('idea_blocks_idea_idx').on(t.ideaId),
  ],
)

export const ideaComments = pgTable(
  'idea_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when a follow-up prompt has folded this comment in — stamped at
    // enqueue time, in the same transaction that computes that prompt's
    // digest, so a comment can never be folded-in-but-unmarked or
    // marked-but-unfolded.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('idea_comments_idea_idx').on(t.ideaId)],
)

export const ideaPromptKindEnum = pgEnum('idea_prompt_kind', ['initial', 'followup'])

export const ideaPromptStatusEnum = pgEnum('idea_prompt_status', ['pending', 'ready', 'failed'])

export const ideaPrompts = pgTable(
  'idea_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    kind: ideaPromptKindEnum('kind').notNull(),
    // The exact deterministic serialization of the canvas the model was
    // given — stored so a regeneration is reproducible, and so the worker
    // never has to re-read the canvas to know what a past prompt was built
    // from.
    sourceDigest: text('source_digest').notNull(),
    generatedTitle: text('generated_title'),
    generatedText: text('generated_text'),
    // Decisions the generator made on the user's behalf. Agents in this
    // system cannot stop mid-turn to ask, so whatever the canvas left
    // underspecified gets recorded here instead of silently guessed.
    assumptions: jsonb('assumptions').$type<string[]>(),
    model: text('model'),
    costUsd: doublePrecision('cost_usd'),
    status: ideaPromptStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('idea_prompts_idea_idx').on(t.ideaId)],
)

export const ideaRunStatusEnum = pgEnum('idea_run_status', [
  'generating',
  'dispatching',
  'running',
  'closed',
])

export const ideaRunOutcomeEnum = pgEnum('idea_run_outcome', [
  'finished',
  'needs_attention',
  'interrupted',
  'superseded',
  'session_deleted',
])

// One row per handoff of an idea into a session — the durable record that
// answers "has the work for this idea stopped, and how".
export const ideaRuns = pgTable(
  'idea_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    promptId: uuid('prompt_id').references(() => ideaPrompts.id, { onDelete: 'set null' }),
    // messages cascade-deletes with its session, so cascading here too would
    // erase this attribution record whenever a session is deleted — the same
    // reasoning already written on message_files.fileId above.
    promptMessageId: uuid('prompt_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    kind: ideaPromptKindEnum('kind').notNull(),
    status: ideaRunStatusEnum('status').notNull().default('generating'),
    outcome: ideaRunOutcomeEnum('outcome'),
    detail: text('detail'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('idea_runs_idea_idx').on(t.ideaId),
    index('idea_runs_session_idx').on(t.sessionId),
    // Makes two concurrent handoffs of one idea impossible in the database,
    // rather than in a check-then-insert race: at most one row per idea may
    // have a null endedAt at a time. The same pattern as
    // session_files_session_checksum_key and message_files_message_file_key
    // above — a partial unique index encoding "only while this is still the
    // live one".
    uniqueIndex('idea_runs_open_key').on(t.ideaId).where(sql`${t.endedAt} is null`),
  ],
)

// Idea-owned uploaded assets — structurally a mirror of session_files above;
// read its comments first, since the same reasoning applies field for field
// with ideaId standing in for sessionId. Deliberately no announcedSeq:
// announcement is a session concept, and an idea's files are copied into the
// session created at handoff and announced from there, not from this table.
export const ideaFiles = pgTable(
  'idea_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    originalFilename: text('original_filename').notNull(),
    storedName: text('stored_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),
    // Reuses session_file_status rather than a near-identical second enum:
    // the three states mean exactly the same thing here, and a duplicate
    // enum would just be two vocabularies for one concept.
    status: sessionFileStatusEnum('status').notNull().default('ready'),
    lineCount: integer('line_count'),
    pageCount: integer('page_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idea_files_idea_idx').on(t.ideaId),
    // Mirrors session_files_session_checksum_key above.
    uniqueIndex('idea_files_idea_checksum_key')
      .on(t.ideaId, t.checksum)
      .where(sql`${t.deletedAt} is null`),
  ],
)

// --- relations ----------------------------------------------------------------

export const projectsRelations = relations(projects, ({ one, many }) => ({
  sessions: many(sessions),
  libraryItems: many(projectLibraryItems),
  sshKey: one(sshKeys, { fields: [projects.sshKeyId], references: [sshKeys.id] }),
  ideas: many(ideas),
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
  ideas: many(ideas),
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

export const ideasRelations = relations(ideas, ({ one, many }) => ({
  project: one(projects, { fields: [ideas.projectId], references: [projects.id] }),
  session: one(sessions, { fields: [ideas.sessionId], references: [sessions.id] }),
  groups: many(ideaGroups),
  blocks: many(ideaBlocks),
  comments: many(ideaComments),
  prompts: many(ideaPrompts),
  runs: many(ideaRuns),
  files: many(ideaFiles),
}))

export const ideaGroupsRelations = relations(ideaGroups, ({ one, many }) => ({
  idea: one(ideas, { fields: [ideaGroups.ideaId], references: [ideas.id] }),
  blocks: many(ideaBlocks),
}))

export const ideaBlocksRelations = relations(ideaBlocks, ({ one }) => ({
  idea: one(ideas, { fields: [ideaBlocks.ideaId], references: [ideas.id] }),
  group: one(ideaGroups, { fields: [ideaBlocks.groupId], references: [ideaGroups.id] }),
}))

export const ideaCommentsRelations = relations(ideaComments, ({ one }) => ({
  idea: one(ideas, { fields: [ideaComments.ideaId], references: [ideas.id] }),
}))

export const ideaPromptsRelations = relations(ideaPrompts, ({ one, many }) => ({
  idea: one(ideas, { fields: [ideaPrompts.ideaId], references: [ideas.id] }),
  runs: many(ideaRuns),
}))

export const ideaRunsRelations = relations(ideaRuns, ({ one }) => ({
  idea: one(ideas, { fields: [ideaRuns.ideaId], references: [ideas.id] }),
  session: one(sessions, { fields: [ideaRuns.sessionId], references: [sessions.id] }),
  prompt: one(ideaPrompts, { fields: [ideaRuns.promptId], references: [ideaPrompts.id] }),
  promptMessage: one(messages, { fields: [ideaRuns.promptMessageId], references: [messages.id] }),
}))

export const ideaFilesRelations = relations(ideaFiles, ({ one }) => ({
  idea: one(ideas, { fields: [ideaFiles.ideaId], references: [ideas.id] }),
}))
