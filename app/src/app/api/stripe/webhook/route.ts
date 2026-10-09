import { getDb } from "@/lib/db/client";
import { handleEvent } from "@/lib/billing";

// Stripe's webhook: payments and subscription changes. Only the event's id is taken from the request; the event
// itself is fetched back from Stripe with Loupe's key, so a made-up request can't unlock anything.

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" && /^evt_[A-Za-z0-9]+$/.test(body.id) ? body.id : null;
  if (!id) return new Response("Not a Stripe event", { status: 400 });
  try {
    await handleEvent(getDb(), id);
  } catch (error) {
    console.error(`Stripe event ${id}:`, error);
    // Stripe tries again later.
    return new Response("Couldn't handle it", { status: 500 });
  }
  return Response.json({ received: true });
}
