import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { ownedShoot } from "@/lib/footage/access";
import { addNote, CutError } from "@/lib/footage/cuts";
import { markNote, sceneLink, sceneNotes, shareScene, unshareScene, watchPath } from "@/lib/footage/share";

// Sharing a scene: its watch link (on or off), and the notes viewers left, which someone on the scene passes on to
// Loupe or puts aside.

const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const GET = route(async (_request, ctx: RouteContext<"/api/shoots/[id]/share">) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  const link = await sceneLink(db, scene.id);
  return Response.json({ share: { path: link ? watchPath(link.token) : null, notes: await sceneNotes(db, scene.id) } });
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("on") }),
  z.object({ action: z.literal("off") }),
  z.object({ action: z.literal("send"), id: z.number().int().positive() }),
  z.object({ action: z.literal("done"), id: z.number().int().positive() }),
]);

export const POST = route(async (request, ctx: RouteContext<"/api/shoots/[id]/share">) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const db = getDb();
  const scene = await ownedShoot(db, member, await shootIdFrom(ctx.params));
  if (!scene) return jsonError(404, "That scene doesn't exist.");
  const body = await readJson(request, Body);
  if (body instanceof Response) return body;
  if (body.action === "on") return Response.json({ path: watchPath(await shareScene(db, scene.id, member.email)) });
  if (body.action === "off") {
    await unshareScene(db, scene.id, member.email);
    return Response.json({ path: null });
  }
  const note = (await sceneNotes(db, scene.id)).find((n) => n.id === body.id);
  if (!note) return jsonError(404, "That note isn't there any more.");
  if (body.action === "send") {
    try {
      // Passed on in the viewer's own words, with who and where.
      await addNote(db, scene.id, member.email, note.note, `${note.name}'s note, at ${tc(note.at)} in the cut`);
    } catch (error) {
      if (error instanceof CutError) return jsonError(error.status, error.message);
      throw error;
    }
  }
  return Response.json({ note: await markNote(db, scene.id, note.id, body.action === "send" ? "sent" : "done") });
});
