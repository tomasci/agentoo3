CREATE TYPE "public"."session_file_status" AS ENUM('ready', 'missing', 'unreadable');--> statement-breakpoint
CREATE TYPE "public"."storage_anomaly_class" AS ENUM('orphan_blob', 'dangling_row', 'orphan_session_dir', 'checksum_mismatch');--> statement-breakpoint
CREATE TABLE "message_files" (
	"message_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "message_files_message_id_file_id_pk" PRIMARY KEY("message_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "session_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"stored_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"status" "session_file_status" DEFAULT 'ready' NOT NULL,
	"line_count" integer,
	"page_count" integer,
	"announced_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "storage_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class" "storage_anomaly_class" NOT NULL,
	"session_id" uuid,
	"file_id" uuid,
	"path" text,
	"original_filename" text,
	"size_bytes" bigint,
	"detail" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_file_id_session_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."session_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_files" ADD CONSTRAINT "session_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_files_session_idx" ON "session_files" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_files_session_checksum_key" ON "session_files" USING btree ("session_id","checksum") WHERE "session_files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "storage_anomalies_class_idx" ON "storage_anomalies" USING btree ("class");--> statement-breakpoint
CREATE INDEX "storage_anomalies_session_idx" ON "storage_anomalies" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_anomalies_class_path_key" ON "storage_anomalies" USING btree ("class","path");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_anomalies_class_file_key" ON "storage_anomalies" USING btree ("class","file_id");