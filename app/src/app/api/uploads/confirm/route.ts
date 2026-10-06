import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { readJson, route } from "@/lib/api";
import { verifyUpload } from "@/lib/footage/verify";
import { storedSize } from "@/lib/storage";

/** Called when the browser finishes a file: checks B2's copy before counting it. */
export const POST = route(async (request) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const body = await readJson(request, z.object({ key: z.string().min(1).max(1100) }));
  if (body instanceof Response) return body;
  return Response.json(await verifyUpload(getDb(), body.key, member.email, storedSize));
});
