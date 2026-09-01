ALTER TABLE "messages" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "total_cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "next_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- next_seq hands out transcript positions, so it must start past anything that
-- is already there. The default of 0 would collide on the first insert for any
-- session that already has messages.
UPDATE "sessions" SET "next_seq" = COALESCE(
  (SELECT MAX("seq") + 1 FROM "messages" WHERE "messages"."session_id" = "sessions"."id"), 0
);
