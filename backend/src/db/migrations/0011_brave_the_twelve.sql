CREATE TYPE "public"."learning_run_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."learning_run_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."library_suggestion_action" AS ENUM('create', 'modify');--> statement-breakpoint
CREATE TYPE "public"."library_suggestion_status" AS ENUM('pending', 'applied', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."library_version_source" AS ENUM('snapshot', 'suggestion');--> statement-breakpoint
CREATE TABLE "learning_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" "learning_run_trigger" NOT NULL,
	"status" "learning_run_status" DEFAULT 'queued' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"sessions_analyzed" integer DEFAULT 0 NOT NULL,
	"suggestions_created" integer DEFAULT 0 NOT NULL,
	"duplicates_skipped" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"error" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "library_kind" NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"markdown" text NOT NULL,
	"source" "library_version_source" NOT NULL,
	"suggestion_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"kind" "library_kind" NOT NULL,
	"action" "library_suggestion_action" NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"source_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed" jsonb NOT NULL,
	"base_markdown" text,
	"status" "library_suggestion_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"applied_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_item_versions" ADD CONSTRAINT "library_item_versions_suggestion_id_library_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."library_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_suggestions" ADD CONSTRAINT "library_suggestions_run_id_learning_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."learning_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_runs_single_active_key" ON "learning_runs" USING btree ((true)) WHERE "learning_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "learning_runs_status_idx" ON "learning_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "library_item_versions_key" ON "library_item_versions" USING btree ("kind","name","version");--> statement-breakpoint
CREATE INDEX "library_item_versions_name_idx" ON "library_item_versions" USING btree ("kind","name");--> statement-breakpoint
CREATE INDEX "library_suggestions_status_idx" ON "library_suggestions" USING btree ("status");