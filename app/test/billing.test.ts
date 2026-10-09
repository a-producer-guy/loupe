import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/db";
import { accounts, cuts, finals, payments, projects } from "../src/lib/db/schema";
import { createShoot } from "../src/lib/footage/shoots";
import { sceneBilling, setStripeForTests, settleSession, syncSubscription, unlockScene, payForTopaz, handleEvent } from "../src/lib/billing";

// Payments, against a stand-in for Stripe that keeps its sessions in memory: what's free, what's in a plan, what's
// paid for, and that a payment gives what it bought exactly once.

let db: TestDb;
let ACCT: number;
const WHO = "guy@reelarc.com";
const ORIGIN = "https://editloupe.com";
let sessions: Map<string, Record<string, unknown>>;
let subs: Map<string, Record<string, unknown>>;
let made = 0;

const fakeStripe = {
  customers: { create: async () => ({ id: `cus_${++made}` }) },
  checkout: {
    sessions: {
      create: async (params: Record<string, unknown>) => {
        const id = `cs_test_${++made}`;
        sessions.set(id, { id, mode: params.mode, metadata: params.metadata, status: "open", payment_status: "unpaid", payment_intent: null, subscription: null, amount: (params.line_items as { price_data?: { unit_amount: number } }[])[0].price_data?.unit_amount });
        return { id, url: `https://checkout.stripe.test/${id}` };
      },
      retrieve: async (id: string) => {
        const s = sessions.get(id);
        if (!s) throw new Error("No such session");
        return s;
      },
    },
  },
  subscriptions: { retrieve: async (id: string) => subs.get(id) },
  events: {
    retrieve: async (id: string) => {
      if (id === "evt_paid") return { type: "checkout.session.completed", data: { object: { id: [...sessions.keys()].at(-1) } } };
      throw new Error("No such event");
    },
  },
};

/** What Stripe's page does when the person pays. */
const pay = (id: string) => Object.assign(sessions.get(id)!, { status: "complete", payment_status: "paid", payment_intent: "pi_1" });
const sessionOf = (url: string) => url.split("/").at(-1)!;

async function sceneWithCut(name: string, seconds = 60) {
  const scene = await createShoot(db, { accountId: ACCT, name, shootDate: "2026-10-09", createdBy: WHO });
  const [cut] = await db
    .insert(cuts)
    .values({ projectId: scene.id, status: "done", result: { title: name, seconds, preview: { path: "p.mp4", size: 1 }, files: [], shots: [], render: {} } as never, finishedAt: new Date() })
    .returning();
  return { scene, cut };
}

const unlock = (projectId: number, sceneName = "S") => unlockScene(db, { accountId: ACCT, projectId, sceneName, email: WHO, origin: ORIGIN });

beforeEach(async () => {
  ({ db } = await createTestDb());
  sessions = new Map();
  subs = new Map();
  setStripeForTests(fakeStripe);
  [{ id: ACCT }] = await db.insert(accounts).values({ name: "Guy" }).returning({ id: accounts.id });
});

describe("paying for exports", () => {
  test("exporting always costs on Indie: $39 on Stripe's page, unlocked once, when it's paid", async () => {
    const one = await sceneWithCut("One");
    assert.deepEqual((await sceneBilling(db, ACCT, one.scene.id)).next, { kind: "pay", cents: 3900 }, "no free export, even the first");
    const page = await unlock(one.scene.id);
    assert.ok(!page.unlocked && page.url.startsWith("https://checkout.stripe.test/"));
    const id = sessionOf(page.url);
    // Not paid yet: nothing given.
    assert.equal((await settleSession(db, id)).paid, false);
    assert.equal((await sceneBilling(db, ACCT, one.scene.id)).unlocked, false);

    pay(id);
    assert.deepEqual(await settleSession(db, id), { kind: "scene", projectId: one.scene.id, paid: true });
    await settleSession(db, id); // the webhook, arriving second
    const [row] = await db.select().from(projects).where(eq(projects.id, one.scene.id));
    assert.equal(row.unlockedHow, "paid");
    const rows = await db.select().from(payments);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "paid");
    assert.equal(rows[0].amountCents, 3900);
    assert.deepEqual(await unlock(one.scene.id), { unlocked: true, how: "paid" }, "unlocking again changes nothing");
  });

  test("the webhook only acts on events Stripe itself has", async () => {
    const { scene } = await sceneWithCut("Paid");
    const page = await unlock(scene.id);
    assert.ok(!page.unlocked);
    await assert.rejects(handleEvent(db, "evt_madeup"), /No such event/);
    pay(sessionOf(page.url));
    await handleEvent(db, "evt_paid");
    assert.equal((await sceneBilling(db, ACCT, scene.id)).unlocked, true);
  });

  test("a scene can't be paid for before Loupe has cut it", async () => {
    const scene = await createShoot(db, { accountId: ACCT, name: "Empty", shootDate: "2026-10-09", createdBy: WHO });
    await assert.rejects(unlock(scene.id), /hasn't finished the cut/);
  });
});

