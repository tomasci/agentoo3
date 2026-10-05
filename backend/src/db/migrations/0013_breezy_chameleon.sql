CREATE TYPE "public"."automation_run_status" AS ENUM('dispatching', 'dispatched', 'failed');--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"session_id" uuid,
	"prompt_message_id" uuid,
	"scheduled_for" timestamp with time zone NOT NULL,
	"prompt" text NOT NULL,
	"status" "automation_run_status" DEFAULT 'dispatching' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"orchestrator" text NOT NULL,
	"base_branch" text,
	"max_budget_usd" integer,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_prompt_message_id_messages_id_fk" FOREIGN KEY ("prompt_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_runs_session_idx" ON "automation_runs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_occurrence_key" ON "automation_runs" USING btree ("automation_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "automations_project_idx" ON "automations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "automations" USING btree ("next_run_at") WHERE "automations"."paused" = false;