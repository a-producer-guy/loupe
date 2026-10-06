// Accounts and the people in them. Anyone can sign up: the first time an email signs in, it gets
// its own account on the free plan, with that person as the owner.

import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { accounts, members } from "@/lib/db/schema";

export type Member = typeof members.$inferSelect;

export async function findMember(email: string, db: Db): Promise<Member | null> {
  const [member] = await db.select().from(members).where(eq(members.email, email.trim().toLowerCase()));
  return member ?? null;
}

const WEBMAIL = /^(gmail|googlemail|icloud|me|mac|yahoo|hotmail|outlook|live|msn|aol|proton|protonmail|hey|fastmail|gmx|zoho)\./i;

/** A first name for a new account: the company from a work email ("Northlight Reels"), else "My studio". */
export function accountNameFor(email: string): string {
  const domain = email.split("@")[1] ?? "";
  if (!domain || WEBMAIL.test(domain)) return "My studio";
  const word = domain.split(".")[0].replace(/[-_]+/g, " ").trim();
  return word ? word.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60) : "My studio";
}

/** The member for this email, creating their account the first time they sign in. */
export async function ensureMember(email: string, db: Db): Promise<Member> {
  const clean = email.trim().toLowerCase();
  const existing = await findMember(clean, db);
  if (existing) return existing;
  const made = await db.transaction(async (tx) => {
    const [account] = await tx.insert(accounts).values({ name: accountNameFor(clean) }).returning({ id: accounts.id });
    const [member] = await tx
      .insert(members)
      .values({ email: clean, accountId: account.id, role: "owner" })
      // Two first requests at once: the loser's transaction rolls back its account too.
      .onConflictDoNothing({ target: members.email })
      .returning();
    if (!member) tx.rollback();
    return member;
  }).catch(() => null);
  if (made) return made;
  const again = await findMember(clean, db);
  if (!again) throw new Error("Couldn't set up the account.");
  return again;
}

/** Owners and editors can upload and change scenes; directors and viewers can only look. */
export function canWrite(member: Pick<Member, "role">): boolean {
  return member.role === "owner" || member.role === "editor";
}
