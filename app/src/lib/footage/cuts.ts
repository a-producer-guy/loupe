import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cuts, files, projects, proxyJobs, type TakeSetup } from "@/lib/db/schema";
import { sceneScript } from "@/lib/footage/scripts";

// A scene's cut (Loupe stage 2). It starts by itself once the scene's footage is in and its proxies are made (the
// worker, or the scene page for a scene whose proxies were ready before), is made by the worker
// (worker/src/assembly), and is directed with notes. The worker fills in `result` (run.ts, AssemblyResult) and puts
// the package in the scene's "Loupe Cut" folder in B2.

import { CUT_FOLDER, CUT_STEPS, type CutResult, type CutState, type CutView, type Direction } from "./cut-types";

export * from "./cut-types";

const view = (row: typeof cuts.$inferSelect): CutView => ({
  id: row.id,
  status: row.status,
  step: row.step,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
  scriptId: row.scriptId,
  leadRole: row.leadRole,
  coverage: row.coverage ?? null,
  direction: (row.direction as Direction | null) ?? null,
  result: (row.result as CutResult | null) ?? null,
});

/** The scene's newest version, and the newest finished one (they differ while a note is being made). */
export async function sceneCuts(db: Db, projectId: number): Promise<{ latest: CutView | null; done: CutView | null; versions: number }> {
  const rows = await db.select().from(cuts).where(eq(cuts.projectId, projectId)).orderBy(desc(cuts.id)).limit(20);
  const done = rows.find((r) => r.status === "done");
  return { latest: rows[0] ? view(rows[0]) : null, done: done ? view(done) : null, versions: rows.filter((r) => r.status === "done").length };
}

/** Takes ready to cut (proxy and web preview made), and whether every video's proxy has finished one way or another. */
export async function takesReady(db: Db, projectId: number): Promise<{ ready: number; settled: boolean }> {
  const rows = await db.select({ status: proxyJobs.status, preview: proxyJobs.previewSizeBytes }).from(proxyJobs).where(eq(proxyJobs.projectId, projectId));
  return {
    ready: rows.filter((r) => r.status === "done" && r.preview !== null).length,
    settled: rows.every((r) => r.status === "done" || r.status === "failed" || r.status === "skipped"),
  };
}

export class CutError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The scene's first cut, once it can be made: every file in, every proxy finished, at least two takes ready, and no
 * cut yet. Nobody presses anything (Guy: "it has to feel like magic"). The worker does the same the moment the last
 * proxy is made (worker/src/jobs.ts); this catches scenes whose proxies were ready before. Returns true if it started one.
 */
export async function startCutIfReady(db: Db, projectId: number, by: string | null): Promise<boolean> {
  const [scene] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId));
  if (!scene || scene.status !== "uploaded") return false;
  const [any] = await db.select({ id: cuts.id }).from(cuts).where(eq(cuts.projectId, projectId)).limit(1);
  if (any) return false;
  const [waiting] = await db.select({ n: sql<number>`count(*)::int` }).from(files).where(and(eq(files.projectId, projectId), ne(files.status, "uploaded")));
  if (waiting.n > 0) return false;
  const { ready, settled } = await takesReady(db, projectId);
  if (!settled || ready < 2) return false;
  const inserted = await db.insert(cuts).values({ projectId, requestedBy: by }).onConflictDoNothing().returning({ id: cuts.id });
  return inserted.length > 0;
}

