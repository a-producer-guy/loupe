import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { files, projects, proxyJobs, scripts } from "@/lib/db/schema";
import type { RoomCut } from "@/lib/footage/cut-types";
import { cutState } from "@/lib/footage/cuts";
import { previewKey, thumbnailKey } from "@/lib/footage/names";
import { signView } from "@/lib/storage";

/**
 * Everything the cutting room shows about a scene's cut (starting the first one when it's due): its state, each
 * take's still and playable preview (the filmstrip, Other takes), and the script's scene heading.
 */
export async function roomCut(db: Db, scene: typeof projects.$inferSelect, by: string, accountId: number): Promise<RoomCut> {
  const state = await cutState(db, scene.id, scene.storagePrefix, by, signView);
  const result = state.done?.result;
  let takes: Record<string, { still: string | null; preview: string | null; seconds: number | null }> = {};
  if (result) {
    const rows = await db
      .select({ path: files.path, key: proxyJobs.proxyKey, preview: proxyJobs.previewSizeBytes, media: proxyJobs.media, look: proxyJobs.madeWithLutId })
      .from(files)
      .innerJoin(proxyJobs, eq(proxyJobs.fileId, files.id))
      .where(and(eq(files.projectId, scene.id), eq(proxyJobs.status, "done")));
    const byPath = new Map(rows.map((r) => [r.path, r]));
    takes = Object.fromEntries(
      await Promise.all(
        result.takes.map(async (t) => {
          const row = byPath.get(t.path);
          const look = row?.look ? `look-${row.look}` : undefined;
          return [
            t.take,
            {
              still: row ? await signView(thumbnailKey(row.key), look) : null,
              preview: row && row.preview !== null ? await signView(previewKey(row.key), `${look ?? "take"}-${row.key.length}`, "mp4") : null,
              seconds: (row?.media as { durationSeconds?: number } | null)?.durationSeconds ?? null,
            },
          ] as const;
        }),
      ),
    );
  }
  const heading = result?.scriptId
    ? ((await db.select({ heading: scripts.heading }).from(scripts).where(and(eq(scripts.id, result.scriptId), eq(scripts.accountId, accountId))))[0]?.heading ?? null)
    : null;
  return { ...state, takes, heading };
}
