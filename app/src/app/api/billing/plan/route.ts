import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { CutError } from "@/lib/footage/cuts";
import { subscribe, stripeRefused } from "@/lib/billing";

// Choosing Pro or Studio: the address of Stripe's page to subscribe (or, already subscribed, to change the plan).

const Body = z.object({ plan: z.enum(["pro", "studio"]) });

export const POST = route(async (request) => {
  const member = await apiMember("owner");
  if (member instanceof Response) return member;
  const body = await readJson(request, Body);
  if (body instanceof Response) return body;
  try {
    return Response.json({ url: await subscribe(getDb(), { accountId: member.accountId, email: member.email, plan: body.plan, origin: new URL(request.url).origin }) });
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    const refused = stripeRefused(error);
    if (refused) return refused;
    throw error;
  }
});