/** Another version, with corrections (whose scene it is, the script, who each take is on). One at a time per scene. */
export async function requestCut(
  db: Db,
  projectId: number,
  by: string,
  corrections: { scriptId?: number | null; leadRole?: string | null; coverage?: Record<string, TakeSetup | null> | null; direction?: Direction | null } = {},
): Promise<CutView> {
  if ((await takesReady(db, projectId)).ready < 2) throw new CutError("Loupe needs at least two takes with proxies to cut a scene. They're still being made.");
  const running = await db.select({ id: cuts.id }).from(cuts).where(and(eq(cuts.projectId, projectId), inArray(cuts.status, ["waiting", "working"])));
  if (running.length) throw new CutError("Loupe is already working on this scene.", 409);
  const { done } = await sceneCuts(db, projectId);
  // Carried from the last finished version unless given: the notes so far still stand (the look, the picks...).
  const direction = corrections.direction !== undefined ? corrections.direction : done?.direction ? { ...done.direction, notes: (done.direction.notes ?? []).filter((n) => n.reply !== null) } : null;
  try {
    const [row] = await db
      .insert(cuts)
      .values({
        projectId,
        scriptId: corrections.scriptId !== undefined ? corrections.scriptId : (done?.scriptId ?? null),
        leadRole: corrections.leadRole !== undefined ? corrections.leadRole : (done?.leadRole ?? null),
        coverage: corrections.coverage !== undefined ? corrections.coverage : (done?.coverage ?? null),
        direction,
        requestedBy: by,
      })
      .returning();
    return view(row);
  } catch (error) {
    // Two at once: the second finds the first one's row.
    if (String((error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code) === "23505") throw new CutError("Loupe is already working on this scene.", 409);
    throw error;
  }
}

export const MAX_NOTE = 500;

/** A note to Loupe on the finished cut ("warmer", "she's too composed here"): a new version with it waiting to be read. */
export async function addNote(db: Db, projectId: number, by: string, note: string, scope?: string | null): Promise<CutView> {
  const said = note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
  if (!said) throw new CutError("Tell Loupe what to change.");
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) throw new CutError("There's no cut to change yet. Once the first one's ready, tell Loupe what to change.");
  const before = done.direction ?? {};
  // What the note is about, when it's narrowed to a line or an actor ("this line: …"), goes in front, in plain words.
  const full = scope ? `${scope}: ${said}` : said;
  const notes = [...(before.notes ?? []).filter((n) => n.reply !== null), { note: full.slice(0, 600), reply: null, at: new Date().toISOString() }].slice(-30);
  return requestCut(db, projectId, by, { direction: { ...before, notes } });
}

/** One click on an extra (Guy, Oct 7: off by default, one click to add): a new version with it on or off. */
export async function setExtra(db: Db, projectId: number, by: string, extra: "establishing" | "ambience" | "score", on: boolean): Promise<CutView> {
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) throw new CutError("There's no cut yet. Extras can be added once it's ready.");
  const before = done.direction ?? {};
  const extras = { ...(before.extras ?? {}), [extra]: on };
  const kept = Object.fromEntries(Object.entries(extras).filter(([, v]) => v));
  return requestCut(db, projectId, by, { direction: { ...before, notes: (before.notes ?? []).filter((n) => n.reply !== null), extras: Object.keys(kept).length ? kept : undefined } });
}

/**
 * "Use this take" for a line (from Other takes): straight into the direction, no reading needed, and a new version
 * made with it. A take of the line's speaker, or of the other actor listening, from this scene.
 */
export async function pickTake(db: Db, projectId: number, by: string, line: number, take: string): Promise<CutView> {
  const { done } = await sceneCuts(db, projectId);
  const result = done?.result;
  if (!result) throw new CutError("There's no cut yet.");
  const text = result.lines[line]?.text;
  if (!text) throw new CutError("That line isn't in the scene.");
  if (!result.takes.some((t) => t.take === take && t.setup)) throw new CutError("That take can't be used here.");
  const before = done.direction ?? {};
  const picks = [...(before.picks ?? []).filter((p) => p.line !== text), { line: text, take }];
  return requestCut(db, projectId, by, { direction: { ...before, notes: (before.notes ?? []).filter((n) => n.reply !== null), picks } });
}

/** The package's files as they sit in the scene's folder (for the Premiere download). */
export function packageFiles(prefix: string, result: CutResult): { path: string; key: string; size: number }[] {
  return result.files.map((f) => ({ path: `${CUT_FOLDER}/${f.path}`, key: `${prefix}/${CUT_FOLDER}/${f.path}`, size: f.size }));
}



/** Everything the scene page needs about its cut (starting the first one, if it's due). */
export async function cutState(db: Db, projectId: number, prefix: string, by: string | null, sign: (key: string, version?: string, extension?: string) => Promise<string>): Promise<CutState> {
  await startCutIfReady(db, projectId, by);
  const [{ latest, done, versions }, { ready }, script] = await Promise.all([sceneCuts(db, projectId), takesReady(db, projectId), sceneScript(db, projectId)]);
  const preview = done?.result ? await sign(`${prefix}/${CUT_FOLDER}/${done.result.preview.path}`, `cut-${done.id}`, "mp4") : null;
  return { latest, done, versions, preview, steps: CUT_STEPS, ready, script: script ? { id: script.id, title: script.title, roles: script.roles } : null };
}
