#!/usr/bin/env node
// Sets Loupe up in Stripe, in one go: run it with the test key first, and again with the live key at launch.
//
//   node scripts/setup-stripe.mjs
//
// 1. Reads the Stripe secret key from the clipboard (nothing is pasted into the terminal or into chat).
// 2. Makes the monthly plans (Loupe Pro $199, Loupe Studio $1,500) if they aren't there yet.
// 3. Sets up Stripe's billing page (card, invoices, switching between Pro and Studio, cancelling at the month's end).
// 4. Points Stripe's webhook at https://editloupe.com/api/stripe/webhook.
// 5. Saves the key in app/.env.local and in Vercel's settings for the live site.
// Running it again changes nothing that's already right.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askFromClipboard, writeEnv } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");
const Stripe = createRequire(path.join(APP, "package.json"))("stripe");
const SITE = "https://editloupe.com";

const PLANS = [
  { lookup: "loupe_pro_monthly", name: "Loupe Pro", cents: 19900, about: "10 scenes a month, then $39 each" },
  { lookup: "loupe_studio_monthly", name: "Loupe Studio", cents: 150000, about: "Up to 60 scenes a month, then $25 each" },
];
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
];

async function main() {
  console.log("\nIn Stripe, with the Loupe account picked (top left): Developers → API keys → Secret key → Reveal → copy.");
  console.log("Test mode first (its key starts sk_test_); at launch, run this again with the live key (sk_live_).\n");
  const key = await askFromClipboard("secret key");
  if (!/^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(key)) {
    console.error("\n✗ That isn't a Stripe secret key (they start sk_test_ or sk_live_). Copy it again and rerun.");
    process.exit(1);
  }
  const live = key.startsWith("sk_live_");
  const stripe = new Stripe(key);
  const account = await stripe.accounts.retrieve().catch((error) => {
    console.error(`\n✗ Stripe didn't accept the key: ${error.message}`);
    process.exit(1);
  });
  const name = account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? account.id;
  console.log(`\nConnected to Stripe account “${name}” in ${live ? "LIVE mode (real money)" : "test mode (no real money)"}.`);
  if (!/loupe/i.test(name)) {
    console.error(`✗ That's not the Loupe account. Pick Loupe at the top left in Stripe, copy its key, and rerun.`);
    process.exit(1);
  }

  // The monthly plans.
  const prices = {};
  for (const plan of PLANS) {
    const [existing] = (await stripe.prices.list({ lookup_keys: [plan.lookup], active: true, limit: 1 })).data;
    if (existing) {
      prices[plan.lookup] = existing;
      console.log(`✓ ${plan.name} is there ($${existing.unit_amount / 100} a month).`);
      continue;
    }
    const product = await stripe.products.create({ name: plan.name, description: plan.about, metadata: { loupe: plan.lookup } });
    prices[plan.lookup] = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: plan.cents,
      recurring: { interval: "month" },
      lookup_key: plan.lookup,
      nickname: plan.name,
    });
    console.log(`✓ Made ${plan.name}: $${plan.cents / 100} a month.`);
  }

  // Stripe's billing page.
  const portal = {
    business_profile: { headline: "Loupe: your plan and payments" },
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end", cancellation_reason: { enabled: true, options: ["too_expensive", "unused", "missing_features", "switched_service", "other"] } },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products: Object.values(prices).map((p) => ({ product: typeof p.product === "string" ? p.product : p.product.id, prices: [p.id] })),
      },
    },
    metadata: { loupe: "portal" },
  };
  const [config] = (await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data.filter((c) => c.metadata?.loupe === "portal");
  if (config) await stripe.billingPortal.configurations.update(config.id, portal);
  else await stripe.billingPortal.configurations.create(portal);
  console.log("✓ Stripe's billing page is set up (card, invoices, switching plans, cancelling).");

  // The webhook.
  const url = `${SITE}/api/stripe/webhook`;
  const [hook] = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter((h) => h.url === url);
  if (hook) await stripe.webhookEndpoints.update(hook.id, { enabled_events: EVENTS, disabled: false });
  else await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: "Loupe: payments and plans" });
  console.log(`✓ Stripe tells ${url} about payments and plans.`);

  // The key: this Mac, and the live site.
  writeEnv(path.join(APP, ".env.local"), { STRIPE_SECRET_KEY: key });
  console.log("✓ Saved in app/.env.local.");
  for (const target of ["production"]) {
    try {
      execFileSync("npx", ["-y", "vercel@latest", "env", "add", "STRIPE_SECRET_KEY", target, "--scope", "reelarc", "--force"], { cwd: APP, input: key, stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      console.error(`✗ Couldn't save it in Vercel (${target}): ${String(error.stderr ?? error.message).trim().split("\n").at(-1)}`);
      process.exit(1);
    }
  }
  console.log("✓ Saved in Vercel's settings for the live site. It takes effect with the next deploy.");
  console.log(`\nAll set${live ? ": Loupe takes real payments once the site redeploys." : " in test mode. Pay with card 4242 4242 4242 4242, any future date, any CVC."}\n`);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
