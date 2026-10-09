// The wall between Loupe's customers. Every API route that takes a scene id, a file's storage key
// or a LUT asks here first, and treats "not in your account" exactly like "doesn't exist" (404),
// so nobody can learn what other accounts have.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { accounts, files, luts, projects, type Plan } from "@/lib/db/schema";

type Owner = { accountId: number };

/** The scene, if it's in the member's account. */
export async function ownedShoot(db: Db, member: Owner, id: number | null) {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.accountId, member.accountId)));
  return row ?? null;
}

/** The file with this storage key, if its scene is in the member's account. */
export async function ownedFileByKey(db: Db, member: Owner, storageKey: string) {
  const [row] = await db
    .select({ id: files.id, status: files.status, uploadId: files.uploadId, projectId: files.projectId, path: files.path, storageKey: files.storageKey, sizeBytes: files.sizeBytes })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(and(eq(files.storageKey, storageKey), eq(projects.accountId, member.accountId)));
  return row ?? null;
}

/** The LUT, if it's in the member's account. */
export async function ownedLut(db: Db, member: Owner, id: number | null) {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(luts)
    .where(and(eq(luts.id, id), eq(luts.accountId, member.accountId)));
  return row ?? null;
}

/**
 * What each plan can have waiting to be exported (uploaded and cut, not yet paid for). Exporting is what's paid for,
 * so pay-as-you-go accounts (free: first scene not used yet; indie: pays per scene) keep a few scenes in progress at
 * once, which caps the cutting and storage given away; Pro and Studio keep more.
 */
export const PLAN_LIMITS: Record<Plan, { scenes: number; bytes: number }> = {
  free: { scenes: 3, bytes: 500e9 },
  indie: { scenes: 3, bytes: 500e9 },
  // Plans: cutting a scene costs Loupe a few dollars, so even plans can't pile up unexported scenes for ever.
  pro: { scenes: 20, bytes: Infinity },
  studio: { scenes: 100, bytes: Infinity },
};

/** Said when an account has as many scenes waiting to be exported as its plan keeps. */
export function waitingFull(plan: Plan): string {
  const n = PLAN_LIMITS[plan].scenes;
  return plan === "pro" || plan === "studio"
    ? `You have ${n} scenes waiting to be exported, the most ${plan === "pro" ? "Pro" : "Studio"} keeps. Export one to start another.`
    : `You have ${n} scenes waiting to be exported. Export one, or choose Pro, to start another.`;
}

export async function accountPlan(db: Db, accountId: number): Promise<Plan> {
  const [row] = await db.select({ plan: accounts.plan }).from(accounts).where(eq(accounts.id, accountId));
  return row?.plan ?? "free";
}

/** What the account has waiting to be exported: scenes not unlocked yet, and their footage in bytes. */
export async function accountUsage(db: Db, accountId: number): Promise<{ scenes: number; bytes: number }> {
  const [scenes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), isNull(projects.unlockedAt)));
  const [bytes] = await db
    .select({ n: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8` })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(and(eq(projects.accountId, accountId), isNull(projects.unlockedAt)));
  return { scenes: scenes.n, bytes: bytes.n };
}
