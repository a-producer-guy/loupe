import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { addLut, lutNameFrom, MAX_LUT_BYTES, parseCube } from "@/lib/footage/luts";
import { readText } from "@/lib/storage";

// Uploaded by /api/luts into this account's own folder: LUTs/a<account>/<random id>/<name>.cube
const Confirm = z.object({ key: z.string().regex(/^LUTs\/a\d+\/[0-9a-f-]{36}\/[^/]+\.cube$/i) });

/** Step 2 of adding a LUT: check the uploaded file really is a LUT FFmpeg can apply, then add it. */
export const POST = route(async (request) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const body = await readJson(request, Confirm);
  if (body instanceof Response) return body;
  if (!body.key.startsWith(`LUTs/a${member.accountId}/`)) return jsonError(404, "That LUT upload isn't yours.");
  const text = await readText(body.key, MAX_LUT_BYTES);
  if (text === null) return jsonError(400, "The LUT didn't finish uploading. Try again.");
  const cube = parseCube(text);
  const fileName = body.key.split("/").pop()!;
  const lut = await addLut(getDb(), {
    accountId: member.accountId,
    name: lutNameFrom(fileName),
    storageKey: body.key,
    sizeBytes: Buffer.byteLength(text),
    cubeSize: cube.size,
    createdBy: member.email,
  });
  return Response.json({ lut });
});


