import Stripe from "stripe";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { accounts, payments, projects, type Plan } from "@/lib/db/schema";
import { CutError, requestCut, sceneCuts } from "@/lib/footage/cuts";
import { depositSale } from "@/lib/fund";
import { requestTopaz, topazPrice } from "@/lib/footage/finals";

// Payments (Guy, Oct 9: "so we can actually charge people"). Loupe never sees a card: every payment happens on
// Stripe's own page (Checkout), and changing a card or cancelling on Stripe's billing page (the customer portal).
//
// Exporting is what's paid for: cutting and directing are free, exporting never is (Guy, Oct 9). A scene is unlocked
// for export once: Pro and Studio include scenes each month (10 and 60); every other scene is paid for on its own
// ($39, or $25 on Studio).
// Topaz 4K is paid for when it's asked for. Stripe tells us a payment went through two ways, whichever comes first:
// the person coming back from Stripe's page, and Stripe's webhook. Both run the same idempotent code, which checks
// with Stripe itself, so nothing is unlocked on someone's word.

export class BillingError extends CutError {}

let client: Stripe | null = null;
let portalConfig: Promise<string | null> | null = null;

/** Tests only: a stand-in for Stripe. */
export function setStripeForTests(fake: unknown): void {
  client = fake as Stripe;
  portalConfig = null;
}

/** Stripe, with Loupe's secret key (server only). */
export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingError("Payments aren't switched on yet. Try again soon.", 503);
  client = new Stripe(key, { appInfo: { name: "Loupe", url: "https://editloupe.com" } });
  return client;
}

/** Scenes a month that come with a plan, and what each one after that costs (in cents). */
export const PLAN_SCENES: Record<"pro" | "studio", number> = { pro: 10, studio: 60 };
export const SCENE_PRICE = 3900;
export const STUDIO_SCENE_PRICE = 2500;
/** The monthly prices, found by these names in Stripe (scripts/setup-stripe.mjs makes them). */
export const PLAN_LOOKUP: Record<"pro" | "studio", string> = { pro: "loupe_pro_monthly", studio: "loupe_studio_monthly" };

const LIVE = new Set(["active", "trialing", "past_due"]);
type Account = typeof accounts.$inferSelect;

/** Pro or Studio with a subscription that's live (a failed renewal keeps its scenes while Stripe retries). */
function subscribed(account: Account): "pro" | "studio" | null {
  if ((account.plan === "pro" || account.plan === "studio") && account.subscriptionStatus && LIVE.has(account.subscriptionStatus)) return account.plan;
  return null;
}

async function accountOf(db: Db, accountId: number): Promise<Account> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new BillingError("That account doesn't exist.", 404);
  return account;
}

/** The account's Stripe customer, made the first time it pays for anything. */
async function customerOf(db: Db, account: Account, email: string): Promise<string> {
  if (account.stripeCustomerId) return account.stripeCustomerId;
  const customer = await stripe().customers.create({ email, name: account.name, metadata: { accountId: String(account.id) } });
  const [saved] = await db
    .update(accounts)
    .set({ stripeCustomerId: customer.id })
    .where(and(eq(accounts.id, account.id), isNull(accounts.stripeCustomerId)))
    .returning({ id: accounts.stripeCustomerId });
  if (saved?.id) return saved.id;
  // Made by another request at the same moment: theirs is the customer.
  return (await accountOf(db, account.id)).stripeCustomerId!;
}

export type Unlock = { unlocked: true; how: "plan" | "paid" } | { unlocked: false; url: string };

export type SceneBilling = {
  unlocked: boolean;
  /** How the next unlock goes: included (in the plan's month), or the price to pay, in cents. */
  next: { kind: "plan"; left: number; plan: "pro" | "studio" } | { kind: "pay"; cents: number };
};

