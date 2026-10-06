// Creating shoots and the few actions on them.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { files, projects, proxyJobs } from "@/lib/db/schema";
import { DropError } from "./register";
import { storagePrefix } from "./names";
import { refreshProjectStatus } from "./verify";

/** "  The   Offer " → "The Offer". */
export function cleanSceneName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 120);
}

export async function createShoot(
  db: Db,
  input: { accountId: number; name: string; shootDate: string; createdBy: string; lutId?: number | null },
) {
  const name = cleanSceneName(input.name);
  if (!name) throw new DropError("Give the scene a name, like its title in the script.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.shootDate) || Number.isNaN(Date.parse(input.shootDate))) {
    throw new DropError("Pick the shoot date.");
  }
  return db.transaction(async (tx) => {
    // The B2 folder name includes the new row's id, so it's filled in right after the insert.
    const [row] = await tx
      .insert(projects)
      .values({
        accountId: input.accountId,
        name,
        shootDate: input.shootDate,
        storagePrefix: sql`'pending-' || gen_random_uuid()`,
        createdBy: input.createdBy,
        lutId: input.lutId ?? null,
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

/** Renames a scene. Its B2 folder keeps its first name, so no files move. */
export async function renameShoot(db: Db, projectId: number, name: string): Promise<string | undefined> {
  const clean = cleanSceneName(name);
  if (!clean) throw new DropError("Give the scene a name.");
  const [row] = await db.update(projects).set({ name: clean }).where(eq(projects.id, projectId)).returning({ name: projects.name });
  return row?.name;
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
