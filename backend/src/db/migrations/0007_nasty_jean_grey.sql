CREATE TYPE "public"."idea_block_kind" AS ENUM('note', 'requirement', 'example', 'link', 'image');--> statement-breakpoint
CREATE TYPE "public"."idea_prompt_kind" AS ENUM('initial', 'followup');--> statement-breakpoint
CREATE TYPE "public"."idea_prompt_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."idea_run_outcome" AS ENUM('finished', 'needs_attention', 'interrupted', 'superseded', 'session_deleted');--> statement-breakpoint
CREATE TYPE "public"."idea_run_status" AS ENUM('generating', 'dispatching', 'running', 'closed');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('backlog', 'todo', 'selected_for_development', 'in_progress_dev', 'verification', 'done');--> statement-breakpoint
CREATE TYPE "public"."turn_outcome" AS ENUM('completed', 'stopped_turn_limit', 'stopped_api_error', 'stopped_execution_error', 'stopped_over_budget', 'failed', 'stalled', 'continuing', 'drained', 'interrupted', 'unknown', 'abandoned', 'stranded');--> statement-breakpoint
ALTER TYPE "public"."storage_anomaly_class" ADD VALUE 'orphan_idea_dir';--> statement-breakpoint
ALTER TYPE "public"."storage_anomaly_class" ADD VALUE 'idea_dangling_row';--> statement-breakpoint
ALTER TYPE "public"."storage_anomaly_class" ADD VALUE 'idea_checksum_mismatch';--> statement-breakpoint
CREATE TABLE "idea_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"group_id" uuid,
	"seq" integer NOT NULL,
	"kind" "idea_block_kind" NOT NULL,
	"body" text NOT NULL,
	"meta" jsonb,
	"x" double precision DEFAULT 0 NOT NULL,
	"y" double precision DEFAULT 0 NOT NULL,
	"w" double precision,
	"h" double precision
);
--> statement-breakpoint
CREATE TABLE "idea_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idea_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"stored_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"status" "session_file_status" DEFAULT 'ready' NOT NULL,
	"line_count" integer,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idea_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"x" double precision DEFAULT 0 NOT NULL,
	"y" double precision DEFAULT 0 NOT NULL,
	"w" double precision,
	"h" double precision
);
--> statement-breakpoint
CREATE TABLE "idea_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"kind" "idea_prompt_kind" NOT NULL,
	"source_digest" text NOT NULL,
	"generated_title" text,
	"generated_text" text,
	"assumptions" jsonb,
	"model" text,
	"cost_usd" double precision,
	"status" "idea_prompt_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idea_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"session_id" uuid,
	"prompt_id" uuid,
	"prompt_message_id" uuid,
	"kind" "idea_prompt_kind" NOT NULL,
	"status" "idea_run_status" DEFAULT 'generating' NOT NULL,
	"outcome" "idea_run_outcome",
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "idea_status" DEFAULT 'backlog' NOT NULL,
	"board_position" double precision NOT NULL,
	"session_id" uuid,
	"orchestrator" text,
	"base_branch" text,
	"max_budget_usd" integer,
	"next_seq" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "turn_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "turn_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "turn_outcome" "turn_outcome";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "turn_detail" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "continues_message_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "idea_blocks" ADD CONSTRAINT "idea_blocks_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_blocks" ADD CONSTRAINT "idea_blocks_group_id_idea_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."idea_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_files" ADD CONSTRAINT "idea_files_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_prompts" ADD CONSTRAINT "idea_prompts_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_runs" ADD CONSTRAINT "idea_runs_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_runs" ADD CONSTRAINT "idea_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_runs" ADD CONSTRAINT "idea_runs_prompt_id_idea_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."idea_prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_runs" ADD CONSTRAINT "idea_runs_prompt_message_id_messages_id_fk" FOREIGN KEY ("prompt_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idea_blocks_idea_seq_key" ON "idea_blocks" USING btree ("idea_id","seq");--> statement-breakpoint
CREATE INDEX "idea_blocks_idea_idx" ON "idea_blocks" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_comments_idea_idx" ON "idea_comments" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_files_idea_idx" ON "idea_files" USING btree ("idea_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_files_idea_checksum_key" ON "idea_files" USING btree ("idea_id","checksum") WHERE "idea_files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idea_groups_idea_idx" ON "idea_groups" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_prompts_idea_idx" ON "idea_prompts" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_runs_idea_idx" ON "idea_runs" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_runs_session_idx" ON "idea_runs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idea_runs_open_key" ON "idea_runs" USING btree ("idea_id") WHERE "idea_runs"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "ideas_project_idx" ON "ideas" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ideas_project_status_idx" ON "ideas" USING btree ("project_id","status","board_position");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_continues_message_id_messages_id_fk" FOREIGN KEY ("continues_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_turn_open_idx" ON "messages" USING btree ("session_id") WHERE "messages"."turn_started_at" is not null and "messages"."turn_ended_at" is null;--> statement-breakpoint
CREATE INDEX "messages_pending_idx" ON "messages" USING btree ("session_id") WHERE "messages"."pending";--> statement-breakpoint
CREATE INDEX "sessions_heartbeat_idx" ON "sessions" USING btree ("heartbeat_at") WHERE "sessions"."status" = 'running';