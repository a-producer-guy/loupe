import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { accountPlan, accountUsage, ownedLut, PLAN_LIMITS, WAITING_FULL } from "@/lib/footage/access";
import { createShoot } from "@/lib/footage/shoots";
import { lutFileName } from "@/lib/footage/luts";
import { listShoots, searchShoots } from "@/lib/footage/status";
import { copyObject, signView } from "@/lib/storage";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The account's scenes between ?from and ?to (YYYY-MM-DD), the last year by default. With ?q=,
 * every scene in the account from any date whose name or date matches.
 */
export const GET = route(async (request) => {
  const member = await apiMember();
  if (member instanceof Response) return member;
  const params = new URL(request.url).searchParams;
  const q = params.get("q");
  const db = getDb();
  if (q !== null) return Response.json({ shoots: await searchShoots(db, member.accountId, q.slice(0, 100), signView) });
  const from = params.get("from") ?? dayOffset(-365);
  const to = params.get("to") ?? dayOffset(30);
  if (!DAY.test(from) || !DAY.test(to)) return jsonError(400, "Dates must look like 2026-09-23.");
  return Response.json({ shoots: await listShoots(db, member.accountId, from, to, signView) });
});

const NewScene = z.object({
  name: z.string().max(200),
  shootDate: z.string().regex(DAY),
  // The LUT the scene was filmed with, if known.
  lutId: z.number().int().positive().nullable().optional(),
});

export const POST = route(async (request) => {
  const member = await apiMember("write");
  if (member instanceof Response) return member;
  const body = await readJson(request, NewScene);
  if (body instanceof Response) return body;
  const db = getDb();

  // Pay-as-you-go accounts keep a few scenes waiting to be exported at once (Pro and Studio aren't capped).
  const limit = PLAN_LIMITS[await accountPlan(db, member.accountId)].scenes;
  if ((await accountUsage(db, member.accountId)).scenes >= limit) {
    return jsonError(402, WAITING_FULL, "plan-needed");
  }

  const lut = body.lutId ? await ownedLut(db, member, body.lutId) : null;
  if (body.lutId && !lut) return jsonError(404, "That LUT doesn't exist.");
  const shoot = await createShoot(db, { ...body, accountId: member.accountId, lutId: lut?.id ?? null, createdBy: member.email });
  if (lut) {
    await copyObject(lut.storageKey, `${shoot.storagePrefix}/LUTs/${lutFileName(lut)}`).catch((error) =>
      console.error("Couldn't copy the LUT into the scene's folder:", error),
    );
  }
  return Response.json({ shoot }, { status: 201 });
});
