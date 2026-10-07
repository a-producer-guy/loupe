// The wall between Loupe's customers. Every API route that takes a scene id, a file's storage key
// or a LUT asks here first, and treats "not in your account" exactly like "doesn't exist" (404),
// so nobody can learn what other accounts have.

import { and, eq, sql } from "drizzle-orm";
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

/** What each plan allows. Free is the "first scene free" plan; paid plans aren't capped here. */
export const PLAN_LIMITS: Record<Plan, { scenes: number; bytes: number }> = {
  free: { scenes: 1, bytes: 25e9 },
  indie: { scenes: Infinity, bytes: Infinity },
  pro: { scenes: Infinity, bytes: Infinity },
  studio: { scenes: Infinity, bytes: Infinity },
};

export async function accountPlan(db: Db, accountId: number): Promise<Plan> {
  const [row] = await db.select({ plan: accounts.plan }).from(accounts).where(eq(accounts.id, accountId));
  return row?.plan ?? "free";
}

/** How much the account has used: scenes, and bytes of footage recorded. */
export async function accountUsage(db: Db, accountId: number): Promise<{ scenes: number; bytes: number }> {
  const [scenes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.accountId, accountId));
  const [bytes] = await db
    .select({ n: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8` })
    .from(files)
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(eq(projects.accountId, accountId));
  return { scenes: scenes.n, bytes: bytes.n };
}
