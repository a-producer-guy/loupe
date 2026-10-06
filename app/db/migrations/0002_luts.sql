-- Reelarc Footage: LUTs baked into proxies.
--
-- Adds two new tables and three empty columns. Nothing existing is renamed,
-- dropped or rewritten, and no rows change.
--   footage_luts       the team's LUT files (the .cube files themselves live in B2)
--   footage_card_luts  a card filmed with a different LUT from the rest of its shoot
--   footage_projects.lut_id              the LUT a shoot was filmed with
--   footage_proxy_jobs.lut_id            the LUT a clip's proxy should have
--   footage_proxy_jobs.made_with_lut_id  the LUT its current proxy was made with
-- Like the other footage tables: row-level security on, only the footage_app
-- login may use them, Supabase's public roles get nothing.

CREATE TABLE "footage_card_luts" (
	"project_id" bigint NOT NULL,
	"card" text NOT NULL,
	"lut_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "footage_card_luts_project_id_card_pk" PRIMARY KEY("project_id","card")
);
--> statement-breakpoint
ALTER TABLE "footage_card_luts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "footage_luts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "footage_luts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"cube_size" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "footage_luts_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "footage_luts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "footage_projects" ADD COLUMN "lut_id" bigint;--> statement-breakpoint
ALTER TABLE "footage_proxy_jobs" ADD COLUMN "lut_id" bigint;--> statement-breakpoint
ALTER TABLE "footage_proxy_jobs" ADD COLUMN "made_with_lut_id" bigint;--> statement-breakpoint
ALTER TABLE "footage_card_luts" ADD CONSTRAINT "footage_card_luts_project_id_footage_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."footage_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_card_luts" ADD CONSTRAINT "footage_card_luts_lut_id_footage_luts_id_fk" FOREIGN KEY ("lut_id") REFERENCES "public"."footage_luts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_projects" ADD CONSTRAINT "footage_projects_lut_id_footage_luts_id_fk" FOREIGN KEY ("lut_id") REFERENCES "public"."footage_luts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_proxy_jobs" ADD CONSTRAINT "footage_proxy_jobs_lut_id_footage_luts_id_fk" FOREIGN KEY ("lut_id") REFERENCES "public"."footage_luts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "footage_app_all" ON "footage_card_luts" AS PERMISSIVE FOR ALL TO "footage_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "footage_app_all" ON "footage_luts" AS PERMISSIVE FOR ALL TO "footage_app" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "footage_luts", "footage_card_luts" TO "footage_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "footage_luts_id_seq" TO "footage_app";--> statement-breakpoint
REVOKE ALL ON "footage_luts", "footage_card_luts" FROM "anon", "authenticated";
