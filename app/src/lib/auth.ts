import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { members } from "@/lib/db/schema";
import { createSupabase } from "@/lib/supabase/server";

// Signing in proves who someone is; footage_members decides whether they're on
// the team. Every page and API route checks both, not just proxy.ts.

export type Member = typeof members.$inferSelect;

export async function currentEmail(): Promise<string | null> {
  // Local testing only (npm run dev with no Supabase): production builds drop this line.
  if (process.env.NODE_ENV === "development" && process.env.DEV_SIGN_IN_AS) return process.env.DEV_SIGN_IN_AS.toLowerCase();
  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const email = data?.claims?.email;
  return typeof email === "string" && email ? email.toLowerCase() : null;
}

export async function findMember(email: string): Promise<Member | null> {
  const [member] = await getDb().select().from(members).where(eq(members.email, email.trim().toLowerCase()));
  return member ?? null;
}

/** For pages: anyone who isn't a signed-in team member goes to the sign-in page. */
export async function requireMember(): Promise<Member> {
  const email = await currentEmail();
  const member = email ? await findMember(email) : null;
  if (!member) redirect("/login");
  return member;
}

/** For API routes: the member, or the response to send back instead. */
export async function apiMember(role?: Member["role"]): Promise<Member | Response> {
  const email = await currentEmail();
  if (!email) return Response.json({ error: "Please sign in again.", code: "signed-out" }, { status: 401 });
  const member = await findMember(email);
  if (!member) return Response.json({ error: "You're not on the Reelarc team list.", code: "not-member" }, { status: 403 });
  if (role && member.role !== role) {
    return Response.json({ error: "Only admins can do that.", code: "not-allowed" }, { status: 403 });
  }
  return member;
}

export { safeNext } from "@/lib/security";
