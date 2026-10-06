import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth";
import { createSupabase } from "@/lib/supabase/server";

// Where the sign-in email's link lands. Handles both link styles Supabase can
// send: a one-time code (the default) or a token hash (custom email template).
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNext(params.get("next"));
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;

  const supabase = await createSupabase();
  let failed = Boolean(params.get("error_code") || params.get("error"));
  if (!failed && code) failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
  else if (!failed && tokenHash && type) failed = Boolean((await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error);
  else if (!failed) failed = true;

  if (failed) {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", "link");
    if (next !== "/") login.searchParams.set("next", next);
    return NextResponse.redirect(login);
  }
  return NextResponse.redirect(new URL(next, request.url));
}