describe("plans", () => {
  const subscription = (status: string, lookup = "loupe_pro_monthly") => {
    const now = Math.floor(Date.now() / 1000);
    const sub = { id: "sub_1", status, customer: "cus_x", items: { data: [{ price: { lookup_key: lookup }, current_period_start: now - 60, current_period_end: now + 30 * 86400 }] } };
    subs.set("sub_1", sub);
    return sub as never;
  };

  test("Pro includes 10 scenes a month, then $39 each; cancelling goes back to paying per scene", async () => {
    await db.update(accounts).set({ stripeCustomerId: "cus_x" }).where(eq(accounts.id, ACCT));
    await syncSubscription(db, subscription("active"));
    const [account] = await db.select().from(accounts).where(eq(accounts.id, ACCT));
    assert.equal(account.plan, "pro");

    for (let i = 0; i < 10; i++) {
      const { scene } = await sceneWithCut(`Scene ${i}`);
      assert.equal((await sceneBilling(db, ACCT, scene.id)).next.kind, "plan");
      assert.deepEqual(await unlock(scene.id), { unlocked: true, how: "plan" });
    }
    const { scene: eleventh } = await sceneWithCut("Eleventh");
    assert.deepEqual((await sceneBilling(db, ACCT, eleventh.id)).next, { kind: "pay", cents: 3900 });

    await syncSubscription(db, subscription("canceled"));
    const [after] = await db.select().from(accounts).where(eq(accounts.id, ACCT));
    assert.equal(after.plan, "indie", "back to paying per scene");
  });

  test("Studio's extra scenes are $25", async () => {
    await db.update(accounts).set({ stripeCustomerId: "cus_x" }).where(eq(accounts.id, ACCT));
    await syncSubscription(db, subscription("active", "loupe_studio_monthly"));
    for (let i = 0; i < 60; i++) {
      const { scene } = await sceneWithCut(`S${i}`);
      await unlock(scene.id);
    }
    const { scene } = await sceneWithCut("Sixty-first");
    assert.deepEqual((await sceneBilling(db, ACCT, scene.id)).next, { kind: "pay", cents: 2500 });
  });
});

describe("Topaz 4K", () => {
  test("paid on Stripe's page first (twice what it costs us), then started once", async () => {
    const { scene, cut } = await sceneWithCut("Four K", 90);
    await assert.rejects(payForTopaz(db, { accountId: ACCT, projectId: scene.id, sceneName: "Four K", email: WHO, origin: ORIGIN }), /Make the final first/, "nobody pays before it can start");
    await db.insert(finals).values({ cutId: cut.id, projectId: scene.id, kind: "original", status: "done", width: 1920, height: 1080 });

    const page = await payForTopaz(db, { accountId: ACCT, projectId: scene.id, sceneName: "Four K", email: WHO, origin: ORIGIN });
    assert.ok("url" in page);
    const id = sessionOf(page.url);
    assert.equal(sessions.get(id)!.amount, 1500, "90 s × $0.16 = $14.40, rounded up");
    assert.equal((await db.select().from(finals).where(eq(finals.kind, "topaz"))).length, 0, "nothing starts before it's paid");

    pay(id);
    await settleSession(db, id);
    await settleSession(db, id);
    assert.equal((await db.select().from(finals).where(eq(finals.kind, "topaz"))).length, 1, "started once");
    // Asked again: already paid for this version, so no second charge.
    assert.deepEqual(await payForTopaz(db, { accountId: ACCT, projectId: scene.id, sceneName: "Four K", email: WHO, origin: ORIGIN }), { started: true });
    assert.equal(sessions.size, 1);
  });
});
