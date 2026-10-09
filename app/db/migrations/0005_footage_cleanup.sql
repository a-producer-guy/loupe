-- Loupe: the footage cleanup (approved by Guy, Oct 9). Adds one table and a few columns; changes one rule; deletes
-- nothing. Nothing is removed from storage by this change: the cleanup starts in report-only mode.
--
-- loupe_cleanups: what the cleanup did, or would do in report-only mode, scene by scene.
-- loupe_projects: Keep footage (off), the date a scene's camera files are kept until, when the 7-day and 3-day
--   warnings went out, and when the files were removed.
-- loupe_files: a file can now be "removed" (taken away by the cleanup; dropping the same card again re-uploads it).
--   The rule listing the allowed states is dropped and made again with "removed" added.
-- Row-level security is on for the new table; only loupe_app can use it, and Supabase's public API can't.
-- It all runs as one transaction: if any statement fails, nothing changes.

CREATE TABLE "loupe_cleanups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_cleanups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint,
	"action" text NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loupe_cleanups_action_valid" CHECK ("loupe_cleanups"."action" in ('warn', 'warn_3', 'remove', 'would_warn', 'would_warn_3', 'would_remove', 'odd_hidden'))
);
--> statement-breakpoint
ALTER TABLE "loupe_cleanups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loupe_files" DROP CONSTRAINT "loupe_files_status_valid";--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "keep_footage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "footage_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "footage_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "footage_warned_3_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "footage_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_cleanups" ADD CONSTRAINT "loupe_cleanups_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loupe_cleanups_created_idx" ON "loupe_cleanups" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "loupe_files" ADD CONSTRAINT "loupe_files_status_valid" CHECK ("loupe_files"."status" in ('pending', 'uploading', 'uploaded', 'unreadable', 'removed'));--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_cleanups" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);;--> statement-breakpoint
-- The app and worker read and write these rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON "loupe_cleanups" TO "loupe_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "loupe_cleanups_id_seq" TO "loupe_app";--> statement-breakpoint
-- No access through Supabase's public API, even if row-level security were ever switched off.
REVOKE ALL ON "loupe_cleanups" FROM "anon", "authenticated";
