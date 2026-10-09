-- Loupe: payments, and the free-cutting fund. Adds two tables and a few empty columns; no data is changed or removed.
--
-- loupe_payments: every one-off payment through Stripe (a scene's export, or a cut made 4K with Topaz): how much,
--   Stripe's reference for it, and whether it's paid.
-- loupe_fund: the free-cutting fund. Every sale puts half of what it brings in; every free cut takes out the most it
--   can cost, and only starts if the fund holds that much. It starts with the $300 launch budget (the last line).
-- loupe_accounts: the account's Stripe customer, and its Pro or Studio subscription (status and current month).
-- loupe_projects: when a scene was unlocked for export, and how (a plan's scenes, or paid).
-- Row-level security is on for the new tables; only loupe_app can use them, and Supabase's public API can't.
-- It all runs as one transaction: if any statement fails, nothing changes.

CREATE TABLE "loupe_fund" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_fund_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"amount_cents" integer NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"account_id" bigint,
	"project_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loupe_fund_ref_unique" UNIQUE("ref"),
	CONSTRAINT "loupe_fund_kind_valid" CHECK ("loupe_fund"."kind" in ('start', 'sale', 'plan', 'free_cut', 'adjust'))
);
--> statement-breakpoint
ALTER TABLE "loupe_fund" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loupe_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loupe_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"cut_id" bigint,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"stripe_session_id" text NOT NULL,
	"stripe_payment_intent" text,
	"created_by" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loupe_payments_stripe_session_id_unique" UNIQUE("stripe_session_id"),
	CONSTRAINT "loupe_payments_kind_valid" CHECK ("loupe_payments"."kind" in ('scene', 'topaz')),
	CONSTRAINT "loupe_payments_status_valid" CHECK ("loupe_payments"."status" in ('pending', 'paid', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "loupe_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loupe_accounts" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "loupe_accounts" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "loupe_accounts" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "loupe_accounts" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_accounts" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "unlocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD COLUMN "unlocked_how" text;--> statement-breakpoint
ALTER TABLE "loupe_fund" ADD CONSTRAINT "loupe_fund_account_id_loupe_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loupe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_fund" ADD CONSTRAINT "loupe_fund_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_payments" ADD CONSTRAINT "loupe_payments_account_id_loupe_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loupe_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_payments" ADD CONSTRAINT "loupe_payments_project_id_loupe_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."loupe_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loupe_payments" ADD CONSTRAINT "loupe_payments_cut_id_loupe_cuts_id_fk" FOREIGN KEY ("cut_id") REFERENCES "public"."loupe_cuts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loupe_fund_created_idx" ON "loupe_fund" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "loupe_payments_project_idx" ON "loupe_payments" USING btree ("project_id","kind","status");--> statement-breakpoint
CREATE INDEX "loupe_payments_account_idx" ON "loupe_payments" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "loupe_accounts" ADD CONSTRAINT "loupe_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "loupe_projects" ADD CONSTRAINT "loupe_projects_unlocked_how_valid" CHECK ("loupe_projects"."unlocked_how" in ('free', 'plan', 'paid'));--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_fund" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "loupe_app_all" ON "loupe_payments" AS PERMISSIVE FOR ALL TO "loupe_app" USING (true) WITH CHECK (true);;--> statement-breakpoint
-- The app and worker read and write these rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON "loupe_payments", "loupe_fund" TO "loupe_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "loupe_payments_id_seq", "loupe_fund_id_seq" TO "loupe_app";--> statement-breakpoint
-- No access through Supabase's public API, even if row-level security were ever switched off.
REVOKE ALL ON "loupe_payments", "loupe_fund" FROM "anon", "authenticated";--> statement-breakpoint
-- The launch budget for free cutting (Guy, Oct 9): $300.
INSERT INTO "loupe_fund" ("amount_cents", "kind", "ref") VALUES (30000, 'start', 'start:launch');
