import { relations } from 'drizzle-orm'
import {
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

// A project is either cloned from a remote or adopted from a directory that
// already exists on disk. Both end up as one directory under PROJECTS_DIR.
export const projectSourceEnum = pgEnum('project_source', ['clone', 'existing'])

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
    // Null for 'existing' projects that have no remote configured.
    remoteUrl: text('remote_url'),
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

    // The Agent SDK's own session id, needed to resume after a worker restart.
    sdkSessionId: text('sdk_session_id'),

    // Caps for this session, passed through to the SDK.
    maxBudgetUsd: integer('max_budget_usd'),
    lastError: text('last_error'),

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
    // SDK message type: 'assistant' | 'user' | 'system' | 'result' | ...
    type: text('type').notNull(),
    // Set when the message came from inside a subagent's context.
    parentToolUseId: text('parent_tool_use_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('messages_session_seq_key').on(t.sessionId, t.seq)],
)

// --- relations ----------------------------------------------------------------

export const projectsRelations = relations(projects, ({ many }) => ({
  sessions: many(sessions),
  libraryItems: many(projectLibraryItems),
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
