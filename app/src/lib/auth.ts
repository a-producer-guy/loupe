import "server-only";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { canWrite, ensureMember, type Member } from "@/lib/footage/accounts";
import { createSupabase } from "@/lib/supabase/server";

// Signing in proves who someone is; loupe_members says which account they belong to. Anyone can
// sign up: the first time an email signs in, it gets its own account on the free plan. Every page
// and API route checks the member, and every route that touches a scene checks the scene is in
// that member's account (lib/footage/access.ts), not just proxy.ts.

export type { Member };

export async function currentEmail(): Promise<string | null> {
  // Local testing only (npm run dev with no Supabase): production builds drop this line.
  if (process.env.NODE_ENV === "development" && process.env.DEV_SIGN_IN_AS) return process.env.DEV_SIGN_IN_AS.toLowerCase();
  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const email = data?.claims?.email;
  return typeof email === "string" && email ? email.toLowerCase() : null;
}

/** For pages: anyone signed out goes to the sign-in page; a first sign-in gets an account. */
export async function requireMember(): Promise<Member> {
  const email = await currentEmail();
  if (!email) redirect("/login");
  return ensureMember(email, getDb());
}

/** For API routes: the member, or the response to send back instead. */
export async function apiMember(need: "read" | "write" | "owner" = "read"): Promise<Member | Response> {
  const email = await currentEmail();
  if (!email) return Response.json({ error: "Please sign in again.", code: "signed-out" }, { status: 401 });
  const member = await ensureMember(email, getDb());
  if (need === "write" && !canWrite(member)) {
    return Response.json({ error: "Your role can watch and comment, not change scenes.", code: "not-allowed" }, { status: 403 });
  }
  if (need === "owner" && member.role !== "owner") {
    return Response.json({ error: "Only the account owner can do that.", code: "not-allowed" }, { status: 403 });
  }
  return member;
}

export { canWrite, ensureMember };
export { safeNext } from "@/lib/security";
