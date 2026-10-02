ALTER TABLE "learning_runs" ADD COLUMN "enqueue_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_runs" ADD COLUMN "enqueued_at" timestamp with time zone;