import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/db";
import { accounts, files, projects, proxyJobs } from "../src/lib/db/schema";
import { registerDrop, type DropGroup } from "../src/lib/footage/register";
import { verifyUpload } from "../src/lib/footage/verify";
import { getShoot, listShoots, searchShoots } from "../src/lib/footage/status";
import { addLut, listLuts, lutFileName, lutNameFrom, lutsUsedBy, parseCube, setCardLut, setShootLut } from "../src/lib/footage/luts";
import { createShoot, renameShoot, retryProxies, stopCard } from "../src/lib/footage/shoots";
import { accountNameFor, canWrite, ensureMember } from "../src/lib/footage/accounts";
import { accountUsage, ownedFileByKey, ownedLut, ownedShoot, PLAN_LIMITS } from "../src/lib/footage/access";
import { cleanRelativePath, formatBytes, formatRuntime, isHiddenPath, previewKey, proxyPath, searchWords, shootSearchText, slugify, thumbnailKey, timecodeAt } from "../src/lib/footage/names";

const WHO = "editor@example.com";
let db: TestDb;
// Stand-in for B2: key → size actually stored.
let b2: Map<string, number>;
const storedSize = async (key: string) => b2.get(key) ?? null;

const card = (name: string, list: [string, number, number?][], unreadable?: string[]): DropGroup => ({
  name,
  files: list.map(([path, size, lastModified]) => ({ path, size, lastModified: lastModified ?? 1_700_000_000_000 })),
  unreadable,
});

/** Pretends the browser uploaded every file in the result, then confirms each one. */
async function uploadAll(result: Awaited<ReturnType<typeof registerDrop>>) {
  for (const group of result) {
    for (const file of group.files) {
      if (file.state === "done") continue;
      b2.set(file.key, file.size);
      assert.deepEqual(await verifyUpload(db, file.key, WHO, storedSize), { ok: true });
    }
  }
}

// Every test works inside one account (on Studio, so plan limits stay out of the way).
let ACCT: number;

beforeEach(async () => {
  ({ db } = await createTestDb());
  b2 = new Map();
  [{ id: ACCT }] = await db.insert(accounts).values({ name: "Test Studio", plan: "studio" }).returning({ id: accounts.id });
});

describe("shoots", () => {
  test("a new shoot gets its B2 folder name from date, name and id", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "  Jane   Doé ", shootDate: "2026-09-23", createdBy: WHO });
    assert.equal(shoot.name, "Jane Doé");
    assert.equal(shoot.storagePrefix, "2026-09-23_jane-doe_p1001");
    assert.equal(shoot.status, "scheduled");
    await assert.rejects(createShoot(db, { accountId: ACCT, name: " ", shootDate: "2026-09-23", createdBy: WHO }), /name/);
  });

  test("a scene can be renamed without moving its files", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Jane Doe", shootDate: "2026-09-23", createdBy: WHO });
    assert.equal(await renameShoot(db, shoot.id, "  The   Offer "), "The Offer");
    const [row] = await db.select().from(projects).where(eq(projects.id, shoot.id));
    assert.equal(row.name, "The Offer");
    assert.equal(row.storagePrefix, "2026-09-23_jane-doe_p1001", "the B2 folder keeps its first name");
    await assert.rejects(renameShoot(db, shoot.id, "  "), /name/);
  });
});