/** What exporting this scene takes: nothing (unlocked), one of the plan's scenes, or a price. */
export async function sceneBilling(db: Db, accountId: number, projectId: number): Promise<SceneBilling> {
  const [scene] = await db.select({ unlockedAt: projects.unlockedAt }).from(projects).where(eq(projects.id, projectId));
  const account = await accountOf(db, accountId);
  return { unlocked: Boolean(scene?.unlockedAt), next: await nextUnlock(db, account) };
}

async function nextUnlock(db: Db, account: Account): Promise<SceneBilling["next"]> {
  const plan = subscribed(account);
  if (plan) {
    const used = await planScenesUsed(db, account);
    if (used < PLAN_SCENES[plan]) return { kind: "plan", left: PLAN_SCENES[plan] - used, plan };
    return { kind: "pay", cents: plan === "studio" ? STUDIO_SCENE_PRICE : SCENE_PRICE };
  }
  return { kind: "pay", cents: SCENE_PRICE };
}

/** Scenes unlocked with the plan in its current month. */
async function planScenesUsed(db: Db, account: Account): Promise<number> {
  const since = account.periodStart ?? new Date(0);
  const [{ n }] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.accountId, account.id), eq(projects.unlockedHow, "plan"), gte(projects.unlockedAt, since)));
  return n;
}

async function markUnlocked(db: Db, projectId: number, how: "plan" | "paid"): Promise<boolean> {
  const [row] = await db
    .update(projects)
    .set({ unlockedAt: new Date(), unlockedHow: how })
    .where(and(eq(projects.id, projectId), isNull(projects.unlockedAt)))
    .returning({ id: projects.id });
  return Boolean(row);
}

/**
 * Unlocks a scene for export: one of the plan's scenes, or a Stripe payment page to pay for it (unlocked when Stripe
 * confirms). `origin` is where to come back to.
 */
export async function unlockScene(db: Db, input: { accountId: number; projectId: number; sceneName: string; email: string; origin: string }): Promise<Unlock> {
  const [scene] = await db.select({ unlockedAt: projects.unlockedAt, unlockedHow: projects.unlockedHow }).from(projects).where(eq(projects.id, input.projectId));
  if (!scene) throw new BillingError("That scene doesn't exist.", 404);
  if (scene.unlockedAt) return { unlocked: true, how: scene.unlockedHow === "plan" ? "plan" : "paid" };
  // Paying can come before the cut is made (to skip the line for a free cut), not before it's asked for.
  const { latest } = await sceneCuts(db, input.projectId);
  if (!latest) throw new BillingError("Loupe hasn't started on this scene yet. You can pay once the footage is in.");

  const account = await accountOf(db, input.accountId);
  const next = await nextUnlock(db, account);
  if (next.kind === "plan") {
    if (await markUnlocked(db, input.projectId, "plan")) await finishForExport(db, input.projectId, input.email);
    return { unlocked: true, how: "plan" };
  }
  const cents = next.cents;
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer: await customerOf(db, account, input.email),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: { name: `Export: ${input.sceneName}`, description: "The final file, and the timeline for Premiere Pro and DaVinci Resolve." },
        },
      },
    ],
    metadata: { kind: "scene", accountId: String(input.accountId), projectId: String(input.projectId) },
    payment_intent_data: { metadata: { kind: "scene", projectId: String(input.projectId) } },
    success_url: `${input.origin}/scenes/${input.projectId}?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/scenes/${input.projectId}`,
  });
  await db.insert(payments).values({ accountId: input.accountId, projectId: input.projectId, kind: "scene", amountCents: cents, stripeSessionId: session.id, createdBy: input.email });
  return { unlocked: false, url: session.url! };
}

