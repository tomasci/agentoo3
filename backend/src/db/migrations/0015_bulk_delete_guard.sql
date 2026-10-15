-- Bulk-delete guard on projects, sessions, messages, session_files, ideas and
-- automations.
--
-- Why: one unscoped `DELETE FROM projects`, sent by a proof-of-concept script
-- that had inherited the production DATABASE_URL, deleted every project, and
-- ON DELETE CASCADE took every session, message, idea and automation with it.
-- The app never deletes rows of more than one parent per statement: every
-- delete in backend/src is one row by primary key (deleteProject,
-- deleteSession, deleteIdea, deleteAutomation, the attachments cleanup's
-- session_files delete), and messages are only ever deleted by cascade. So a
-- statement that deletes more than that is a mistake, and this refuses it.
--
-- What is refused, unless an escape hatch below is on:
--   projects       one statement deleting more than one project.
--   sessions,      one statement deleting rows of more than one project_id.
--   ideas,         Deleting one project cascades into each of these as one
--   automations    statement over that single project_id, so deleteProject
--                  stays allowed.
--   messages,      one statement deleting rows of more than one session that
--   session_files  still exists once the statement is done. Not simply "more
--                  than one session_id": Postgres gathers every row a
--                  statement's FK cascades delete from a table into one
--                  transition table and fires the statement trigger once, so
--                  deleting one project with several sessions shows these
--                  triggers rows of all of them. Those sessions are gone by
--                  then, though, and a session whose rows were deleted
--                  directly is still there, which is what tells the two
--                  apart. session_files matters beyond its own rows: the
--                  hourly attachments check deletes blobs no row claims once
--                  they are a day old (ATTACHMENTS_GC_GRACE_MS), so wiping
--                  the table would take users' uploads off disk too.
--   TRUNCATE       of any of the six, CASCADE or not.
--
-- The DELETE checks are AFTER ... FOR EACH STATEMENT triggers over the
-- statement's OLD TABLE, so a refused statement rolls back whole: nothing is
-- deleted. (tests/bulk-delete-guard.test.ts checks every case above.)
--
-- ESCAPE HATCHES. These are the only two ways past the guard:
--
--   1. agentoo.allow_bulk_delete = 'on', read with current_setting(), the
--      deliberate operator action. Use it one transaction at a time:
--
--        BEGIN;
--        SET LOCAL agentoo.allow_bulk_delete = 'on';
--        DELETE FROM projects WHERE ...;
--        COMMIT;
--
--      SET LOCAL ends with that transaction, committed or not, so the next one
--      is guarded again. Because it is read with current_setting(), every
--      other way of setting it works too, and lasts longer: a plain SET (no
--      LOCAL) holds for the rest of the connection, which on a pooled
--      connection (the app's own postgres.js pool, a pgbouncer) means for
--      whatever runs on it next, until RESET or disconnect; a startup
--      parameter (`?agentoo.allow_bulk_delete=on` in a URL, PGOPTIONS) holds
--      for the whole connection; an ALTER ROLE or ALTER DATABASE ... SET of
--      it (superuser only) for every connection after. Use SET LOCAL. Keep
--      the name: operator scripts, the recovery rollback among them, set
--      exactly this one.
--
--   2. The disposable-test marker: a DATABASE-level default,
--        ALTER DATABASE <db> SET agentoo.disposable_test_db = 'on'
--      i.e. a pg_db_role_setting row for current_database() with setrole = 0
--      (not for one role) holding agentoo.disposable_test_db=on. The triggers
--      read that row from the catalog, never current_setting(), so nothing a
--      connection carries counts, in either direction: SET, SET LOCAL, a
--      startup parameter or ALTER ROLE ... SET of it can neither turn the
--      guard off on a real database nor back on in a marked one. Postgres
--      lets only a superuser put an unregistered parameter on a database,
--      unless one GRANTs SET ON PARAMETER (production's app role, which owns
--      the database, gets "permission denied"), and the change takes effect
--      at once, for open connections too.
--      backend/tests/pg-cluster.ts sets it on its throwaway clusters after
--      migrating, so the suite's resets keep working there; a test that needs
--      the guard live uses a database not marked 'on' (pg-cluster.ts's
--      guarded database, marked 'guarded', a value only the test suite's own
--      safety check reads). Never set it on a real database.
--
--   Each statement trigger checks the hatches once per firing, not per row,
--   before it reads the transition table at all: one current_setting() and,
--   only when that is not 'on', one catalog query for this database's own
--   pg_db_role_setting row. A statement fires each table's trigger once,
--   however many rows or cascades it touches.
--
-- Re-running: everything here is CREATE OR REPLACE, so this file can run
-- again over a database that already has the functions. That happens when a
-- dump taken before 0014 and 0015 (they ship together) is restored with
-- `pg_restore --clean --if-exists` over a database that has them: --clean
-- drops the tables, and with them these triggers and 0014's indexes, and the
-- dump re-creates the tables without either, but it leaves these functions,
-- which the dump does not know about; drizzle's migrations table comes back
-- from the dump saying 0013, so the next `db:migrate` runs 0014 and 0015
-- again (tests/migrate-after-restore.test.ts).
--
-- Everything here works for the non-superuser role that owns the tables and
-- runs `bun run db:migrate` in production: plpgsql is a trusted language,
-- pg_db_role_setting is readable by every role, and only a table's owner
-- needs to be able to put triggers on it.

CREATE OR REPLACE FUNCTION public.agentoo_bulk_delete_allowed() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(current_setting('agentoo.allow_bulk_delete', true), '') = 'on'
      OR EXISTS (
           SELECT 1
           FROM pg_catalog.pg_db_role_setting AS s
           WHERE s.setrole = 0
             AND s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database AS d
                                  WHERE d.datname = pg_catalog.current_database())
             AND 'agentoo.disposable_test_db=on' = ANY (s.setconfig)
         )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.agentoo_guard_projects_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deleted bigint;
