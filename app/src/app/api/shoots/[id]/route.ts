import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { setShootDp } from "@/lib/footage/shoots";
import { getShoot } from "@/lib/footage/status";
import { signView } from "@/lib/storage";

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]">) => {
  const member = await apiMember();
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const shoot = id ? await getShoot(getDb(), id, signView) : null;
  return shoot ? Response.json({ shoot }) : jsonError(404, "That shoot doesn't exist.");
});

const Change = z.object({
  // Who shot it; null or blank clears it.
  dpName: z.string().max(200).nullable(),
});

/** Changes the shoot's details. For now that's its DP. */
export const PATCH = route(async (request, ctx: RouteContext<"/api/shoots/[id]">) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const body = await readJson(request, Change);
  if (body instanceof Response) return body;
  const dpName = id ? await setShootDp(getDb(), id, body.dpName) : undefined;
  return dpName === undefined ? jsonError(404, "That shoot doesn't exist.") : Response.json({ dpName });
});
