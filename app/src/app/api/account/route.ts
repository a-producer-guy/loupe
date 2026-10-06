import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { jsonError, readJson, route } from "@/lib/api";

const Change = z.object({ name: z.string().max(80) });

/** Renames the account (the studio or filmmaker's name). Owners only. */
export const PATCH = route(async (request) => {
  const member = await apiMember("owner");
  if (member instanceof Response) return member;
  const body = await readJson(request, Change);
  if (body instanceof Response) return body;
  const name = body.name.trim().replace(/\s+/g, " ");
  if (!name) return jsonError(400, "Give the account a name, like your studio's.");
  const [row] = await getDb().update(accounts).set({ name }).where(eq(accounts.id, member.accountId)).returning({ name: accounts.name });
  return Response.json({ name: row.name });
});
