import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { ownedShoot } from "@/lib/footage/access";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { registerDrop } from "@/lib/footage/register";

const Drop = z.object({
  groups: z
    .array(
      z.object({
        name: z.string().max(255),
        files: z
          .array(z.object({ path: z.string().min(1).max(2000), size: z.number().int().min(0), lastModified: z.number() }))
          .max(20_000),
        unreadable: z.array(z.string().max(2000)).max(20_000).optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** Records a drop's files before they upload, and says which ones still need sending. */
export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/files">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  if (!(await ownedShoot(getDb(), member, id))) return jsonError(404, "That scene doesn't exist.");
  if (!id) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, Drop);
  if (body instanceof Response) return body;
  return Response.json({ groups: await registerDrop(getDb(), id, body.groups, member.email) });
});
