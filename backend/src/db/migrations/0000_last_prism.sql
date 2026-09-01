CREATE TYPE "public"."library_kind" AS ENUM('agent', 'skill');--> statement-breakpoint
CREATE TYPE "public"."project_source" AS ENUM('clone', 'existing');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('pending', 'cloning', 'ready', 'needs_manual', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('idle', 'queued', 'running', 'interrupted', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"parent_tool_use_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "library_kind" NOT NULL,
	"name" text NOT NULL,
	"overrides" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"source" "project_source" NOT NULL,
	"remote_url" text,
	"default_branch" text,
	"status" "project_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"recovery_commands" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text,
	"status" "session_status" DEFAULT 'idle' NOT NULL,
	"orchestrator" text,
	"worktree_path" text,
	"branch" text,
	"sdk_session_id" text,
	"max_budget_usd" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_library_items" ADD CONSTRAINT "project_library_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_session_seq_key" ON "messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "project_library_items_key" ON "project_library_items" USING btree ("project_id","kind","name");--> statement-breakpoint
CREATE INDEX "project_library_items_project_idx" ON "project_library_items" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_project_idx" ON "sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");