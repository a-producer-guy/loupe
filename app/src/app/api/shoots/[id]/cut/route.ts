import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { addNote, CutError, MAX_NOTE, pickTake, requestCut, setExtra } from "@/lib/footage/cuts";
import { roomCut } from "@/lib/footage/room";

// A scene's cut: GET is everything the cutting room shows (and starts the first cut once it's due); POST directs it.

/** The cut's state, plus each take's still and playable preview (Other takes), and the script's scene heading. */
export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/cut">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  const scene = id ? await ownedShoot(db, member, id) : null;
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  return Response.json({ cut: await roomCut(db, scene, member.email, member.accountId) });
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("note"), note: z.string().min(1).max(MAX_NOTE), scope: z.string().max(200).nullish() }),
  z.object({ action: z.literal("pick"), line: z.number().int().min(0), take: z.string().min(1).max(80) }),
  z.object({ action: z.literal("extra"), extra: z.enum(["establishing", "ambience", "score"]), on: z.boolean() }),
  z.object({ action: z.literal("lead"), role: z.string().min(1).max(80).nullable() }),
  z.object({ action: z.literal("again") }),
]);

/** Directs the cut: a note to Loupe, a take for a line, an extra on or off, whose scene it is, or make it again. */
export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/cut">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  const scene = id ? await ownedShoot(db, member, id) : null;
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, Body);
  if (body instanceof Response) return body;
  try {
    const cut =
      body.action === "note"
        ? await addNote(db, scene.id, member.email, body.note, body.scope)
        : body.action === "pick"
          ? await pickTake(db, scene.id, member.email, body.line, body.take)
          : body.action === "extra"
            ? await setExtra(db, scene.id, member.email, body.extra, body.on)
            : body.action === "lead"
              ? await requestCut(db, scene.id, member.email, { leadRole: body.role })
              : await requestCut(db, scene.id, member.email);
    return Response.json({ cut });
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    throw error;
  }
});
