-- Loupe: sharing and finals. Adds three tables; changes nothing that exists.
--
-- loupe_share_links: a scene's secret watch link (one working link per scene; turned off, it stops for good).
-- loupe_share_notes: notes viewers leave on a link, pinned to moments; they go to the scene's people, not to Loupe.
-- loupe_finals: full-resolution final files of a cut (from the camera originals, or made 4K with Topaz).
-- Row-level security is on for all three; only loupe_app can use them, and Supabase's public API can't.
-- It all runs as one transaction: if any statement fails, nothing changes.

CREATE TABLE "loupe_finals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_finals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"cut_id" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"progress" real,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"error" text,
	"storage_key" text,
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loupe_finals_kind_valid" CHECK ("loupe_finals"."kind" in ('original', 'topaz')),
	CONSTRAINT "loupe_finals_status_valid" CHECK ("loupe_finals"."status" in ('waiting', 'working', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "loupe_finals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loupe_share_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_share_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"token" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"turned_off_at" timestamp with time zone,
	"turned_off_by" text,
	CONSTRAINT "loupe_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "loupe_share_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loupe_share_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_share_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"link_id" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"cut_id" bigint,
	"name" text NOT NULL,
	"at" real NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "loupe_share_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loupe_finals" ADD CONSTRAINT "loupe_finals_cut_id_loupe_cuts_id_fk" FOREIGN KEY ("cut_id") REFERENCES "public"."loupe_cuts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_finals" ADD CONSTRAINT "loupe_finals_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_share_links" ADD CONSTRAINT "loupe_share_links_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_share_notes" ADD CONSTRAINT "loupe_share_notes_link_id_loupe_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."loupe_share_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_share_notes" ADD CONSTRAINT "loupe_share_notes_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_share_notes" ADD CONSTRAINT "loupe_share_notes_cut_id_loupe_cuts_id_fk" FOREIGN KEY ("cut_id") REFERENCES "public"."loupe_cuts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loupe_finals_cut_idx" ON "loupe_finals" USING btree ("cut_id","kind");--> statement-breakpoint
CREATE INDEX "loupe_finals_queue_idx" ON "loupe_finals" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loupe_finals_one_at_a_time_idx" ON "loupe_finals" USING btree ("cut_id","kind") WHERE "loupe_finals"."status" in ('waiting', 'working');--> statement-breakpoint
CREATE UNIQUE INDEX "loupe_share_links_one_per_scene_idx" ON "loupe_share_links" USING btree ("project_id") WHERE "loupe_share_links"."turned_off_at" is null;--> statement-breakpoint
CREATE INDEX "loupe_share_notes_project_idx" ON "loupe_share_notes" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "loupe_share_notes_link_idx" ON "loupe_share_notes" USING btree ("link_id");--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_finals" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_share_links" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_share_notes" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);--> statement-breakpoint
-- The app and worker only read and write rows in these tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "loupe_share_links", "loupe_share_notes", "loupe_finals" TO "loupe_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "loupe_share_links_id_seq", "loupe_share_notes_id_seq", "loupe_finals_id_seq" TO "loupe_app";--> statement-breakpoint
-- No access through Supabase's public API, even if row-level security were ever switched off.
REVOKE ALL ON "loupe_share_links", "loupe_share_notes", "loupe_finals" FROM "anon", "authenticated";
