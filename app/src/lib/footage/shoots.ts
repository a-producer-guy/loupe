// Creating shoots and the few actions on them.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { files, projects, proxyJobs } from "@/lib/db/schema";
import { DropError } from "./register";
import { storagePrefix } from "./names";
import { refreshProjectStatus } from "./verify";

/** "  Ryan   Colone " → "Ryan Colone"; blank → null (no DP yet). */
export function cleanDpName(name: string | null | undefined): string | null {
  return name?.trim().replace(/\s+/g, " ").slice(0, 80) || null;
}

export async function createShoot(
  db: Db,
  input: { name: string; shootDate: string; createdBy: string; lutId?: number | null; dpName?: string | null },
) {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) throw new DropError("Give the shoot a name, like the client's name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.shootDate) || Number.isNaN(Date.parse(input.shootDate))) {
    throw new DropError("Pick the shoot date.");
  }
  return db.transaction(async (tx) => {
    // The B2 folder name includes the new row's id, so it's filled in right after the insert.
    const [row] = await tx
      .insert(projects)
      .values({
        name,
        shootDate: input.shootDate,
        storagePrefix: sql`'pending-' || gen_random_uuid()`,
        createdBy: input.createdBy,
        lutId: input.lutId ?? null,
        dpName: cleanDpName(input.dpName),
      })
      .returning({ id: projects.id });
    const [shoot] = await tx
      .update(projects)
      .set({ storagePrefix: storagePrefix(input.shootDate, name, row.id) })
      .where(eq(projects.id, row.id))
      .returning();
    return shoot;
  });
}

/** Sets or clears the shoot's DP. Returns the name as saved, or undefined when there's no such shoot. */
export async function setShootDp(db: Db, projectId: number, dpName: string | null): Promise<string | null | undefined> {
  const [row] = await db
    .update(projects)
    .set({ dpName: cleanDpName(dpName) })
    .where(eq(projects.id, projectId))
    .returning({ dpName: projects.dpName });
  return row ? row.dpName : undefined;
}

/** DPs already typed in, most recent shoot first and each once, to suggest on the next shoot. */
export async function recentDps(db: Db, limit = 20): Promise<string[]> {
  const rows = await db
    .select({ name: projects.dpName })
    .from(projects)
    .where(isNotNull(projects.dpName))
    .groupBy(projects.dpName)
    .orderBy(desc(sql`max(${projects.id})`))
    .limit(200);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of rows) {
    const key = name!.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name!);
  }
  return names.slice(0, limit);
}

/** Puts failed proxies back in the queue with a fresh set of attempts. */
export async function retryProxies(db: Db, projectId: number, jobId?: number): Promise<number> {
  const retried = await db
    .update(proxyJobs)
    .set({ status: "queued", attempts: 0, runAfter: new Date(), error: null, finishedAt: null, progress: null })
    .where(
      and(
        eq(proxyJobs.projectId, projectId),
        eq(proxyJobs.status, "failed"),
        jobId === undefined ? undefined : eq(proxyJobs.id, jobId),
      ),
    )
    .returning({ id: proxyJobs.id });
  return retried.length;
}

/**
 * Forgets the files of one card that haven't finished uploading, for a card
 * dropped on the wrong shoot. Files already safely in B2 stay recorded (and
 * stay in B2: nothing is deleted from storage in Phase 1).
 */
export async function stopCard(db: Db, projectId: number, card: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    const removed = await tx
      .delete(files)
      .where(
        and(
          eq(files.projectId, projectId),
          eq(files.card, card),
          inArray(files.status, ["pending", "uploading", "unreadable"]),
        ),
      )
      .returning({ id: files.id });
    await refreshProjectStatus(tx, projectId);
    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(files)
      .where(eq(files.projectId, projectId));
    if (left.n === 0) {
      await tx.update(projects).set({ status: "scheduled", uploadedAt: null }).where(eq(projects.id, projectId));
    }
    return removed.length;
  });
}
