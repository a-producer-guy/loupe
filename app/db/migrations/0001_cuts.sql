-- Loupe stage 2: scripts and cuts. Adds two tables; changes nothing that exists.
--
-- loupe_scripts: each account's scene scripts (Final Draft or PDF), read into lines.
-- loupe_cuts: every version of a scene's cut, with its notes, progress and result.
-- Row-level security is on for both; only loupe_app can use them, and Supabase's public API can't.
-- It all runs as one transaction: if any statement fails, nothing changes.

CREATE TABLE "loupe_cuts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_cuts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"script_id" bigint,
	"lead_role" text,
	"coverage" jsonb,
	"direction" jsonb,
	"status" text DEFAULT 'waiting' NOT NULL,
	"step" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loupe_cuts_status_valid" CHECK ("loupe_cuts"."status" in ('waiting', 'working', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "loupe_cuts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loupe_scripts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_scripts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"project_id" bigint,
	"title" text NOT NULL,
	"roles" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"heading" text,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loupe_scripts_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "loupe_scripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loupe_cuts" ADD CONSTRAINT "loupe_cuts_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_cuts" ADD CONSTRAINT "loupe_cuts_script_id_loupe_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."loupe_scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_scripts" ADD CONSTRAINT "loupe_scripts_account_id_loupe_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loupe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_scripts" ADD CONSTRAINT "loupe_scripts_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loupe_cuts_project_idx" ON "loupe_cuts" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "loupe_cuts_queue_idx" ON "loupe_cuts" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loupe_cuts_one_at_a_time_idx" ON "loupe_cuts" USING btree ("project_id") WHERE "loupe_cuts"."status" in ('waiting', 'working');--> statement-breakpoint
CREATE INDEX "loupe_scripts_account_idx" ON "loupe_scripts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "loupe_scripts_project_idx" ON "loupe_scripts" USING btree ("project_id");--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_cuts" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_scripts" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);--> statement-breakpoint
-- The app and worker only read and write rows in these tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "loupe_scripts", "loupe_cuts" TO "loupe_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "loupe_scripts_id_seq", "loupe_cuts_id_seq" TO "loupe_app";--> statement-breakpoint
-- No access through Supabase's public API, even if row-level security were ever switched off.
REVOKE ALL ON "loupe_scripts", "loupe_cuts" FROM "anon", "authenticated";
