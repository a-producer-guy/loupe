import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { renameShoot } from "@/lib/footage/shoots";
import { getShoot } from "@/lib/footage/status";
import { signView } from "@/lib/storage";

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]">) => {
  const member = await apiMember();
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  if (!(await ownedShoot(db, member, id))) return jsonError(404, "That scene doesn't exist.");
  const shoot = await getShoot(db, id!, signView);
  return shoot ? Response.json({ shoot }) : jsonError(404, "That scene doesn't exist.");
});

const Change = z.object({ name: z.string().max(200) });

/** Renames the scene. Its files stay where they are. */
export const PATCH = route(async (request, ctx: RouteContext<"/api/shoots/[id]">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  if (!(await ownedShoot(db, member, id))) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, Change);
  if (body instanceof Response) return body;
  return Response.json({ name: await renameShoot(db, id!, body.name) });
});
