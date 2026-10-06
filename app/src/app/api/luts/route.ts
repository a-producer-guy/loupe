import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { listLuts, lutFileName, lutNameFrom, MAX_LUT_BYTES } from "@/lib/footage/luts";
import { signUploadRequest } from "@/lib/storage";

/** The team's LUTs, and the one used most recently (the default for a new shoot). */
export const GET = route(async () => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  return Response.json(await listLuts(getDb()));
});

const StartUpload = z.object({ fileName: z.string().min(1).max(300), size: z.number().int().positive() });

/**
 * Step 1 of adding a LUT: a one-off link for the browser to upload the .cube
 * file straight to B2. Step 2 (/api/luts/confirm) checks it and adds it.
 */
export const POST = route(async (request) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const body = await readJson(request, StartUpload);
  if (body instanceof Response) return body;
  if (!/\.cube$/i.test(body.fileName)) return jsonError(400, "Pick a .cube LUT file (the kind Premiere, Resolve and camera makers export).");
  if (body.size > MAX_LUT_BYTES) return jsonError(400, "That LUT file is too big to be a LUT.");
  const key = `LUTs/${randomUUID()}/${lutFileName({ id: 0, name: lutNameFrom(body.fileName) })}`;
  return Response.json({ key, url: await signUploadRequest({ method: "PUT", key }) });
});
