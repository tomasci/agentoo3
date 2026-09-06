ALTER TABLE "message_files" DROP CONSTRAINT "message_files_file_id_session_files_id_fk";
--> statement-breakpoint
ALTER TABLE "message_files" DROP CONSTRAINT "message_files_message_id_file_id_pk";--> statement-breakpoint
ALTER TABLE "message_files" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_files" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "message_files" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_file_id_session_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."session_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_files_message_idx" ON "message_files" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_files_message_file_key" ON "message_files" USING btree ("message_id","file_id") WHERE "message_files"."file_id" is not null;