import { and, desc, eq, ne, sql } from "drizzle-orm";
import { waitingForFund } from "@/lib/fund";
import type { Db } from "@/lib/db/client";
import { accounts, cuts, files, projects, proxyJobs } from "@/lib/db/schema";
import { sceneScript } from "@/lib/footage/scripts";

// A scene's cut (Loupe stage 2). It starts by itself once the scene's footage is in and its proxies are made (the
// worker, or the scene page for a scene whose proxies were ready before), is made by the worker
// (worker/src/assembly), and is directed with notes. The worker fills in `result` (run.ts, AssemblyResult) and puts
// the package in the scene's "Loupe Cut" folder in B2.

import { CHANGES, changesUsed, CUT_FOLDER, CUT_STEPS, folderOf, type CutResult, type CutState, type CutView, type Direction, type SceneChanges } from "./cut-types";

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

/**
 * The scene's versions: the newest, the newest finished one, the one being made, and the one waiting behind it
 * (a queued request, Guy Oct 7: nothing is turned away while Loupe is busy).
 */
export async function sceneCuts(
  db: Db,
  projectId: number,
): Promise<{ latest: CutView | null; done: CutView | null; working: CutView | null; waiting: CutView | null; versions: number }> {
  const rows = await db.select().from(cuts).where(eq(cuts.projectId, projectId)).orderBy(desc(cuts.id)).limit(20);
  const find = (status: string) => {
    const row = rows.find((r) => r.status === status);
    return row ? view(row) : null;
  };
  return { latest: rows[0] ? view(rows[0]) : null, done: find("done"), working: find("working"), waiting: find("waiting"), versions: rows.filter((r) => r.status === "done").length };
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

/** A finished version's choices, to build the next one on (without what only described that version itself). */
const answered = (d: Direction | null | undefined): Direction | null => {
  if (!d) return null;
  const { restoredFrom: _from, restoredHow: _how, queued: _queued, studioSound: _studio, ...rest } = d;
  void [_from, _how, _queued, _studio];
  return { ...rest, notes: (d.notes ?? []).filter((n) => n.reply !== null) };
};

/**
 * The scene's changes so far, and its plan's allowance. A change is a version Loupe makes on request: the first cut,
 * going back to a version, the studio sound made for a paid preview, a note Loupe answered without changing anything,
 * and a try that failed don't count.
 */
export async function sceneChanges(db: Db, projectId: number): Promise<SceneChanges> {
  const [row] = await db
    .select({ plan: accounts.plan, status: accounts.subscriptionStatus })
    .from(projects)
    .innerJoin(accounts, eq(accounts.id, projects.accountId))
    .where(eq(projects.id, projectId));
  const live = ["active", "trialing", "past_due"].includes(row?.status ?? "");
  const plan = live && (row?.plan === "pro" || row?.plan === "studio") ? row.plan : "indie";
  const [{ made }] = await db
    .select({ made: sql<number>`count(*)::int` })
    .from(cuts)
    .where(
      and(
        eq(cuts.projectId, projectId),
        ne(cuts.status, "failed"),
        sql`${cuts.result}->>'restoredFrom' is null`,
        sql`${cuts.direction}->>'restoredFrom' is null`,
        sql`coalesce(${cuts.direction}->>'studioSound', 'false') <> 'true'`,
        sql`coalesce(${cuts.result}->>'unchanged', 'false') <> 'true'`,
      ),
    );
  return { used: Math.max(0, made - 1), limit: CHANGES[plan], plan };
}
const isUnique = (error: unknown) => String((error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code) === "23505";

/**
 * A request for Loupe. Loupe free: a new version, carrying the last finished one's direction with the change.
 * Loupe busy: it queues. A request is put in plain words ("Use take T005 for the line …", "Add a score") on the version
 * waiting behind the one being made, and the worker reads them against whatever that one turns out to be
 * (worker/src/assembly/job.ts, queued). Several requests while it's busy join up, in order. Never turned away.
 */
async function ask(
  db: Db,
  projectId: number,
  by: string,
  change: { words: string | null; direction?: (d: Direction) => Direction; leadRole?: string | null; scriptId?: number | null; counted?: boolean },
): Promise<CutView> {
  if ((await takesReady(db, projectId)).ready < 2) throw new CutError("Loupe needs at least two takes with proxies to cut a scene. They're still being made.");
  // Each plan gets a number of changes per scene (Indie 3, Pro 10, Studio 30); going back to a version is free.
  if (change.counted !== false) {
    const changes = await sceneChanges(db, projectId);
    if (changes.used >= changes.limit) throw new CutError(changesUsed(changes), 402);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { done, working, waiting } = await sceneCuts(db, projectId);
    const at = new Date().toISOString();
    if (waiting) {
      // Join the request already waiting: in words, after what it already asks.
      const d: Direction = waiting.direction ?? {};
      const notes = [...(d.notes ?? [])];
      const last = notes.at(-1);
      if (change.words) {
        if (last && last.reply === null) notes[notes.length - 1] = { ...last, note: `${last.note} Then: ${change.words}`.slice(0, 1500), at };
        else notes.push({ note: change.words, reply: null, at });
      }
      const next = change.direction && !waiting.direction?.queued ? change.direction({ ...d, notes }) : { ...d, notes };
      const [row] = await db
        .update(cuts)
        .set({
          direction: next,
          ...(change.leadRole !== undefined ? { leadRole: change.leadRole } : {}),
          ...(change.scriptId !== undefined ? { scriptId: change.scriptId } : {}),
          requestedBy: by,
        })
        .where(and(eq(cuts.id, waiting.id), eq(cuts.status, "waiting")))
        .returning();
      if (row) return view(row);
      continue; // it started in the meantime: queue behind it instead
    }
    const base: Direction = answered(done?.direction) ?? {};
    // Busy: queued in words, read later against the version being made now. Free: applied to the last finished one.
    const made: Direction = working
      ? { queued: true, notes: change.words ? [{ note: change.words, reply: null, at }] : [] }
      : change.direction
        ? change.direction(base)
        : change.words
          ? { ...base, notes: [...(base.notes ?? []), { note: change.words, reply: null, at }] }
          : base;
    // Made by Loupe itself (not going back): the studio sound for a paid preview, not one of the scene's changes.
    const direction: Direction = change.counted === false && !made.restoredFrom ? { ...made, studioSound: true } : made;
    try {
      const [row] = await db
        .insert(cuts)
        .values({
          projectId,
          scriptId: change.scriptId !== undefined ? change.scriptId : working ? null : (done?.scriptId ?? null),
          leadRole: change.leadRole !== undefined ? change.leadRole : working ? null : (done?.leadRole ?? null),
          coverage: working ? null : (done?.coverage ?? null),
          direction,
          requestedBy: by,
        })
        .returning();
      return view(row);
    } catch (error) {
      if (!isUnique(error)) throw error;
      // Someone else's request got in first: join it.
    }
  }
  throw new CutError("Loupe is busy with this scene. Try that again in a moment.", 409);
}

/**
 * Another version with corrections (whose scene it is, the script, a whole direction), or the same again. `words`
 * says it in plain words for when Loupe is busy and it has to queue.
 */
export async function requestCut(
  db: Db,
  projectId: number,
  by: string,
  corrections: { scriptId?: number | null; leadRole?: string | null; direction?: Direction; words?: string; counted?: boolean } = {},
): Promise<CutView> {
  const { direction, words, ...rest } = corrections;
  return ask(db, projectId, by, { words: words ?? null, ...rest, ...(direction ? { direction: () => direction } : {}) });
}

export const MAX_NOTE = 500;

/** A note to Loupe ("warmer", "she's too composed here"), with what it's about when narrowed ("this line: …"). */
export async function addNote(db: Db, projectId: number, by: string, note: string, scope?: string | null): Promise<CutView> {
  const said = note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
  if (!said) throw new CutError("Tell Loupe what to change.");
  const { done, working } = await sceneCuts(db, projectId);
  if (!done?.result && !working) throw new CutError("There's no cut to change yet. Once the first one's ready, tell Loupe what to change.");
  return ask(db, projectId, by, { words: (scope ? `${scope}: ${said}` : said).slice(0, 600) });
}

const EXTRA_WORDS = {
  establishing: ["Open on an establishing shot of the outside.", "No establishing shot."],
  ambience: ["Add the room's ambience.", "No ambience."],
  score: ["Add a score.", "No score."],
} as const;

/** One click on an extra (Guy, Oct 7: off by default, one click to add). */
export async function setExtra(db: Db, projectId: number, by: string, extra: "establishing" | "ambience" | "score", on: boolean): Promise<CutView> {
  const { done, working } = await sceneCuts(db, projectId);
  if (!done?.result && !working) throw new CutError("There's no cut yet. Extras can be added once it's ready.");
  return ask(db, projectId, by, {
    words: working ? EXTRA_WORDS[extra][on ? 0 : 1] : null,
    direction: (d) => {
      const kept = Object.fromEntries(Object.entries({ ...(d.extras ?? {}), [extra]: on }).filter(([, v]) => v));
      return { ...d, extras: Object.keys(kept).length ? kept : undefined };
    },
  });
}

/** "Use this take" for a line (from Other takes): straight into the direction when Loupe is free, in words when it's busy. */
export async function pickTake(db: Db, projectId: number, by: string, line: number, take: string): Promise<CutView> {
  const { done, working } = await sceneCuts(db, projectId);
  const result = done?.result;
  if (!result) throw new CutError("There's no cut yet.");
  const text = result.lines[line]?.text;
  if (!text) throw new CutError("That line isn't in the scene.");
  if (!result.takes.some((t) => t.take === take && t.setup)) throw new CutError("That take can't be used here.");
  return ask(db, projectId, by, {
    words: working ? `Use take ${take} for the line "${text}".` : null,
    direction: (d) => ({ ...d, picks: [...(d.picks ?? []).filter((p) => p.line !== text), { line: text, take }] }),
  });
}

/** The package's files as they sit in the scene's folder (for the Premiere download). */
export function packageFiles(prefix: string, result: CutResult): { path: string; key: string; size: number }[] {
  // Saved as "Loupe Cut/…" whichever version it is, as the timeline inside it expects.
  return result.files.map((f) => ({ path: `${CUT_FOLDER}/${f.path}`, key: `${prefix}/${folderOf(result)}/${f.path}`, size: f.size }));
}



/** Everything the scene page needs about its cut (starting the first one, if it's due). */
export async function cutState(db: Db, projectId: number, prefix: string, by: string | null, sign: (key: string, version?: string, extension?: string) => Promise<string>): Promise<CutState> {
  await startCutIfReady(db, projectId, by);
  const [{ latest, done, working, waiting, versions }, { ready }, script, fundWait, changes] = await Promise.all([
    sceneCuts(db, projectId),
    takesReady(db, projectId),
    sceneScript(db, projectId),
    waitingForFund(db, projectId),
    sceneChanges(db, projectId),
  ]);
  const preview = done?.result ? await sign(`${prefix}/${folderOf(done.result)}/${done.result.preview.path}`, `cut-${done.id}`, "mp4") : null;
  return { latest, done, working, waiting, versions, preview, steps: CUT_STEPS, ready, script: script ? { id: script.id, title: script.title, roles: script.roles } : null, fundWait, changes };
}
