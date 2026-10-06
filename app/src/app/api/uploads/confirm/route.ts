import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { ownedFileByKey } from "@/lib/footage/access";
import { verifyUpload } from "@/lib/footage/verify";
import { storedSize } from "@/lib/storage";

/** Called when the browser finishes a file: checks B2's copy before counting it. */
export const POST = route(async (request) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const body = await readJson(request, z.object({ key: z.string().min(1).max(1100) }));
  if (body instanceof Response) return body;
  const db = getDb();
  if (!(await ownedFileByKey(db, member, body.key))) return jsonError(404, "This file isn't part of a scene any more.", "gone");
  return Response.json(await verifyUpload(db, body.key, member.email, storedSize));
});
