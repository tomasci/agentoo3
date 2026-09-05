import { relations } from 'drizzle-orm'
import {
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
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
}))