describe("dropping cards", () => {
  test("a card uploads into Raw/ with its folders, skipping hidden files, and becomes safe to wipe", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Jane Doe", shootDate: "2026-09-23", createdBy: WHO });
    const result = await registerDrop(
      db,
      shoot.id,
      [
        card("A001", [
          ["PRIVATE/M4ROOT/CLIP/C0001.MP4", 5_000_000_000],
          ["PRIVATE/M4ROOT/CLIP/C0001M01.XML", 2_000],
          ["PRIVATE/M4ROOT/CLIP/C0002.MP4", 3_000_000_000],
          [".DS_Store", 6_000],
          ["PRIVATE/M4ROOT/CLIP/._C0001.MP4", 4_096],
        ]),
      ],
      WHO,
    );
    assert.equal(result[0].card, "A001");
    assert.deepEqual(
      result[0].files.map((f) => f.key),
      [
        "2026-09-23_jane-doe_p1001/Raw/A001/PRIVATE/M4ROOT/CLIP/C0001.MP4",
        "2026-09-23_jane-doe_p1001/Raw/A001/PRIVATE/M4ROOT/CLIP/C0001M01.XML",
        "2026-09-23_jane-doe_p1001/Raw/A001/PRIVATE/M4ROOT/CLIP/C0002.MP4",
      ],
    );
    assert.ok(result[0].files.every((f) => f.state === "upload"));

    let summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.status, "uploading");
    assert.equal(summary.safeToWipe, false);
    assert.equal(summary.files.bytesTotal, 8_000_002_000);

    await uploadAll(result);
    summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.safeToWipe, true);
    assert.equal(summary.status, "uploaded");
    assert.equal(summary.files.bytesUploaded, 8_000_002_000);
    assert.equal(formatBytes(summary.files.bytesUploaded), "8 GB");
    assert.deepEqual(summary.cards.map((c) => [c.card, c.safeToWipe]), [["A001", true]]);

    // Only the two clips get proxies, named like the raw, under Proxies/.
    const jobs = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    assert.deepEqual(
      jobs.map((j) => j.proxyKey),
      [
        "2026-09-23_jane-doe_p1001/Proxies/A001/PRIVATE/M4ROOT/CLIP/C0001.mov",
        "2026-09-23_jane-doe_p1001/Proxies/A001/PRIVATE/M4ROOT/CLIP/C0002.mov",
      ],
    );
    assert.equal(summary.proxies.videos, 2);
    assert.equal(summary.proxiesReady, false);
  });

  test("dropping the same card again resumes it instead of duplicating it", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Resume", shootDate: "2026-09-23", createdBy: WHO });
    const list: [string, number][] = [["CLIP/C0001.MP4", 900_000_000], ["CLIP/C0002.MP4", 800_000_000]];
    const first = await registerDrop(db, shoot.id, [card("A001", list)], WHO);
    // The first clip finished; the second was halfway through a multipart upload when the laptop died.
    b2.set(first[0].files[0].key, 900_000_000);
    await verifyUpload(db, first[0].files[0].key, WHO, storedSize);
    await db.update(files).set({ status: "uploading", uploadId: "upload-123" }).where(eq(files.storageKey, first[0].files[1].key));

    const again = await registerDrop(db, shoot.id, [card("A001", list)], WHO);
    assert.equal(again[0].card, "A001");
    assert.deepEqual(
      again[0].files.map((f) => [f.state, f.uploadId]),
      [["done", undefined], ["resume", "upload-123"]],
    );
    const rows = await db.select().from(files).where(eq(files.projectId, shoot.id));
    assert.equal(rows.length, 2);
  });

  test("a second card with the same name goes into its own folder instead of overwriting", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Two cams", shootDate: "2026-09-23", createdBy: WHO });
    const a = await registerDrop(db, shoot.id, [card("Untitled", [["CLIP/C0001.MP4", 100, 1]])], WHO);
    const b = await registerDrop(db, shoot.id, [card("Untitled", [["CLIP/C0001.MP4", 200, 2]])], WHO);
    const c = await registerDrop(db, shoot.id, [card("Untitled", [["CLIP/C0001.MP4", 300, 3]])], WHO);
    assert.deepEqual([a[0].card, b[0].card, c[0].card], ["Untitled", "Untitled 2", "Untitled 3"]);
    // Re-dropping the second card finds its own folder again.
    const bAgain = await registerDrop(db, shoot.id, [card("Untitled", [["CLIP/C0001.MP4", 200, 2]])], WHO);
    assert.equal(bAgain[0].card, "Untitled 2");
  });

  test("a file B2 holds at the wrong size is not counted and starts over", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Short", shootDate: "2026-09-23", createdBy: WHO });
    const [group] = await registerDrop(db, shoot.id, [card("A001", [["C0001.MP4", 1_000]])], WHO);
    b2.set(group.files[0].key, 999);
    const result = await verifyUpload(db, group.files[0].key, WHO, storedSize);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "wrong-size");
    assert.equal((await getShoot(db, shoot.id))!.safeToWipe, false);
    b2.set(group.files[0].key, 1_000);
    assert.equal((await verifyUpload(db, group.files[0].key, WHO, storedSize)).ok, true);
    assert.equal((await getShoot(db, shoot.id))!.safeToWipe, true);
  });

  test("a file the card couldn't read blocks 'safe to wipe' until it's read on a re-drop", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Bad card", shootDate: "2026-09-23", createdBy: WHO });
    const first = await registerDrop(
      db,
      shoot.id,
      [card("A001", [["CLIP/C0001.MP4", 1_000]], ["CLIP/C0002.MP4"])],
      WHO,
    );
    await uploadAll(first);
    let summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.safeToWipe, false);
    assert.equal(summary.files.problems, 1);
    assert.match(summary.problems[0].problem, /Don't wipe/);

    const second = await registerDrop(db, shoot.id, [card("A001", [["CLIP/C0001.MP4", 1_000], ["CLIP/C0002.MP4", 2_000]])], WHO);
    assert.equal(second[0].card, "A001");
    await uploadAll(second);
    summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.safeToWipe, true);
    assert.equal(summary.files.problems, 0);
  });

  test("an unread folder is only cleared by the same card, not a look-alike", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Folders", shootDate: "2026-09-23", createdBy: WHO });
    const first = await registerDrop(db, shoot.id, [card("Untitled", [["MEDIAPRO.XML", 50, 5]], ["CLIP"])], WHO);
    await uploadAll(first);

    // A different card with the same name: nothing matches, so it can't clear the unread folder.
    const other = await registerDrop(db, shoot.id, [card("Untitled", [["CLIP/C0001.MP4", 70, 9]])], WHO);
    assert.equal(other[0].card, "Untitled 2");

    // The same card again (MEDIAPRO.XML matches): the folder reads fine this time.
    const same = await registerDrop(db, shoot.id, [card("Untitled", [["MEDIAPRO.XML", 50, 5], ["CLIP/C0001.MP4", 60, 6]])], WHO);
    assert.equal(same[0].card, "Untitled");
    await uploadAll([...same, ...other]);
    const summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.files.problems, 0);
    assert.equal(summary.safeToWipe, true);
  });

  test("loose files land straight in Raw/", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Loose", shootDate: "2026-09-23", createdBy: WHO });
    const [group] = await registerDrop(db, shoot.id, [card("", [["C0001.MP4", 10]])], WHO);
    assert.equal(group.files[0].key, "2026-09-23_loose_p1001/Raw/C0001.MP4");
  });

  test("clips sharing a name in one folder each get their own proxy", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Same name", shootDate: "2026-09-23", createdBy: WHO });
    const result = await registerDrop(db, shoot.id, [card("A", [["A001.MOV", 10], ["A001.MP4", 20]])], WHO);
    await uploadAll(result);
    const keys = (await db.select().from(proxyJobs)).map((j) => j.proxyKey).sort();
    assert.deepEqual(keys, ["2026-09-23_same-name_p1001/Proxies/A/A001.mov", "2026-09-23_same-name_p1001/Proxies/A/A001_MP4.mov"]);
  });
});

