import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { CutError, requestCut, sceneCuts } from "@/lib/footage/cuts";
import { addScript, MAX_SCRIPT_BYTES, parseScript, ScriptError } from "@/lib/footage/scripts";
import { putObject } from "@/lib/storage";

/**
 * Adds the scene's script on its own (when it wasn't in the folder): the Final Draft file or its PDF. If the scene
 * already has a cut, Loupe makes it again with the script; if not, the first cut uses it.
 */
export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/script">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  const scene = id ? await ownedShoot(db, member, id) : null;
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return jsonError(400, "Add the scene's Final Draft file (.fdx) or a PDF of it.");
  if (file.size > MAX_SCRIPT_BYTES) return jsonError(400, "That file is too big for a scene's script.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const parsed = await parseScript(bytes, file.name);
    const script = await addScript(db, putObject, { name: file.name, bytes }, parsed, { accountId: member.accountId, projectId: scene.id, by: member.email });
    const { done, latest } = await sceneCuts(db, scene.id);
    const busy = latest && (latest.status === "waiting" || latest.status === "working");
    if (done && !busy) await requestCut(db, scene.id, member.email, { scriptId: script.id }).catch((e) => (e instanceof CutError ? null : Promise.reject(e)));
    return Response.json({ script });
  } catch (error) {
    if (error instanceof ScriptError) return jsonError(400, error.message);
    throw error;
  }
});
