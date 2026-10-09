import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { files, proxyJobs } from "@/lib/db/schema";
import { ownedShoot } from "@/lib/footage/access";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { packageFiles, sceneCuts } from "@/lib/footage/cuts";
import { lutFileName, lutsUsedBy } from "@/lib/footage/luts";
import { signDownload } from "@/lib/storage";

// Everything in the shoot that can be downloaded right now, laid out the way
// it sits in B2 (Raw/..., Proxies/...), so Premiere relinks after download,
// plus the shoot's LUTs in LUTs/ for applying the same look to the originals, and Loupe's cut (the newest finished
// version: its Premiere timeline, preview and sound) in "Loupe Cut/".

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/downloads">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  const shoot = await ownedShoot(db, member, id);
  if (!shoot) return jsonError(404, "That scene doesn't exist.");

  const raw = await db
    .select({ id: files.id, path: files.path, size: files.sizeBytes })
    .from(files)
    .where(and(eq(files.projectId, shoot.id), eq(files.status, "uploaded")))
    .orderBy(files.path);
  const proxies = await db
    .select({ id: proxyJobs.id, key: proxyJobs.proxyKey, size: proxyJobs.proxySizeBytes })
    .from(proxyJobs)
    .where(and(eq(proxyJobs.projectId, shoot.id), eq(proxyJobs.status, "done")))
    .orderBy(proxyJobs.proxyKey);

  const looks = await lutsUsedBy(db, shoot.id);
  const { done } = await sceneCuts(db, shoot.id);
  // Loupe's cut is what's paid for: only once the scene is unlocked (the footage itself is always theirs).
  const cut = done?.result && shoot.unlockedAt ? packageFiles(shoot.storagePrefix, done.result) : [];

  const inFolder = (key: string) => key.slice(shoot.storagePrefix.length + 1);
  return Response.json({
    folder: shoot.storagePrefix,
    files: [
      ...raw.map((f) => ({ kind: "raw" as const, id: f.id, path: f.path, size: f.size })),
      ...proxies.map((p) => ({ kind: "proxy" as const, id: p.id, path: inFolder(p.key), size: p.size ?? 0 })),
      ...looks.map((l) => ({ kind: "lut" as const, id: l.id, path: `LUTs/${lutFileName(l)}`, size: l.sizeBytes })),
      // The cut's files, numbered in the order they're listed (a newer version renumbers them; the download asks afresh).
      ...cut.map((f, i) => ({ kind: "cut" as const, id: i + 1, path: f.path, size: f.size })),
    ],
  });
});

const LinkRequest = z.object({ kind: z.enum(["raw", "proxy", "lut", "cut"]), id: z.number().int().positive() });

/** A fresh download link for one file, made at the moment it's needed. */
export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/downloads">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  if (!id || !(await ownedShoot(db, member, id))) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, LinkRequest);
  if (body instanceof Response) return body;
  if (body.kind === "lut") {
    const lut = (await lutsUsedBy(db, id)).find((l) => l.id === body.id);
    if (!lut) return jsonError(404, "That file isn't available.");
    return Response.json({ url: await signDownload(lut.storageKey) });
  }
  if (body.kind === "cut") {
    const [scene] = [await ownedShoot(db, member, id)];
    if (!scene?.unlockedAt) return jsonError(402, "Unlock this scene to export Loupe's cut.", "unlock-needed");
    const { done } = await sceneCuts(db, id);
    const file = scene && done?.result ? packageFiles(scene.storagePrefix, done.result)[body.id - 1] : undefined;
    if (!file) return jsonError(404, "That file isn't available.");
    return Response.json({ url: await signDownload(file.key) });
  }
  const [row] =
    body.kind === "raw"
      ? await db
          .select({ key: files.storageKey })
          .from(files)
          .where(and(eq(files.id, body.id), eq(files.projectId, id), eq(files.status, "uploaded")))
      : await db
          .select({ key: proxyJobs.proxyKey })
          .from(proxyJobs)
          .where(and(eq(proxyJobs.id, body.id), eq(proxyJobs.projectId, id), eq(proxyJobs.status, "done")));
  if (!row) return jsonError(404, "That file isn't available.");
  return Response.json({ url: await signDownload(row.key) });
});