describe("proxy status and actions", () => {
  test("proxies ready once every clip's job is done; failed ones can be retried", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Proxies", shootDate: "2026-09-23", createdBy: WHO });
    const result = await registerDrop(db, shoot.id, [card("A", [["C1.MOV", 10], ["C2.MOV", 10], ["S.WAV", 5]])], WHO);
    await uploadAll(result);
    const [j1, j2] = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    await db.update(proxyJobs).set({ status: "done", progress: 1 }).where(eq(proxyJobs.id, j1.id));
    await db.update(proxyJobs).set({ status: "failed", attempts: 3, error: "boom" }).where(eq(proxyJobs.id, j2.id));

    let summary = (await getShoot(db, shoot.id))!;
    assert.deepEqual([summary.proxies.done, summary.proxies.failed, summary.proxiesReady], [1, 1, false]);
    assert.equal(summary.clips.find((c) => c.proxy?.jobId === j2.id)?.proxy?.error, "boom");
    assert.deepEqual(summary.otherFiles, { count: 1, bytes: 5 });

    assert.equal(await retryProxies(db, shoot.id, j2.id), 1);
    const [retried] = await db.select().from(proxyJobs).where(eq(proxyJobs.id, j2.id));
    assert.deepEqual([retried.status, retried.attempts, retried.error], ["queued", 0, null]);

    await db.update(proxyJobs).set({ status: "done" }).where(eq(proxyJobs.id, j2.id));
    summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.proxiesReady, true);
    assert.equal(summary.proxies.progress, 1);
  });

  test("finished clips carry their details and still; the shoot gets a cover and a runtime", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Stills", shootDate: "2026-09-23", createdBy: WHO });
    await uploadAll(await registerDrop(db, shoot.id, [card("A", [["C1.MOV", 10], ["C2.MOV", 10]])], WHO));
    const [first, second] = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    const media = { durationSeconds: 61.5, width: 1920, height: 1080, fps: "23.976", codec: "ProRes 422 HQ", audioTracks: 2, audioChannels: 2 };
    await db.update(proxyJobs).set({ status: "done", media }).where(eq(proxyJobs.id, first.id));
    await db.update(proxyJobs).set({ status: "running", progress: 0.4 }).where(eq(proxyJobs.id, second.id));

    const sign = async (key: string) => `signed:${key}`;
    const detail = (await getShoot(db, shoot.id, sign))!;
    assert.equal(detail.runtimeSeconds, 61.5);
    assert.equal(detail.coverUrl, "signed:2026-09-23_stills_p1001/Thumbnails/A/C1.jpg");
    const [c1, c2] = detail.clips;
    assert.deepEqual([c1.thumbUrl, c1.media?.fps], ["signed:2026-09-23_stills_p1001/Thumbnails/A/C1.jpg", "23.976"]);
    assert.deepEqual([c2.thumbUrl, c2.media], [null, null]);
    const [listed] = await listShoots(db, ACCT, "2026-09-01", "2026-09-30", sign);
    assert.equal(listed.coverUrl, detail.coverUrl);
  });

  test("stopping a card forgets its unfinished files but keeps the finished ones", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Oops", shootDate: "2026-09-23", createdBy: WHO });
    const [group] = await registerDrop(db, shoot.id, [card("A", [["C1.MOV", 10], ["C2.MOV", 10]])], WHO);
    b2.set(group.files[0].key, 10);
    await verifyUpload(db, group.files[0].key, WHO, storedSize);
    assert.equal(await stopCard(db, shoot.id, "A"), 1);
    const summary = (await getShoot(db, shoot.id))!;
    assert.equal(summary.files.total, 1);
    assert.equal(summary.safeToWipe, true);
    const [project] = await db.select().from(projects).where(eq(projects.id, shoot.id));
    assert.equal(project.status, "uploaded");
  });

  test("the Today list includes shoots in the date window with their card lines", async () => {
    await createShoot(db, { accountId: ACCT, name: "Old", shootDate: "2026-07-01", createdBy: WHO });
    const today = await createShoot(db, { accountId: ACCT, name: "Today", shootDate: "2026-09-23", createdBy: WHO });
    await registerDrop(db, today.id, [card("A001", [["C1.MOV", 10]])], WHO);
    const list = await listShoots(db, ACCT, "2026-08-24", "2026-10-23");
    assert.deepEqual(list.map((s) => s.name), ["Today"]);
    assert.deepEqual(list[0].cards.map((c) => c.card), ["A001"]);
  });

  test("search finds shoots from any date by name, month, day or number, and every word has to match", async () => {
    const old = await createShoot(db, { accountId: ACCT, name: "Harbor Night", shootDate: "2025-06-05", createdBy: WHO });
    await createShoot(db, { accountId: ACCT, name: "Jane Doe", shootDate: "2026-09-23", createdBy: WHO });
    await createShoot(db, { accountId: ACCT, name: "Jane's Pickups", shootDate: "2026-06-05", createdBy: WHO });
    const names = async (q: string) => (await searchShoots(db, ACCT, q)).map((s) => s.name);

    assert.deepEqual(await names("harbor"), ["Harbor Night"]);
    assert.deepEqual(await names("  JANE "), ["Jane Doe", "Jane's Pickups"]); // newest first
    assert.deepEqual(await names("jane june"), ["Jane's Pickups"]);
    assert.deepEqual(await names("jun 5"), ["Jane's Pickups", "Harbor Night"]);
    assert.deepEqual(await names("sep 23"), ["Jane Doe"]);
    assert.deepEqual(await names("2025"), ["Harbor Night"]);
    assert.deepEqual(await names(`p${old.id}`), ["Harbor Night"]);
    assert.deepEqual(await names("100%_"), []);
    assert.deepEqual(await names("   "), []);

    // The browser's instant matches use the same words as the server's search.
    const text = shootSearchText({ id: 1001, name: "Harbor Night", shootDate: "2025-06-05" });
    assert.equal(text, "harbor night 2025-06-05 june jun 5 p1001");
    assert.deepEqual(searchWords("  Jane   JUN "), ["jane", "jun"]);
  });

  test("search only ever finds the account's own scenes", async () => {
    await createShoot(db, { accountId: ACCT, name: "Jane Doe", shootDate: "2026-09-23", createdBy: WHO });
    const [{ id: other }] = await db.insert(accounts).values({ name: "Other Studio" }).returning({ id: accounts.id });
    await createShoot(db, { accountId: other, name: "Jane Smith", shootDate: "2026-09-23", createdBy: "someone@else.com" });
    assert.deepEqual((await searchShoots(db, ACCT, "jane")).map((s) => s.name), ["Jane Doe"]);
    assert.deepEqual((await listShoots(db, other, "2026-09-01", "2026-09-30")).map((s) => s.name), ["Jane Smith"]);
  });
});

