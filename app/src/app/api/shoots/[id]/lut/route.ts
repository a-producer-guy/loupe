import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { jsonError, readJson, route, shootIdFrom } from "@/lib/api";
import { getLut, lutFileName, setCardLut, setShootLut } from "@/lib/footage/luts";
import { copyObject } from "@/lib/storage";

const Choice = z.object({
  lutId: z.number().int().positive().nullable(),
  // Without a card, it's the shoot's LUT. With one, that card's own.
  card: z.string().max(300).optional(),
  // Put the card back on the shoot's LUT.
  sameAsShoot: z.boolean().optional(),
});

/** Sets the LUT a shoot, or one of its cards, was filmed with. Proxies already made are re-made with it. */
export const PUT = route(async (request, ctx: RouteContext<"/api/shoots/[id]/lut">) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const id = await shootIdFrom(ctx.params);
  const db = getDb();
  const [shoot] = id ? await db.select().from(projects).where(eq(projects.id, id)) : [];
  if (!shoot) return jsonError(404, "That shoot doesn't exist.");
  const body = await readJson(request, Choice);
  if (body instanceof Response) return body;
  const lut = body.lutId === null ? null : await getLut(db, body.lutId);
  if (body.lutId !== null && !lut) return jsonError(404, "That LUT doesn't exist.");

  const remade =
    body.card === undefined
      ? await setShootLut(db, shoot.id, body.lutId)
      : await setCardLut(db, shoot.id, body.card, body.sameAsShoot ? "shoot" : { lutId: body.lutId });

  // A copy of the LUT sits with the footage, so an editor has it for the originals.
  if (lut && !body.sameAsShoot) {
    await copyObject(lut.storageKey, `${shoot.storagePrefix}/LUTs/${lutFileName(lut)}`).catch((error) =>
      console.error("Couldn't copy the LUT into the shoot's folder:", error),
    );
  }
  return Response.json({ remade });
});
