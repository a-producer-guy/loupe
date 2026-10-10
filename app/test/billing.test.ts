import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/db";
import { accounts, cuts, finals, fund, payments, projects, proxyJobs, files } from "../src/lib/db/schema";
import { fundBalance, fundShare, waitingForFund } from "../src/lib/fund";
import { requestCut, sceneChanges } from "../src/lib/footage/cuts";
import { requestFinal } from "../src/lib/footage/finals";
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
      if (id === "evt_invoice") return { type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_x", amount_paid: 19900 } } };
      throw new Error("No such event");
    },
  },
};

/** What Stripe's page does when the person pays. */
const pay = (id: string) => Object.assign(sessions.get(id)!, { status: "complete", payment_status: "paid", payment_intent: "pi_1" });
const sessionOf = (url: string) => url.split("/").at(-1)!;

async function sceneWithCut(name: string, seconds = 60, voice?: "preview" | "isolated") {
  const scene = await createShoot(db, { accountId: ACCT, name, shootDate: "2026-10-09", createdBy: WHO });
  const [cut] = await db
    .insert(cuts)
    .values({ projectId: scene.id, status: "done", result: { title: name, seconds, preview: { path: "p.mp4", size: 1 }, files: [], shots: [], render: {}, ...(voice ? { voice } : {}) } as never, finishedAt: new Date() })
    .returning();
  return { scene, cut };
}

/** Two takes with proxies, so new versions can be asked for. */
async function withTakes(projectId: number, minutes = 30) {
  for (const n of [1, 2]) {
    const [f] = await db.insert(files).values({ projectId, path: `Raw/A/T${n}.mov`, storageKey: `k/T${n}.mov`, sizeBytes: 10, isVideo: true, status: "uploaded" }).returning();
    await db.insert(proxyJobs).values({ fileId: f.id, projectId, rawKey: `r${n}`, proxyKey: `p${n}`, status: "done", previewSizeBytes: 5, media: { durationSeconds: minutes * 30, audioTracks: 1, audioChannels: 2 } });
  }
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

  test("a scene can't be paid for before its cut is even asked for (but can while it waits in line)", async () => {
    const scene = await createShoot(db, { accountId: ACCT, name: "Empty", shootDate: "2026-10-09", createdBy: WHO });
    await assert.rejects(unlock(scene.id), /hasn't started on this scene/);
    await db.insert(cuts).values({ projectId: scene.id });
    const page = await unlock(scene.id);
    assert.ok(!page.unlocked && page.url);
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

  test("a subscription that isn't a plan (Keep footage) never changes the plan", async () => {
    await db.update(accounts).set({ stripeCustomerId: "cus_x" }).where(eq(accounts.id, ACCT));
    await syncSubscription(db, subscription("active"));
    await syncSubscription(db, { ...(subscription("active", "loupe_keep_footage") as object), id: "sub_2" } as never);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, ACCT));
    assert.deepEqual([account.plan, account.subscriptionId], ["pro", "sub_1"]);
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

describe("always in the black", () => {
  test("half of every sale, after Stripe's fee, goes into the free-cutting fund, once", async () => {
    assert.equal(await fundBalance(db), 30000, "the launch budget");
    assert.equal(fundShare(3900), 1878);
    const { scene } = await sceneWithCut("Sold");
    const page = await unlock(scene.id);
    assert.ok(!page.unlocked);
    pay(sessionOf(page.url));
    await settleSession(db, sessionOf(page.url));
    await settleSession(db, sessionOf(page.url));
    assert.equal(await fundBalance(db), 30000 + 1878);
    // A plan's month paid: half of it too, once.
    await db.update(accounts).set({ stripeCustomerId: "cus_x" }).where(eq(accounts.id, ACCT));
    await handleEvent(db, "evt_invoice");
    await handleEvent(db, "evt_invoice");
    assert.equal(await fundBalance(db), 30000 + 1878 + fundShare(19900));
  });

  test("a free cut waits when the fund can't cover the most it can cost; paid scenes never wait", async () => {
    const scene = await createShoot(db, { accountId: ACCT, name: "Free", shootDate: "2026-10-09", createdBy: WHO });
    await withTakes(scene.id, 30); // 30 minutes: 50¢ + 30 × 7¢ = $2.60
    await db.insert(cuts).values({ projectId: scene.id });
    assert.equal(await waitingForFund(db, scene.id), false, "$300 covers it");
    await db.insert(fund).values({ amountCents: -29800, kind: "adjust", ref: "test:drain" });
    assert.equal(await waitingForFund(db, scene.id), true, "$2 doesn't");
    await db.update(projects).set({ unlockedAt: new Date(), unlockedHow: "paid" }).where(eq(projects.id, scene.id));
    assert.equal(await waitingForFund(db, scene.id), false);
  });

  test("paid for a free preview: Loupe makes it again with the studio sound, and export waits for it", async () => {
    const { scene } = await sceneWithCut("Preview", 60, "preview");
    await withTakes(scene.id);
    await db.insert(finals).values({ cutId: (await db.select().from(cuts).where(eq(cuts.projectId, scene.id)))[0].id, projectId: scene.id, kind: "original", status: "failed" });
    await assert.rejects(requestFinal(db, scene.id, WHO), /finishing the studio sound/);
    const page = await unlock(scene.id);
    assert.ok(!page.unlocked);
    pay(sessionOf(page.url));
    await settleSession(db, sessionOf(page.url));
    const rows = await db.select().from(cuts).where(eq(cuts.projectId, scene.id));
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, "waiting", "the studio-sound version is on its way");
  });

  test("Indie gets 3 changes a scene; going back and the studio sound don't count; Pro gets 10", async () => {
    const { scene } = await sceneWithCut("Busy");
    await withTakes(scene.id);
    const finish = () => db.update(cuts).set({ status: "done", result: { title: "v" } as never }).where(eq(cuts.status, "waiting"));
    for (let i = 0; i < 3; i++) {
      await requestCut(db, scene.id, WHO, { words: `Change ${i + 1}` });
      await finish();
    }
    assert.deepEqual(await sceneChanges(db, scene.id), { used: 3, limit: 3, plan: "indie" });
    await assert.rejects(requestCut(db, scene.id, WHO, { words: "A fourth" }), /3 changes are used\. Export it to keep going in Premiere or Resolve, or go Pro/);
    // Loupe's own studio-sound version, and a version gone back to, are free.
    await requestCut(db, scene.id, WHO, { counted: false });
    const [studio] = await db.select().from(cuts).where(eq(cuts.status, "waiting"));
    assert.equal((studio.direction as { studioSound?: boolean }).studioSound, true);
    await finish();
    await db.insert(cuts).values({ projectId: scene.id, status: "done", result: { title: "back", restoredFrom: 1 } as never });
    assert.equal((await sceneChanges(db, scene.id)).used, 3);
    // On Pro: 10.
    await db.update(accounts).set({ plan: "pro", subscriptionStatus: "active" }).where(eq(accounts.id, ACCT));
    assert.deepEqual(await sceneChanges(db, scene.id), { used: 3, limit: 10, plan: "pro" });
    await requestCut(db, scene.id, WHO, { words: "A fourth, on Pro" });
  });
});