/** Topaz 4K of the scene's newest version: Stripe's page to pay for it; Loupe starts it once Stripe confirms. */
export async function payForTopaz(db: Db, input: { accountId: number; projectId: number; sceneName: string; email: string; origin: string }): Promise<{ url: string } | { started: true }> {
  const { done } = await sceneCuts(db, input.projectId);
  if (!done?.result) throw new BillingError("There's no cut to make 4K yet.");
  // Already paid for this version (a failed try is made again for free).
  const [paid] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.projectId, input.projectId), eq(payments.cutId, done.id), eq(payments.kind, "topaz"), eq(payments.status, "paid")));
  if (paid) {
    await requestTopaz(db, input.projectId, input.email);
    return { started: true };
  }
  // Checked before paying, so nobody pays for something that can't start.
  await requestTopaz(db, input.projectId, input.email, { check: true });
  const account = await accountOf(db, input.accountId);
  const cents = topazPrice(done.result.seconds);
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer: await customerOf(db, account, input.email),
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: cents, product_data: { name: `4K with Topaz: ${input.sceneName}`, description: "The final file, made 4K with Topaz." } },
      },
    ],
    metadata: { kind: "topaz", accountId: String(input.accountId), projectId: String(input.projectId), cutId: String(done.id) },
    payment_intent_data: { metadata: { kind: "topaz", projectId: String(input.projectId) } },
    success_url: `${input.origin}/scenes/${input.projectId}?paid={CHECKOUT_SESSION_ID}&export=1`,
    cancel_url: `${input.origin}/scenes/${input.projectId}?export=1`,
  });
  await db.insert(payments).values({ accountId: input.accountId, projectId: input.projectId, cutId: done.id, kind: "topaz", amountCents: cents, stripeSessionId: session.id, createdBy: input.email });
  return { url: session.url! };
}

/**
 * A Checkout session Stripe says is complete: the payment is recorded and what it bought is given, once. Safe to
 * run any number of times, from the webhook and from the person coming back. Always fetched from Stripe first.
 */
export async function settleSession(db: Db, sessionId: string): Promise<{ kind: string | null; projectId: number | null; paid: boolean }> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const kind = session.metadata?.kind ?? null;
  if (session.mode === "subscription") {
    if (session.subscription) await syncSubscription(db, typeof session.subscription === "string" ? await stripe().subscriptions.retrieve(session.subscription) : session.subscription);
    return { kind: "plan", projectId: null, paid: session.status === "complete" };
  }
  const projectId = Number(session.metadata?.projectId) || null;
  if (session.status === "expired") {
    await db.update(payments).set({ status: "expired" }).where(and(eq(payments.stripeSessionId, session.id), eq(payments.status, "pending")));
    return { kind, projectId, paid: false };
  }
  if (session.payment_status !== "paid") return { kind, projectId, paid: false };
  const [row] = await db
    .update(payments)
    .set({ status: "paid", paidAt: new Date(), stripePaymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null) })
    .where(and(eq(payments.stripeSessionId, session.id), sql`${payments.status} <> 'paid'`))
    .returning();
  // Given once, by whichever arrives first: the scene, and half of what it brought in to the free-cutting fund.
  if (row?.kind === "scene") {
    await markUnlocked(db, row.projectId, "paid");
    await depositSale(db, { cents: row.amountCents, ref: `payment:${row.id}`, kind: "sale", accountId: row.accountId, projectId: row.projectId });
    await finishForExport(db, row.projectId, row.createdBy ?? "stripe");
  }
  if (row?.kind === "topaz") {
    await requestTopaz(db, row.projectId, row.createdBy ?? "stripe").catch((error) => {
      // Paid, but it can't start (the version changed?): it stays paid, and "Make it 4K" starts it without paying again.
      console.error(`Topaz paid (payment ${row.id}) but couldn't start:`, error);
    });
  }
  return { kind, projectId, paid: true };
}

/** Pro or Studio: Stripe's page to subscribe, or (already subscribed) Stripe's billing page to change it. */
export async function subscribe(db: Db, input: { accountId: number; email: string; plan: "pro" | "studio"; origin: string }): Promise<string> {
  const account = await accountOf(db, input.accountId);
  if (subscribed(account)) return billingPortal(db, { accountId: input.accountId, email: input.email, origin: input.origin });
  const prices = await stripe().prices.list({ lookup_keys: [PLAN_LOOKUP[input.plan]], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) throw new BillingError("That plan isn't on sale yet. Try again soon.", 503);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: await customerOf(db, account, input.email),
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { kind: "plan", accountId: String(input.accountId), plan: input.plan },
    subscription_data: { metadata: { accountId: String(input.accountId), plan: input.plan } },
    success_url: `${input.origin}/plan?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/plan`,
  });
  return session.url!;
}

