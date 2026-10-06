import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { ownedShoot } from "@/lib/footage/access";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { retryProxies } from "@/lib/footage/shoots";

/** Retry one failed proxy ({ jobId }) or every failed proxy in the shoot ({}). */
export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/retry">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  if (!(await ownedShoot(getDb(), member, id))) return jsonError(404, "That scene doesn't exist.");
  if (!id) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, z.object({ jobId: z.number().int().positive().optional() }));
  if (body instanceof Response) return body;
  return Response.json({ retried: await retryProxies(getDb(), id, body.jobId) });
});
