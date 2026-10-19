CREATE TYPE "public"."session_compaction_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "session_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_session_id" uuid NOT NULL,
	"status" "session_compaction_status" DEFAULT 'pending' NOT NULL,
	"method" text,
	"result_session_id" uuid,
	"error" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_compactions" ADD CONSTRAINT "session_compactions_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_compactions" ADD CONSTRAINT "session_compactions_result_session_id_sessions_id_fk" FOREIGN KEY ("result_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_compactions_active_key" ON "session_compactions" USING btree ("source_session_id") WHERE "session_compactions"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "session_compactions_source_idx" ON "session_compactions" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "session_compactions_result_idx" ON "session_compactions" USING btree ("result_session_id");