// After the browser says a file finished, check B2 really has all of it before
// counting it. Only then does it count toward "safe to wipe cards", and only
// then does a video clip get queued for a proxy.

import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { files, projects, proxyJobs } from "@/lib/db/schema";
import { lutForCard } from "./luts";
import { extensionOf, proxyPath } from "./names";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "wrong-size" | "unknown-file"; message: string };

export async function verifyUpload(
  db: Db,
  key: string,
  uploadedBy: string,
  storedSize: (key: string) => Promise<number | null>,
): Promise<VerifyResult> {
  const [file] = await db.select().from(files).where(eq(files.storageKey, key));
  if (!file) return { ok: false, reason: "unknown-file", message: "This file isn't part of any scene." };
  if (file.status === "uploaded") return { ok: true };

  const size = await storedSize(key);
  if (size === null) return { ok: false, reason: "missing", message: "B2 doesn't have this file yet." };
  if (size !== file.sizeBytes) {
    // Start this file over rather than trust a copy of the wrong size.
    await db.update(files).set({ status: "pending", uploadId: null }).where(eq(files.id, file.id));
    return {
      ok: false,
      reason: "wrong-size",
      message: `B2 has ${size} bytes but the card has ${file.sizeBytes}. Uploading it again.`,
    };
  }

  await db.transaction(async (tx) => {
    // Checks for the same shoot take turns, so the last file in always sees the others.
    const [project] = await tx.select().from(projects).where(eq(projects.id, file.projectId)).for("update");
    const [marked] = await tx
      .update(files)
      .set({ status: "uploaded", uploadId: null, uploadedAt: new Date(), uploadedBy, problem: null })
      .where(and(eq(files.id, file.id), ne(files.status, "uploaded")))
      .returning();
    if (!marked) return; // another request got here first
    if (marked.isVideo) await queueProxy(tx, project.storagePrefix, marked);
    await refreshProjectStatus(tx, file.projectId);
  });
  return { ok: true };
}

async function queueProxy(tx: Db, prefix: string, file: typeof files.$inferSelect) {
  let proxyKey = `${prefix}/${proxyPath(file.path)}`;
  const [taken] = await tx
    .select({ fileId: proxyJobs.fileId })
    .from(proxyJobs)
    .where(eq(proxyJobs.proxyKey, proxyKey));
  if (taken && taken.fileId !== file.id) {
    // Two clips with the same name in one folder (A001.MOV next to A001.MP4).
    // Keep both proxies; this one can't share the raw's exact name.
    proxyKey = proxyKey.replace(/\.mov$/, `_${extensionOf(file.path).toUpperCase()}.mov`);
  }
  // Made with the LUT the card was filmed with, from the start.
  const lutId = await lutForCard(tx, file.projectId, file.card);
  await tx
    .insert(proxyJobs)
    .values({ fileId: file.id, projectId: file.projectId, rawKey: file.storageKey, proxyKey, lutId })
    .onConflictDoNothing();
}

/** Keeps the shoot's status in step with its files. */
export async function refreshProjectStatus(tx: Db, projectId: number) {
  const [counts] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      remaining: sql<number>`(count(*) filter (where ${files.status} <> 'uploaded'))::int`,
    })
    .from(files)
    .where(eq(files.projectId, projectId));
  if (counts.total > 0 && counts.remaining === 0) {
    await tx
      .update(projects)
      .set({ status: "uploaded", uploadedAt: new Date() })
      .where(and(eq(projects.id, projectId), sql`${projects.status} in ('scheduled', 'uploading')`));
  } else if (counts.remaining > 0) {
    await tx
      .update(projects)
      .set({ status: "uploading" })
      .where(and(eq(projects.id, projectId), sql`${projects.status} in ('scheduled', 'uploaded')`));
  }
}
