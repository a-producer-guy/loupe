-- Reelarc Footage: sign-in guards.
--
-- 1. footage_sign_in_attempts: wrong sign-in codes per email, so a 6-digit
--    code can't be guessed (5 tries per 15 minutes). Locked down like the
--    other footage tables: row-level security on, only the footage_app login
--    may use it, Supabase's public roles get nothing.
-- 2. footage_before_user_created(): Supabase Auth calls it before creating
--    any account. It only allows emails on the team list (footage_members),
--    so nobody else can make an account or get sign-in emails sent, even by
--    calling Supabase directly. It changes nothing on its own: it's switched
--    on in Supabase (Authentication, Auth Hooks, Before User Created).
-- Nothing existing is changed.

CREATE TABLE "footage_sign_in_attempts" (
	"email" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "footage_sign_in_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "footage_app_all" ON "footage_sign_in_attempts" AS PERMISSIVE FOR ALL TO "footage_app" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "footage_sign_in_attempts" TO "footage_app";--> statement-breakpoint
REVOKE ALL ON "footage_sign_in_attempts" FROM "anon", "authenticated";--> statement-breakpoint
CREATE FUNCTION public.footage_before_user_created(event jsonb) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM public.footage_members WHERE email = lower(event #>> '{user,email}')) THEN
		RETURN '{}'::jsonb;
	END IF;
	RETURN jsonb_build_object('error', jsonb_build_object(
		'http_code', 403,
		'message', 'This email is not on the Reelarc Footage team list.'));
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.footage_before_user_created(jsonb) FROM PUBLIC, "anon", "authenticated";--> statement-breakpoint
DO $$
BEGIN
	-- Supabase Auth's own login. (Test and local databases don't have it.)
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
		GRANT EXECUTE ON FUNCTION public.footage_before_user_created(jsonb) TO supabase_auth_admin;
	END IF;
END
$$;
