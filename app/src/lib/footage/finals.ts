import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { finals } from "@/lib/db/schema";
import { CutError, sceneCuts } from "@/lib/footage/cuts";
import { exportable, FINISHING_SOUND, type FinalView } from "@/lib/footage/cut-types";

// Final files (Guy, Oct 7: "we need to export the final"): the newest finished version built again from the camera
// originals at full resolution (worker/src/assembly/final.ts), and, when that's below 4K, a 4K version made with
// Topaz on fal (worker/src/assembly/topaz.ts), to download.

/** fal's price for Topaz 4K, per second (as worker/src/assembly/topaz.ts): shown before anyone asks for it. */
export const TOPAZ_PER_SECOND = 0.08;

/** What a customer pays for Topaz 4K: twice what it costs us, rounded up to the dollar, $5 at least. In cents. */
export function topazPrice(seconds: number): number {
  return Math.max(5, Math.ceil(seconds * TOPAZ_PER_SECOND * 2)) * 100;
}

/** The finals of the scene's newest finished version (one of each kind: the newest). */
export async function sceneFinals(
  db: Db,
  projectId: number,
  sign: (key: string, saveAs?: string) => Promise<string>,
): Promise<{ cutId: number | null; canMake: boolean; topazCost: number | null; finals: FinalView[] }> {
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) return { cutId: null, canMake: false, topazCost: null, finals: [] };
  const rows = await db.select().from(finals).where(and(eq(finals.projectId, projectId), eq(finals.cutId, done.id))).orderBy(desc(finals.id));
  const newest = (["original", "topaz"] as const).flatMap((kind) => rows.filter((r) => r.kind === kind).slice(0, 1));
  return {
    cutId: done.id,
    canMake: Boolean(done.result.render),
    topazCost: topazPrice(done.result.seconds) / 100,
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
  if (!exportable(done.result)) throw new CutError(FINISHING_SOUND, 409);
  const [existing] = await db
    .select({ status: finals.status })
    .from(finals)
    .where(and(eq(finals.cutId, done.id), eq(finals.kind, "original")))
    .orderBy(desc(finals.id))
    .limit(1);
  if (existing && existing.status !== "failed") return;
  await db.insert(finals).values({ cutId: done.id, projectId, kind: "original", requestedBy: by }).onConflictDoNothing();
}

/** Asks for the 4K version (Topaz) of the newest version's final: once that's made, and only when it's below 4K. */
export async function requestTopaz(db: Db, projectId: number, by: string, options: { check?: boolean } = {}): Promise<void> {
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) throw new CutError("There's no cut to make 4K yet.");
  const rows = await db.select().from(finals).where(eq(finals.cutId, done.id)).orderBy(desc(finals.id));
  const original = rows.find((r) => r.kind === "original");
  if (!original || original.status !== "done") throw new CutError("Make the final first; the 4K version is made from it.");
  if ((original.width ?? 0) >= 3456) throw new CutError("The final is already 4K.");
  const topaz = rows.find((r) => r.kind === "topaz");
  if (topaz && topaz.status !== "failed") {
    if (options.check) throw new CutError(topaz.status === "done" ? "This version is already 4K." : "The 4K version is already being made.");
    return;
  }
  // Only checking it can start (before it's paid for).
  if (options.check) return;
  await db.insert(finals).values({ cutId: done.id, projectId, kind: "topaz", requestedBy: by }).onConflictDoNothing();
}
