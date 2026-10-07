import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { ownedFileByKey } from "@/lib/footage/access";
import { readSceneScript } from "@/lib/footage/scripts";
import { verifyUpload } from "@/lib/footage/verify";
import { readBytes, storedSize } from "@/lib/storage";

/** Called when the browser finishes a file: checks B2's copy before counting it. */
export const POST = route(async (request) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const body = await readJson(request, z.object({ key: z.string().min(1).max(1100) }));
  if (body instanceof Response) return body;
  const db = getDb();
  const file = await ownedFileByKey(db, member, body.key);
  if (!file) return jsonError(404, "This file isn't part of a scene any more.", "gone");
  const result = await verifyUpload(db, body.key, member.email, storedSize);
  // The scene's script, if this was it (a Final Draft file or PDF in the folder): read now, for the cut.
  // A file that can't be read as a script, or a hiccup reading it, never fails the upload.
  if (result.ok) await readSceneScript(db, readBytes, { ...file, uploadedBy: member.email }).catch(() => null);
  return Response.json(result);
});