describe("accounts", () => {
  test("the first sign-in makes an account with that person as owner; the next sign-in finds it", async () => {
    const first = await ensureMember(" Maya@Northlight-Reels.com ", db);
    assert.equal(first.email, "maya@northlight-reels.com");
    assert.equal(first.role, "owner");
    const [account] = await db.select().from(accounts).where(eq(accounts.id, first.accountId));
    assert.equal(account.name, "Northlight Reels");
    assert.equal(account.plan, "free");
    const again = await ensureMember("maya@northlight-reels.com", db);
    assert.equal(again.id, first.id);
    assert.equal(again.accountId, first.accountId);
    assert.equal(accountNameFor("sam@gmail.com"), "My studio", "no company name from a personal email");
  });

  test("one account can never reach another's scenes, files or LUTs", async () => {
    const mine = { accountId: ACCT };
    const them = await ensureMember("them@rival.com", db);
    const theirs = await createShoot(db, { accountId: them.accountId, name: "Secret", shootDate: "2026-09-23", createdBy: them.email });
    const ours = await createShoot(db, { accountId: ACCT, name: "Ours", shootDate: "2026-09-23", createdBy: WHO });
    const [drop] = await registerDrop(db, theirs.id, [card("A001", [["C0001.MP4", 1_000]])], them.email);

    assert.equal(await ownedShoot(db, mine, theirs.id), null);
    assert.equal((await ownedShoot(db, mine, ours.id))?.id, ours.id);
    assert.equal(await ownedShoot(db, mine, null), null);
    assert.equal(await ownedFileByKey(db, mine, drop.files[0].key), null, "their upload links can't be signed for us");
    assert.ok(await ownedFileByKey(db, them, drop.files[0].key));

    const lut = await addLut(db, { accountId: them.accountId, name: "Theirs", storageKey: "LUTs/theirs.cube", sizeBytes: 100, cubeSize: 33, createdBy: them.email });
    assert.equal(await ownedLut(db, mine, lut.id), null);
    assert.deepEqual((await listLuts(db, ACCT)).luts, [], "their LUTs aren't in our list");
  });

  test("viewers and directors can watch; only owners and editors change scenes", () => {
    assert.equal(canWrite({ role: "owner" }), true);
    assert.equal(canWrite({ role: "editor" }), true);
    assert.equal(canWrite({ role: "director" }), false);
    assert.equal(canWrite({ role: "viewer" }), false);
  });

  test("the free plan holds one scene's worth of footage: a drop over 25 GB is undone", async () => {
    const free = await ensureMember("indie@gmail.com", db);
    const shoot = await createShoot(db, { accountId: free.accountId, name: "First", shootDate: "2026-09-23", createdBy: free.email });
    await assert.rejects(
      registerDrop(db, shoot.id, [card("A001", [["C0001.MP4", 20e9], ["C0002.MP4", 6e9]])], free.email),
      /free plan holds/,
    );
    assert.deepEqual(await accountUsage(db, free.accountId), { scenes: 1, bytes: 0 }, "nothing from the refused drop was kept");
    const ok = await registerDrop(db, shoot.id, [card("A001", [["C0001.MP4", 20e9]])], free.email);
    assert.equal(ok[0].files.length, 1);
    const again = await registerDrop(db, shoot.id, [card("A001", [["C0001.MP4", 20e9]])], free.email);
    assert.equal(again[0].files[0].state, "upload", "dropping the same card again isn't counted twice");
    assert.equal(PLAN_LIMITS.free.scenes, 1);
    assert.equal(PLAN_LIMITS.studio.bytes, Infinity);
  });
});

