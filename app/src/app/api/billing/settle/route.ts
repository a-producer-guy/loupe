import { z } from "zod";
import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, readJson, route } from "@/lib/api";
import { settleSession, stripe } from "@/lib/billing";

// Back from Stripe's payment page: the payment is checked with Stripe and what it bought is given straight away, so
// nobody waits for Stripe's webhook (which does the same, whichever comes first).

const Body = z.object({ session: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/) });

export const POST = route(async (request) => {
  const member = await apiMember("read");
  if (member instanceof Response) return member;
  const body = await readJson(request, Body);
  if (body instanceof Response) return body;
  const session = await stripe().checkout.sessions.retrieve(body.session).catch(() => null);
  // Only the account's own payments.
  if (!session || session.metadata?.accountId !== String(member.accountId)) return jsonError(404, "That payment isn't yours.");
  return Response.json(await settleSession(getDb(), session.id));
});
