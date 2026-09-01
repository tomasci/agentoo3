ALTER TYPE "public"."project_source" ADD VALUE 'empty';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_name" text;