describe("LUTs", () => {
  const cube = (size: number, rows = size ** 3) =>
    [`TITLE "Show"`, `LUT_3D_SIZE ${size}`, ...Array.from({ length: rows }, () => "0.1 0.2 0.3")].join("\n");
  const newLut = (name: string) => addLut(db, { accountId: ACCT, name, storageKey: `LUTs/${name}.cube`, sizeBytes: 100, cubeSize: 33, createdBy: WHO });
  const media = { durationSeconds: 2, width: 1920, height: 1080, audioTracks: 1, audioChannels: 2 };

  test("a .cube file is checked before anyone uses it, with plain-English reasons", () => {
    assert.deepEqual(parseCube(cube(2)), { size: 2, title: "Show" });
    const resolve = `# Resolve\r\nDOMAIN_MIN 0 0 0\r\nDOMAIN_MAX 1 1 1\r\nLUT_3D_SIZE 2\r\n${Array(8).fill("1.0e-1 2E-1 0.3").join("\r\n")}\r\n`;
    assert.equal(parseCube(resolve).size, 2);
    assert.throws(() => parseCube(cube(2, 7)), /has 7/);
    assert.throws(() => parseCube("LUT_1D_SIZE 2\n0 0 0\n1 1 1"), /1D LUT/);
    assert.throws(() => parseCube("<html>a web page</html>"), /isn't three numbers|isn't something/);
    assert.throws(() => parseCube("0 0 0\n1 1 1"), /LUT_3D_SIZE/);
    assert.equal(lutNameFrom("S-Log3 to Rec709.cube"), "S-Log3 to Rec709");
    assert.equal(lutFileName({ id: 4, name: "Show/Night: v2" }), "Show-Night- v2.cube");
  });

  test("the shoot's LUT goes into its proxies, and a card from another camera can have its own", async () => {
    const show = await newLut("Show");
    const bcam = await newLut("B-cam");
    const shoot = await createShoot(db, { accountId: ACCT, name: "Looks", shootDate: "2026-09-23", createdBy: WHO, lutId: show.id });
    await setCardLut(db, shoot.id, "B001", { lutId: bcam.id });
    await uploadAll(await registerDrop(db, shoot.id, [card("A001", [["C1.MOV", 10]]), card("B001", [["C2.MOV", 10]])], WHO));

    const jobs = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    assert.deepEqual(jobs.map((j) => j.lutId), [show.id, bcam.id]);
    assert.equal((await listLuts(db, ACCT)).lastUsedId, show.id, "the next new shoot starts with the same LUT");
    assert.deepEqual((await lutsUsedBy(db, shoot.id)).map((l) => l.name), ["B-cam", "Show"], "both come with a download");
    const detail = (await getShoot(db, shoot.id))!;
    assert.equal(detail.lut?.name, "Show");
    assert.deepEqual(detail.cardLuts.map((c) => [c.card, c.lut?.name]), [["B001", "B-cam"]]);
  });

  test("changing the LUT re-makes only proxies already made with another look", async () => {
    const show = await newLut("Show");
    const alt = await newLut("Alt");
    const shoot = await createShoot(db, { accountId: ACCT, name: "Regrade", shootDate: "2026-09-23", createdBy: WHO, lutId: show.id });
    await uploadAll(await registerDrop(db, shoot.id, [card("A001", [["C1.MOV", 10], ["C2.MOV", 10], ["C3.MOV", 10], ["C4.MOV", 10]])], WHO));
    const [done, , failed, running] = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    await db.update(proxyJobs).set({ status: "done", madeWithLutId: show.id, proxySizeBytes: 5, media }).where(eq(proxyJobs.id, done.id));
    await db.update(proxyJobs).set({ status: "failed", error: "Unreadable" }).where(eq(proxyJobs.id, failed.id));
    await db.update(proxyJobs).set({ status: "running", progress: 0.5 }).where(eq(proxyJobs.id, running.id));

    assert.equal(await setShootLut(db, shoot.id, alt.id), 1, "only the finished proxy has to be made again");
    const after = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    assert.deepEqual(
      after.map((j) => [j.status, j.lutId]),
      [["queued", alt.id], ["queued", alt.id], ["failed", alt.id], ["running", alt.id]],
      "waiting and running ones just take the new LUT; a failed one waits for Retry",
    );

    const sign = async (key: string, version?: string) => `signed:${key}${version ? `#${version}` : ""}`;
    const [c1, c2] = (await getShoot(db, shoot.id, sign))!.clips;
    assert.equal(c1.proxy?.lookUpdating, true);
    assert.equal(c1.thumbUrl, `signed:${shoot.storagePrefix}/Thumbnails/A001/C1.jpg#look-${show.id}`, "keeps its still until the new one is ready");
    assert.equal(c2.proxy?.lookUpdating, false, "never made yet, so nothing to update");
    assert.equal(await setShootLut(db, shoot.id, alt.id), 0, "choosing the same LUT again changes nothing");
  });

  test("a card can have no LUT, or go back to the shoot's", async () => {
    const show = await newLut("Show");
    const shoot = await createShoot(db, { accountId: ACCT, name: "Mixed", shootDate: "2026-09-23", createdBy: WHO, lutId: show.id });
    await uploadAll(await registerDrop(db, shoot.id, [card("A001", [["C1.MOV", 10]]), card("DRONE", [["D1.MP4", 10]])], WHO));
    const lutOf = async (card: string) => {
      const rows = await db.select({ card: files.card, lutId: proxyJobs.lutId }).from(proxyJobs).innerJoin(files, eq(files.id, proxyJobs.fileId));
      return rows.find((r) => r.card === card)!.lutId;
    };
    await setCardLut(db, shoot.id, "DRONE", { lutId: null });
    assert.deepEqual([await lutOf("A001"), await lutOf("DRONE")], [show.id, null]);
    await setCardLut(db, shoot.id, "DRONE", "shoot");
    assert.equal(await lutOf("DRONE"), show.id);
    assert.deepEqual((await getShoot(db, shoot.id))!.cardLuts, []);
  });
});

