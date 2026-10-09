// What the account pages show: the account, its people, its plan and what it has used.

import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { accounts, members, type Plan } from "@/lib/db/schema";
import { accountUsage, PLAN_LIMITS } from "./access";

export type AccountView = {
  id: number;
  name: string;
  plan: Plan;
  createdAt: string;
  usage: { scenes: number; bytes: number };
  limits: { scenes: number | null; bytes: number | null };
  people: { email: string; role: string; createdAt: string }[];
  /** Stripe: whether there's a billing page to open, and the plan's subscription (status and when it renews). */
  billing: { customer: boolean; status: string | null; periodEnd: string | null };
};

export async function accountView(db: Db, accountId: number): Promise<AccountView> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  const people = await db
    .select({ email: members.email, role: members.role, createdAt: members.createdAt })
    .from(members)
    .where(eq(members.accountId, accountId))
    .orderBy(asc(members.createdAt));
  const limit = PLAN_LIMITS[account.plan];
  return {
    id: account.id,
    name: account.name,
    plan: account.plan,
    createdAt: account.createdAt.toISOString(),
    usage: await accountUsage(db, accountId),
    limits: { scenes: Number.isFinite(limit.scenes) ? limit.scenes : null, bytes: Number.isFinite(limit.bytes) ? limit.bytes : null },
    people: people.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
    billing: { customer: Boolean(account.stripeCustomerId), status: account.subscriptionStatus, periodEnd: account.periodEnd?.toISOString() ?? null },
  };
}

/** The plans, as the pricing page and the Plan page show them. */
export const PLANS: { id: Exclude<Plan, "free">; name: string; price: string; per: string; for: string; points: string[]; keeps: string }[] = [
  {
    id: "indie",
    name: "Indie",
    price: "$39",
    per: "a scene",
    for: "Shorts, students and actors",
    points: ["Your first scene free", "A first assembly with a reason for every shot", "Every take of every line, one click away", "Premiere timeline with proxies attached"],
    keeps: "Original footage kept 30 days after export",
  },
  {
    id: "pro",
    name: "Pro",
    price: "$199",
    per: "a month",
    for: "Working editors and busy filmmakers",
    points: ["10 scenes a month, then $39 each", "Everything in Indie", "Priority cutting"],
    keeps: "Original footage kept 60 days after export",
  },
  {
    id: "studio",
    name: "Studio",
    price: "$1,500",
    per: "a month",
    for: "Reel companies and production houses",
    points: ["Up to 60 scenes a month, then $25 each", "Team seats and shared scenes", "Your house style for every cut", "Savings report every month"],
    keeps: "Original footage kept 90 days, rolling",
  },
];
