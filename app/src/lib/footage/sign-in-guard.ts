// Stops anyone guessing a 6-digit sign-in code. Codes are checked by this app's server, so
// Supabase's own per-address limits only ever see the server; this counts wrong codes per email.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { signInAttempts } from "@/lib/db/schema";

export const MAX_WRONG_CODES = 5;
export const WINDOW_MINUTES = 15;

/** Whole minutes this email must wait before trying another code, or 0 if it may try now. */
export async function minutesLocked(db: Db, email: string): Promise<number> {
  const [row] = await db
    .select({
      failures: signInAttempts.failures,
      secondsLeft: sql<number>`extract(epoch from (${signInAttempts.windowStart} + make_interval(mins => ${WINDOW_MINUTES})) - now())::float8`,
    })
    .from(signInAttempts)
    .where(eq(signInAttempts.email, email));
  if (!row || row.failures < MAX_WRONG_CODES || row.secondsLeft <= 0) return 0;
  return Math.max(1, Math.ceil(row.secondsLeft / 60));
}

/** Counts one wrong code: within the current 15 minutes, or as the first of a new 15 minutes. */
export async function recordWrongCode(db: Db, email: string): Promise<void> {
  const expired = sql`${signInAttempts.windowStart} < now() - make_interval(mins => ${WINDOW_MINUTES})`;
  await db
    .insert(signInAttempts)
    .values({ email, failures: 1 })
    .onConflictDoUpdate({
      target: signInAttempts.email,
      set: {
        failures: sql`case when ${expired} then 1 else ${signInAttempts.failures} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${signInAttempts.windowStart} end`,
      },
    });
}

/** A right code wipes the slate clean. */
export async function clearWrongCodes(db: Db, email: string): Promise<void> {
  await db.delete(signInAttempts).where(eq(signInAttempts.email, email));
}