describe("playing clips on the web", () => {
  test("the player shows the clip's own timecode, drop-frame included", () => {
    assert.equal(timecodeAt("01:00:00:00", "23.976", 0), "01:00:00:00");
    assert.equal(timecodeAt("01:00:00:00", "23.976", 1), "01:00:00:23", "23.976 counts 24 frames a second, a little slower than the clock");
    assert.equal(timecodeAt("10:00:00:00", "25", 2.5), "10:00:02:12");
    assert.equal(timecodeAt("00:00:59;29", "29.97", 1 / 29.97), "00:01:00;02", "drop-frame skips ;00 and ;01 at the minute");
    assert.equal(timecodeAt("00:09:59;29", "29.97", 1 / 29.97), "00:10:00;00", "except every tenth minute");
    assert.equal(timecodeAt("23:59:59:23", "24", 1 / 24), "00:00:00:00", "wraps at midnight");
    assert.equal(timecodeAt(undefined, "24", 3), null);
    assert.equal(timecodeAt("01:00:00:00", undefined, 3), null);
  });

  test("previews sit beside the proxies, never inside Proxies/", () => {
    assert.equal(previewKey("2026-09-23_x_p1001/Proxies/A001/CLIP/C1.mov"), "2026-09-23_x_p1001/Previews/A001/CLIP/C1.mp4");
  });

  test("the shoot page knows which clips have a preview", async () => {
    const shoot = await createShoot(db, { accountId: ACCT, name: "Play", shootDate: "2026-09-23", createdBy: WHO });
    await uploadAll(await registerDrop(db, shoot.id, [card("A", [["C1.MOV", 10], ["C2.MOV", 10]])], WHO));
    const [first] = await db.select().from(proxyJobs).orderBy(proxyJobs.id);
    await db.update(proxyJobs).set({ status: "done", proxySizeBytes: 5, previewSizeBytes: 3 }).where(eq(proxyJobs.id, first.id));
    const clips = (await getShoot(db, shoot.id))!.clips;
    assert.deepEqual(clips.map((c) => c.preview), [true, false]);
  });
});