/** Stripe's billing page: change card, see invoices, switch or cancel the plan. */
export async function billingPortal(db: Db, input: { accountId: number; email: string; origin: string }): Promise<string> {
  const account = await accountOf(db, input.accountId);
  // Loupe's own set-up of the page (scripts/setup-stripe.mjs), when there is one.
  portalConfig ??= stripe()
    .billingPortal.configurations.list({ active: true, limit: 100 })
    .then((list) => list.data.find((c) => c.metadata?.loupe === "portal")?.id ?? null)
    .catch(() => null);
  const configuration = (await portalConfig) ?? undefined;
  const portal = await stripe().billingPortal.sessions.create({ customer: await customerOf(db, account, input.email), return_url: `${input.origin}/plan`, configuration });
  return portal.url;
}

/** Keeps the account's plan in step with its Stripe subscription (new, renewed, changed, failing or cancelled). */
export async function syncSubscription(db: Db, subscription: Stripe.Subscription): Promise<void> {
  const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const [account] = await db.select().from(accounts).where(eq(accounts.stripeCustomerId, customer));
  if (!account) return console.error(`Stripe subscription ${subscription.id} for an unknown customer ${customer}`);
  // A newer subscription replaced this one: the old one's news doesn't change the plan.
  if (account.subscriptionId && account.subscriptionId !== subscription.id && account.subscriptionStatus && LIVE.has(account.subscriptionStatus) && !LIVE.has(subscription.status)) return;
  const item = subscription.items.data[0];
  const key = item?.price.lookup_key;
  const which: "pro" | "studio" | null = key === PLAN_LOOKUP.studio ? "studio" : key === PLAN_LOOKUP.pro ? "pro" : null;
  const live = LIVE.has(subscription.status) && which !== null;
  // Off a plan, back to paying per scene.
  const plan: Plan = live ? which! : "indie";
  await db
    .update(accounts)
    .set({
      plan,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      periodStart: item ? new Date(item.current_period_start * 1000) : null,
      periodEnd: item ? new Date(item.current_period_end * 1000) : null,
    })
    .where(eq(accounts.id, account.id));
}

/**
 * A scene just paid for: if its newest version is a free preview (Loupe's own sound cleanup), Loupe makes it again
 * with the studio voice isolation, for the export. Everything else the preview worked out is reused (worker:
 * remember.ts), so it's quick.
 */
export async function finishForExport(db: Db, projectId: number, by: string): Promise<void> {
  const { done, waiting } = await sceneCuts(db, projectId);
  if (done?.result?.voice !== "preview" || waiting) return;
  await requestCut(db, projectId, by, {}).catch((error) => console.error(`Couldn't finish scene ${projectId} for export:`, error));
}

/** What Stripe sent to the webhook, fetched back from Stripe by its id (so only real events count) and acted on. */
export async function handleEvent(db: Db, eventId: string): Promise<void> {
  const event = await stripe().events.retrieve(eventId);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.expired":
      await settleSession(db, event.data.object.id);
      break;
    case "invoice.paid": {
      // A plan's month paid: half of it into the free-cutting fund.
      const invoice = event.data.object;
      const customer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const [account] = customer ? await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.stripeCustomerId, customer)) : [];
      if (invoice.amount_paid > 0) await depositSale(db, { cents: invoice.amount_paid, ref: `invoice:${invoice.id}`, kind: "plan", accountId: account?.id ?? null });
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      // The newest state, not the event's (events can arrive out of order).
      await syncSubscription(db, await stripe().subscriptions.retrieve(event.data.object.id));
      break;
  }
}
