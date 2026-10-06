import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { route } from "@/lib/api";
import { recentDps } from "@/lib/footage/shoots";

/** The DPs already typed in on shoots, most recent first: suggestions for the next one. */
export const GET = route(async () => {
  const member = await apiMember();
  if (member instanceof Response) return member;
  return Response.json({ dps: await recentDps(getDb()) });
});
