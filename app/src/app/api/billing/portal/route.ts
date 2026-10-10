import { apiMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { jsonError, route } from "@/lib/api";
import { CutError } from "@/lib/footage/cuts";
import { billingPortal, stripeRefused } from "@/lib/billing";

// Stripe's billing page for the account: card, invoices, switching or cancelling the plan.

export const POST = route(async (request) => {
  const member = await apiMember("owner");
  if (member instanceof Response) return member;
  try {
    return Response.json({ url: await billingPortal(getDb(), { accountId: member.accountId, email: member.email, origin: new URL(request.url).origin }) });
  } catch (error) {
    if (error instanceof CutError) return jsonError(error.status, error.message);
    const refused = stripeRefused(error);
    if (refused) return refused;
    throw error;
  }
});
