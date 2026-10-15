-- Indexes behind ON DELETE foreign keys that had none, so a cascade from one
-- deleted parent row is an index probe rather than a scan of the whole child
-- table. Without messages_continues_message_idx, deleting a project of ~170k
-- messages took 3h45m.
--
-- IF NOT EXISTS, as 0015 is all CREATE OR REPLACE: this migration has to be
-- safe to run again over a database that already has some of it. See 0015's
-- header ("Re-running") for the restore that does that.
CREATE INDEX IF NOT EXISTS "automation_runs_prompt_message_idx" ON "automation_runs" USING btree ("prompt_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_blocks_group_idx" ON "idea_blocks" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_runs_prompt_idx" ON "idea_runs" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_runs_prompt_message_idx" ON "idea_runs" USING btree ("prompt_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ideas_session_idx" ON "ideas" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_files_file_idx" ON "message_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_continues_message_idx" ON "messages" USING btree ("continues_message_id") WHERE "messages"."continues_message_id" is not null;