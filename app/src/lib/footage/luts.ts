// LUTs: the team's .cube files, and which one each shoot and card was filmed
// with. The proxy worker bakes a clip's LUT into its proxy (and so its still),
// so the client sees the look instead of flat log footage. Choosing a LUT after
// proxies exist puts those proxies back in the queue to be made again.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cardLuts, files, luts, projects, proxyJobs } from "@/lib/db/schema";

/** Big enough for a 129-point cube; the common 33- and 65-point ones are 1 to 7 MB. */
export const MAX_LUT_BYTES = 64 * 1024 * 1024;

export type Lut = { id: number; name: string; cubeSize: number };

export class LutError extends Error {}

/**
 * Checks that the text is a 3D .cube LUT that FFmpeg can apply, and returns its
 * size. The errors are written for the DP who picked the file.
 */
export function parseCube(text: string): { size: number; title?: string } {
  let size = 0;
  let title: string | undefined;
  let rows = 0;
  let oneD = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const keyword = /^([A-Z_0-9]+)\s*(.*)$/.exec(line);
    if (keyword && !/^[-+.\d]/.test(line)) {
      const [, name, value] = keyword;
      if (name === "TITLE") title = value.replace(/^"|"$/g, "").trim() || undefined;
      else if (name === "LUT_3D_SIZE") size = Number(value);
      else if (name === "LUT_1D_SIZE") oneD = true;
      else if (!["DOMAIN_MIN", "DOMAIN_MAX", "LUT_3D_INPUT_RANGE", "LUT_1D_INPUT_RANGE"].includes(name)) {
        throw new LutError(`Line ${i + 1} ("${line.slice(0, 40)}") isn't something a .cube LUT contains.`);
      }
      continue;
    }
    if (!/^[-+]?[\d.]+(e[-+]?\d+)?\s+[-+]?[\d.]+(e[-+]?\d+)?\s+[-+]?[\d.]+(e[-+]?\d+)?$/i.test(line)) {
      throw new LutError(`Line ${i + 1} ("${line.slice(0, 40)}") isn't three numbers, so this isn't a .cube LUT.`);
    }
    rows++;
  }
  if (!size && oneD) throw new LutError("This is a 1D LUT. Export a 3D LUT (.cube) from your grading app and upload that instead.");
  if (!Number.isInteger(size) || size < 2 || size > 256) {
    throw new LutError("This file doesn't say how big its LUT is (LUT_3D_SIZE), so it isn't a 3D .cube LUT.");
  }
  if (rows !== size ** 3) {
    throw new LutError(`A ${size}-point LUT has ${size ** 3} colour rows, but this file has ${rows}. It may have been cut short.`);
  }
  return { size, title };
}

/** "S-Log3 to Rec709.cube" → "S-Log3 to Rec709". */
export function lutNameFrom(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.cube$/i, "").replace(/\s+/g, " ").trim().slice(0, 80) || "LUT";
}

/** The LUT's file name inside a shoot's LUTs/ folder, safe on any computer. */
export function lutFileName(lut: { id: number; name: string }): string {
  const safe = lut.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s-]+|[.\s]+$/g, "").slice(0, 80);
  return `${safe || `LUT ${lut.id}`}.cube`;
}

/** The account's LUTs by name, and the one used on its most recent scene (the default for a new one). */
export async function listLuts(db: Db, accountId: number): Promise<{ luts: Lut[]; lastUsedId: number | null }> {
  const rows = await db
    .select({ id: luts.id, name: luts.name, cubeSize: luts.cubeSize })
    .from(luts)
    .where(eq(luts.accountId, accountId))
    .orderBy(sql`lower(${luts.name})`, luts.id);
  const [last] = await db
    .select({ lutId: projects.lutId })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), isNotNull(projects.lutId)))
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .limit(1);
  return { luts: rows, lastUsedId: last?.lutId ?? null };
}

export async function getLut(db: Db, id: number) {
  const [row] = await db.select().from(luts).where(eq(luts.id, id));
  return row ?? null;
}

export async function addLut(
  db: Db,
  input: { accountId: number; name: string; storageKey: string; sizeBytes: number; cubeSize: number; createdBy: string },
): Promise<Lut> {
  const [row] = await db
    .insert(luts)
    .values(input)
    .onConflictDoUpdate({ target: luts.storageKey, set: { name: input.name } })
    .returning({ id: luts.id, name: luts.name, cubeSize: luts.cubeSize });
  return row;
}

