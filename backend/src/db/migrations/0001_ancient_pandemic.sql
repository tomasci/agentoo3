CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"comment" text,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"private_key_path" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_host" text,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ssh_key_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_name_key" ON "ssh_keys" USING btree ("name");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE set null ON UPDATE no action;