import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { CutError } from "@/lib/footage/cuts";
import { sceneBilling, unlockScene } from "@/lib/billing";

// Unlocking a scene for export: what it takes (GET), and doing it (POST): free, one of the plan's scenes, or the
// address of Stripe's page to pay for it.

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/unlock">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  return Response.json({ billing: await sceneBilling(db, member.accountId, scene.id) });
});

export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/unlock">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  try {
    return Response.json(await unlockScene(db, { accountId: member.accountId, projectId: scene.id, sceneName: scene.name, email: member.email, origin: new URL(request.url).origin }));
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    throw error;
  }
});
