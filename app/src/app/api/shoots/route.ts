import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { createShoot } from "@/lib/footage/shoots";
import { getLut, lutFileName } from "@/lib/footage/luts";
import { listShoots, searchShoots } from "@/lib/footage/status";
import { copyObject, signView } from "@/lib/storage";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Shoots between ?from and ?to (YYYY-MM-DD), a month either side of today by
 * default. With ?q=, every shoot from any date whose name or date matches.
 */
export const GET = route(async (request) => {
  const member = await apiMember();
  if (member instanceof Response) return member;
  const params = new URL(request.url).searchParams;
  const q = params.get("q");
  if (q !== null) return Response.json({ shoots: await searchShoots(getDb(), q.slice(0, 100), signView) });
  const from = params.get("from") ?? dayOffset(-30);
  const to = params.get("to") ?? dayOffset(30);
  if (!DAY.test(from) || !DAY.test(to)) return jsonError(400, "Dates must look like 2026-09-23.");
  return Response.json({ shoots: await listShoots(getDb(), from, to, signView) });
});

const NewShoot = z.object({
  name: z.string().max(200),
  shootDate: z.string().regex(DAY),
  // The LUT the shoot is filmed with, if the DP knows it already.
  lutId: z.number().int().positive().nullable().optional(),
  // Who's shooting it, if known.
  dpName: z.string().max(200).nullable().optional(),
});

export const POST = route(async (request) => {
  const member = await apiMember("admin");
  if (member instanceof Response) return member;
  const body = await readJson(request, NewShoot);
  if (body instanceof Response) return body;
  const db = getDb();
  const lut = body.lutId ? await getLut(db, body.lutId) : null;
  if (body.lutId && !lut) return jsonError(404, "That LUT doesn't exist.");
  const shoot = await createShoot(db, { ...body, lutId: lut?.id ?? null, createdBy: member.email });
  if (lut) {
    await copyObject(lut.storageKey, `${shoot.storagePrefix}/LUTs/${lutFileName(lut)}`).catch((error) =>
      console.error("Couldn't copy the LUT into the shoot's folder:", error),
    );
  }
  return Response.json({ shoot }, { status: 201 });
});
