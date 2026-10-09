import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { CutError } from "@/lib/footage/cuts";
import { redoVersion, removeChange, restoreVersion, sceneVersions, undoVersion } from "@/lib/footage/versions";
import { signView } from "@/lib/storage";
import { finishForExport } from "@/lib/billing";

// A scene's versions: the list (each named by what changed), what's in the current cut, and going back, undo/redo,
// or taking one change out.

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/versions">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  return Response.json(await sceneVersions(db, scene.id, scene.storagePrefix, signView));
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restore"), id: z.number().int().positive() }),
  z.object({ action: z.literal("undo") }),
  z.object({ action: z.literal("redo") }),
  z.object({ action: z.literal("remove"), key: z.string().min(1).max(600) }),
]);

export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/versions">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, Body);
  if (body instanceof Response) return body;
  try {
    if (body.action === "remove") {
      await removeChange(db, scene.id, body.key, member.email);
      return Response.json({ instant: false });
    }
    const back =
      body.action === "undo" ? await undoVersion(db, scene.id, member.email) : body.action === "redo" ? await redoVersion(db, scene.id, member.email) : await restoreVersion(db, scene.id, body.id, member.email);
    // Back to a free preview on a scene that's paid for: its studio sound is made for the export.
    if (scene.unlockedAt) await finishForExport(db, scene.id, member.email);
    return Response.json(back);
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    throw error;
  }
});