/** The shoot's LUT and the cards that use a different one. */
export async function shootLuts(db: Db, projectId: number): Promise<{ lut: Lut | null; cards: { card: string; lut: Lut | null }[] }> {
  const [project] = await db
    .select({ id: luts.id, name: luts.name, cubeSize: luts.cubeSize })
    .from(projects)
    .innerJoin(luts, eq(luts.id, projects.lutId))
    .where(eq(projects.id, projectId));
  const overrides = await db
    .select({ card: cardLuts.card, id: luts.id, name: luts.name, cubeSize: luts.cubeSize })
    .from(cardLuts)
    .leftJoin(luts, eq(luts.id, cardLuts.lutId))
    .where(eq(cardLuts.projectId, projectId))
    .orderBy(cardLuts.card);
  return {
    lut: project ?? null,
    cards: overrides.map((o) => ({ card: o.card, lut: o.id === null ? null : { id: o.id, name: o.name!, cubeSize: o.cubeSize! } })),
  };
}

/** Every LUT a shoot uses (its own and its cards'), for the LUTs/ folder in downloads. */
export async function lutsUsedBy(db: Db, projectId: number) {
  const { lut, cards } = await shootLuts(db, projectId);
  const ids = [...new Set([lut?.id, ...cards.map((c) => c.lut?.id)].filter((id): id is number => typeof id === "number"))];
  return ids.length ? db.select().from(luts).where(inArray(luts.id, ids)).orderBy(luts.name) : [];
}

/** The LUT one card's clips should get: the card's own choice if it has one, else the shoot's. */
export async function lutForCard(db: Db, projectId: number, card: string): Promise<number | null> {
  const [override] = await db
    .select({ lutId: cardLuts.lutId })
    .from(cardLuts)
    .where(and(eq(cardLuts.projectId, projectId), eq(cardLuts.card, card)));
  if (override) return override.lutId;
  const [project] = await db.select({ lutId: projects.lutId }).from(projects).where(eq(projects.id, projectId));
  return project?.lutId ?? null;
}

/** Sets the shoot's LUT. Returns how many existing proxies will be re-made with it. */
export async function setShootLut(db: Db, projectId: number, lutId: number | null): Promise<number> {
  await db.update(projects).set({ lutId }).where(eq(projects.id, projectId));
  return syncProxyLooks(db, projectId);
}

/**
 * Gives one card its own LUT (lutId null: no LUT on that card), or with
 * "shoot" puts it back on the shoot's. Returns how many proxies will be re-made.
 */
export async function setCardLut(db: Db, projectId: number, card: string, choice: { lutId: number | null } | "shoot"): Promise<number> {
  if (choice === "shoot") {
    await db.delete(cardLuts).where(and(eq(cardLuts.projectId, projectId), eq(cardLuts.card, card)));
  } else {
    await db
      .insert(cardLuts)
      .values({ projectId, card, lutId: choice.lutId })
      .onConflictDoUpdate({ target: [cardLuts.projectId, cardLuts.card], set: { lutId: choice.lutId, updatedAt: new Date() } });
  }
  return syncProxyLooks(db, projectId);
}

/**
 * Brings every clip's wanted LUT in line with the shoot's and cards' choices.
 * Finished proxies made with a different LUT go back in the queue; ones still
 * waiting simply get the new LUT; one being made right now is re-made as soon
 * as it finishes (the worker checks when it records the result).
 */
export async function syncProxyLooks(db: Db, projectId: number): Promise<number> {
  const wanted = db.$with("wanted").as(
    db
      .select({
        jobId: proxyJobs.id,
        lutId: sql<number | null>`case when ${cardLuts.projectId} is not null then ${cardLuts.lutId} else ${projects.lutId} end`.as(
          "wanted_lut_id",
        ),
      })
      .from(proxyJobs)
      .innerJoin(files, eq(files.id, proxyJobs.fileId))
      .innerJoin(projects, eq(projects.id, proxyJobs.projectId))
      .leftJoin(cardLuts, and(eq(cardLuts.projectId, proxyJobs.projectId), eq(cardLuts.card, files.card)))
      .where(eq(proxyJobs.projectId, projectId)),
  );
  // A finished proxy with a different look than wanted.
  const stale = sql`(${proxyJobs.status} = 'done' and ${proxyJobs.madeWithLutId} is distinct from ${wanted.lutId})`;
  const rows = await db
    .with(wanted)
    .update(proxyJobs)
    .set({
      lutId: sql`${wanted.lutId}`,
      status: sql`case when ${stale} then 'queued' else ${proxyJobs.status} end`,
      attempts: sql`case when ${stale} then 0 else ${proxyJobs.attempts} end`,
      runAfter: sql`case when ${stale} then now() else ${proxyJobs.runAfter} end`,
      progress: sql`case when ${stale} then null else ${proxyJobs.progress} end`,
    })
    .from(wanted)
    .where(and(eq(proxyJobs.id, wanted.jobId), sql`(${proxyJobs.lutId} is distinct from ${wanted.lutId} or ${stale})`))
    .returning({ remade: sql<boolean>`${proxyJobs.status} = 'queued' and ${proxyJobs.proxySizeBytes} is not null` });
  return rows.filter((r) => r.remade).length;
}

