import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { finals } from "@/lib/db/schema";
import { CutError, sceneCuts } from "@/lib/footage/cuts";
import type { FinalView } from "@/lib/footage/cut-types";

// Final files (Guy, Oct 7: "we need to export the final"): the newest finished version built again from the camera
// originals at full resolution, by the worker (worker/src/assembly/final.ts), to download. Topaz 4K comes next.

/** The finals of the scene's newest finished version (one of each kind: the newest). */
export async function sceneFinals(db: Db, projectId: number, sign: (key: string, saveAs?: string) => Promise<string>): Promise<{ cutId: number | null; canMake: boolean; finals: FinalView[] }> {
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) return { cutId: null, canMake: false, finals: [] };
  const rows = await db.select().from(finals).where(and(eq(finals.projectId, projectId), eq(finals.cutId, done.id))).orderBy(desc(finals.id));
  const newest = (["original", "topaz"] as const).flatMap((kind) => rows.filter((r) => r.kind === kind).slice(0, 1));
  return {
    cutId: done.id,
    canMake: Boolean(done.result.render),
    finals: await Promise.all(
      newest.map(async (r) => ({
        id: r.id,
        cutId: r.cutId,
        kind: r.kind,
        status: r.status,
        progress: r.progress,
        error: r.error,
        width: r.width,
        height: r.height,
        sizeBytes: r.sizeBytes,
        download: r.status === "done" && r.storageKey ? await sign(r.storageKey, r.storageKey.split("/").at(-1)) : null,
      })),
    ),
  };
}

/** Asks for the final of the newest finished version (once: asking again while it's made, or once it's made, is a no-op). */
export async function requestFinal(db: Db, projectId: number, by: string): Promise<void> {
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) throw new CutError("There's no cut to make a final of yet.");
  if (!done.result.render) throw new CutError("This version was cut before finals existed. Make it again, then export the final.");
  const [existing] = await db
    .select({ status: finals.status })
    .from(finals)
    .where(and(eq(finals.cutId, done.id), eq(finals.kind, "original")))
    .orderBy(desc(finals.id))
    .limit(1);
  if (existing && existing.status !== "failed") return;
  await db.insert(finals).values({ cutId: done.id, projectId, kind: "original", requestedBy: by }).onConflictDoNothing();
}
