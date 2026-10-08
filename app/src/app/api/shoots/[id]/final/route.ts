import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { CutError } from "@/lib/footage/cuts";
import { requestFinal, requestTopaz, sceneFinals } from "@/lib/footage/finals";
import { signDownload } from "@/lib/storage";

// The final file of the scene's newest finished version (and its Topaz 4K version): how they're going, links to save
// them, and asking for them.

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/final">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  return Response.json({ final: await sceneFinals(db, scene.id, signDownload) });
});

export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/final">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  try {
    // { kind: "topaz" } for the 4K version; otherwise the final from the originals.
    const kind = ((await request.json().catch(() => ({}))) as { kind?: string }).kind;
    await (kind === "topaz" ? requestTopaz : requestFinal)(db, scene.id, member.email);
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    throw error;
  }
  return Response.json({ final: await sceneFinals(db, scene.id, signDownload) });
});