BEGIN
  IF public.agentoo_bulk_delete_allowed() THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO deleted FROM old_rows;
  IF deleted > 1 THEN
    RAISE EXCEPTION 'bulk-delete guard: refusing to delete % projects in one statement', deleted
      USING DETAIL = 'Deleting a project cascades to its sessions, messages, files, ideas and automations, so one statement may delete at most one project.',
            HINT = 'Delete projects one at a time by id. For a deliberate bulk delete, run it in a transaction after SET LOCAL agentoo.allow_bulk_delete = ''on''.';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- sessions, ideas and automations: rows of at most one project per statement.
CREATE OR REPLACE FUNCTION public.agentoo_guard_delete_per_project() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parents bigint;
BEGIN
  IF public.agentoo_bulk_delete_allowed() THEN
    RETURN NULL;
  END IF;
  SELECT count(DISTINCT project_id) INTO parents FROM old_rows;
  IF parents > 1 THEN
    RAISE EXCEPTION 'bulk-delete guard: refusing to delete % of % projects in one statement', TG_TABLE_NAME, parents
      USING DETAIL = format('The app deletes %s one row at a time, or one project''s worth by deleting that project, so one statement may delete %s of at most one project.', TG_TABLE_NAME, TG_TABLE_NAME),
            HINT = 'Scope the delete to one project_id, or one row by id. For a deliberate bulk delete, run it in a transaction after SET LOCAL agentoo.allow_bulk_delete = ''on''.';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- messages and session_files: rows of at most one still-existing session per
-- statement. See the header for why only sessions that still exist count.
CREATE OR REPLACE FUNCTION public.agentoo_guard_delete_per_session() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parents bigint;
BEGIN
  IF public.agentoo_bulk_delete_allowed() THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO parents
  FROM (SELECT DISTINCT session_id FROM old_rows) AS d
  WHERE EXISTS (SELECT 1 FROM public.sessions AS s WHERE s.id = d.session_id);
  IF parents > 1 THEN
    RAISE EXCEPTION 'bulk-delete guard: refusing to delete % of % sessions in one statement', TG_TABLE_NAME, parents
      USING DETAIL = format('One statement may delete %s of at most one session, other than by deleting the sessions themselves.', TG_TABLE_NAME),
            HINT = 'Scope the delete to one session_id, or one row by id. For a deliberate bulk delete, run it in a transaction after SET LOCAL agentoo.allow_bulk_delete = ''on''.';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.agentoo_guard_truncate() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.agentoo_bulk_delete_allowed() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'bulk-delete guard: refusing to TRUNCATE %', TG_TABLE_NAME
    USING HINT = 'For a deliberate wipe, run it in a transaction after SET LOCAL agentoo.allow_bulk_delete = ''on''.';
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER projects_bulk_delete_guard
  AFTER DELETE ON public.projects
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_projects_delete();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER sessions_bulk_delete_guard
  AFTER DELETE ON public.sessions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_delete_per_project();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER ideas_bulk_delete_guard
  AFTER DELETE ON public.ideas
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_delete_per_project();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER automations_bulk_delete_guard
  AFTER DELETE ON public.automations
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_delete_per_project();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER messages_bulk_delete_guard
  AFTER DELETE ON public.messages
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_delete_per_session();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER session_files_bulk_delete_guard
  AFTER DELETE ON public.session_files
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_delete_per_session();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER projects_truncate_guard
  BEFORE TRUNCATE ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_truncate();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER sessions_truncate_guard
  BEFORE TRUNCATE ON public.sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_truncate();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER ideas_truncate_guard
  BEFORE TRUNCATE ON public.ideas
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_truncate();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER automations_truncate_guard
  BEFORE TRUNCATE ON public.automations
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_truncate();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER messages_truncate_guard
  BEFORE TRUNCATE ON public.messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_truncate();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER session_files_truncate_guard
  BEFORE TRUNCATE ON public.session_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.agentoo_guard_truncate();