describe("naming rules", () => {
  test("hidden files, paths and proxy names", () => {
    assert.equal(isHiddenPath("A001/.Spotlight-V100/Store"), true);
    assert.equal(isHiddenPath("A001/System Volume Information/x"), true);
    assert.equal(isHiddenPath("A001/PRIVATE/M4ROOT/CLIP/C0001.MP4"), false);
    assert.equal(cleanRelativePath("a//b/../c"), null);
    assert.equal(cleanRelativePath("CLIP\\C0001.MP4"), "CLIP/C0001.MP4");
    assert.equal(proxyPath("Raw/A001/CLIP/C0001.MP4"), "Proxies/A001/CLIP/C0001.mov");
    assert.equal(proxyPath("Raw/A.B/NOEXT"), "Proxies/A.B/NOEXT.mov");
    assert.equal(slugify("Ünïcødé & Co!!"), "unicode-co");
    assert.equal(formatBytes(214_300_000_000), "214 GB");
    assert.equal(formatBytes(1_250_000_000), "1.3 GB");
    assert.equal(thumbnailKey("x_p1/Proxies/A001/CLIP/C0001.mov"), "x_p1/Thumbnails/A001/CLIP/C0001.jpg");
    assert.deepEqual([formatRuntime(125.4), formatRuntime(3725), formatRuntime(0)], ["2:05", "1:02:05", ""]);
  });
});
