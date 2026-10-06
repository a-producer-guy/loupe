import { and, eq } from "drizzle-orm";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { ownedShoot } from "@/lib/footage/access";
import { proxyJobs } from "@/lib/db/schema";
import { jsonError, route, shootIdFrom } from "@/lib/api";
import { previewKey } from "@/lib/footage/names";
import { signDownload } from "@/lib/storage";

/** A fresh link to play one clip's web preview in the browser (?job=<proxy job id>). */
export const GET = route(async (request, ctx: RouteContext<"/api/shoots/[id]/play">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  if (!(await ownedShoot(getDb(), member, id))) return jsonError(404, "That scene doesn't exist.");
  const job = Number(new URL(request.url).searchParams.get("job"));
  if (!id || !Number.isSafeInteger(job) || job <= 0) return jsonError(404, "That clip doesn't exist.");
  const [row] = await getDb()
    .select({ key: proxyJobs.proxyKey, preview: proxyJobs.previewSizeBytes })
    .from(proxyJobs)
    .where(and(eq(proxyJobs.id, job), eq(proxyJobs.projectId, id)));
  if (!row || row.preview === null) return jsonError(404, "This clip has no web preview yet.");
  return Response.json({ url: await signDownload(previewKey(row.key)) });
});
