import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { jsonError, readJson, route } from "@/lib/api";
import { signUploadRequest, type UploadRequest } from "@/lib/storage";

// The browser uploads straight to B2, but every single step (start, each
// part, finish) needs a link signed here first. Only files already recorded
// for a shoot can be signed, only until they're safely uploaded, and nothing
// can ever be deleted this way.

const SignRequest = z.object({
  method: z.enum(["PUT", "POST", "GET", "DELETE"]),
  key: z.string().min(1).max(1100),
  uploadId: z.string().min(1).max(1024).optional(),
  partNumber: z.number().int().min(1).max(10_000).optional(),
});

export const POST = route(async (request) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const body = await readJson(request, SignRequest);
  if (body instanceof Response) return body;
  if (body.method === "DELETE") return jsonError(403, "Deleting from storage is turned off.", "no-delete");

  const db = getDb();
  const [file] = await db
    .select({ id: files.id, status: files.status, uploadId: files.uploadId })
    .from(files)
    .where(eq(files.storageKey, body.key));
  if (!file) return jsonError(404, "This file isn't part of a shoot any more.", "gone");
  if (file.status === "uploaded") return jsonError(409, "This file is already uploaded.", "already-uploaded");
  if (file.status === "unreadable") return jsonError(409, "This file couldn't be read from the card.", "unreadable");

  const { method, key, uploadId, partNumber } = body;
  let step: UploadRequest;
  if (method === "PUT" && uploadId && partNumber) step = { method, key, uploadId, partNumber };
  else if (method === "PUT" && !uploadId && !partNumber) step = { method, key };
  else if (method === "GET" && uploadId) step = { method, key, uploadId };
  else if (method === "POST") step = uploadId ? { method, key, uploadId } : { method, key };
  else return jsonError(400, "That upload step isn't supported.");

  // Remember the multipart upload, so dropping the card again can resume it.
  if (file.status === "pending" || (uploadId && uploadId !== file.uploadId)) {
    await db
      .update(files)
      .set({ status: "uploading", ...(uploadId ? { uploadId } : {}) })
      .where(eq(files.id, file.id));
  }
  return Response.json({ url: await signUploadRequest(step) });
});
