import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { stopCard } from "@/lib/footage/shoots";

export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/stop">) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  if (!id) return jsonError(404, "That shoot doesn't exist.");
  const body = await readJson(request, z.object({ card: z.string().max(255) }));
  if (body instanceof Response) return body;
  return Response.json({ removed: await stopCard(getDb(), id, body.card) });
});
