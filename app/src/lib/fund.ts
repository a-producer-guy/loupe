import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { accounts, cuts, fund, projects, proxyJobs } from "@/lib/db/schema";

// The free-cutting fund (Guy, Oct 9: "I need to be in the black always"). Free cuts are paid for by sales: every
// sale puts half of what it brings in (after Stripe's fee) into the fund, every free cut takes out the most it can
// cost (the worker does that when it starts one: worker/src/assembly/job.ts claimAssembly), and a free cut only starts
// when the fund holds that much. Free spending can never pass the launch budget plus half of all sales.

/** Must match worker/src/assembly/job.ts. */
export const FREE_CUT_BASE_CENTS = 50;
export const FREE_CUT_CENTS_PER_MINUTE = 7;
export const FREE_VERSION_CENTS = 50;

/** Half of what a payment brings in after Stripe's fee (2.9% + 30¢), in cents. */
export function fundShare(cents: number): number {
  return Math.max(0, Math.floor((cents * 0.971 - 30) / 2));
}

/** Puts a sale's half in the fund, once per `ref`. */
export async function depositSale(db: Db, input: { cents: number; ref: string; kind: "sale" | "plan"; accountId: number | null; projectId?: number | null }): Promise<void> {
  const amount = fundShare(input.cents);
  if (!amount) return;
  await db
    .insert(fund)
    .values({ amountCents: amount, kind: input.kind, ref: input.ref, accountId: input.accountId, projectId: input.projectId ?? null })
    .onConflictDoNothing({ target: fund.ref });
}

export async function fundBalance(db: Db): Promise<number> {
  const [{ cents }] = await db.select({ cents: sql<number>`coalesce(sum(${fund.amountCents}), 0)::int` }).from(fund);
  return cents;
}

/**
 * Whether the scene's next version is a free one waiting for the fund (shown as "Loupe is busy: your free cut starts
 * soon", with the offer to pay and skip the line). Paid scenes and live plans never wait.
 */
export async function waitingForFund(db: Db, projectId: number): Promise<boolean> {
  const [scene] = await db
    .select({ unlockedAt: projects.unlockedAt, plan: accounts.plan, status: accounts.subscriptionStatus })
    .from(projects)
    .innerJoin(accounts, eq(accounts.id, projects.accountId))
    .where(eq(projects.id, projectId));
  if (!scene || scene.unlockedAt) return false;
  if ((scene.plan === "pro" || scene.plan === "studio") && ["active", "trialing", "past_due"].includes(scene.status ?? "")) return false;
  const rows = await db.select({ id: cuts.id, status: cuts.status }).from(cuts).where(eq(cuts.projectId, projectId));
  const waiting = rows.find((r) => r.status === "waiting");
  if (!waiting || rows.some((r) => r.status === "working")) return false;
  const [charged] = await db.select({ id: fund.id }).from(fund).where(eq(fund.ref, `cut:${waiting.id}`));
  if (charged) return false;
  let cost = FREE_VERSION_CENTS;
  if (!rows.some((r) => r.status === "done")) {
    const [{ seconds }] = await db
      .select({ seconds: sql<number>`coalesce(sum((${proxyJobs.media}->>'durationSeconds')::float8), 0)` })
      .from(proxyJobs)
      .where(and(eq(proxyJobs.projectId, projectId)));
    cost = FREE_CUT_BASE_CENTS + Math.ceil((FREE_CUT_CENTS_PER_MINUTE * Number(seconds)) / 60);
  }
  return (await fundBalance(db)) < cost;
}
