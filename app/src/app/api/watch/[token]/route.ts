import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { addViewerNote, MAX_VIEWER_NAME, MAX_VIEWER_NOTE, NoteError, watchState } from "@/lib/footage/share";
import { signView } from "@/lib/storage";

// A share link, for anyone who has it (no sign-in): the cut to watch and the notes left on it, and leaving one.
// Nothing here can change the cut.

export const GET = route(async (_request, ctx: RouteContext<"/api/watch/[token]">) => {
  const state = await watchState(getDb(), (await ctx.params).token, signView);
  if (!state) return jsonError(404, "This link doesn't work any more. Ask for a new one.");
  return Response.json({ watch: state });
});

const Note = z.object({ name: z.string().min(1).max(MAX_VIEWER_NAME * 2), at: z.number().min(0).max(36_000), note: z.string().min(1).max(MAX_VIEWER_NOTE * 2), cutId: z.number().int().positive().nullable() });

export const POST = route(async (request, ctx: RouteContext<"/api/watch/[token]">) => {
  const body = await readJson(request, Note);
  if (body instanceof Response) return body;
  try {
    const note = await addViewerNote(getDb(), (await ctx.params).token, body);
    if (!note) return jsonError(404, "This link doesn't work any more. Ask for a new one.");
    return Response.json({ note });
  } catch (error) {
    if (error instanceof NoteError) return jsonError(400, error.message);
    throw error;
  }
});
