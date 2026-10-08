import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { CutError } from "@/lib/footage/cuts";
import { requestFinal, sceneFinals } from "@/lib/footage/finals";
import { signDownload } from "@/lib/storage";

// The final file of the scene's newest finished version: how it's going, a link to save it, and asking for it.

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/final">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  return Response.json({ final: await sceneFinals(db, scene.id, signDownload) });
});

export const POST = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/final">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  try {
    await requestFinal(db, scene.id, member.email);
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    throw error;
  }
  return Response.json({ final: await sceneFinals(db, scene.id, signDownload) });
});
