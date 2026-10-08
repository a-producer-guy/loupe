import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cuts, projects, shareLinks, shareNotes } from "@/lib/db/schema";
import { CUT_FOLDER, type CutResult } from "@/lib/footage/cut-types";

// Share links (Guy, Oct 7): a secret address anyone can open to watch a scene's newest cut and leave notes pinned to
// moments, without being able to change anything. Notes go to the scene's people, who pass them on to Loupe (or put
// them aside). One working link per scene, until it's turned off.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_VIEWER_NOTE = 500;
export const MAX_VIEWER_NAME = 60;
/** Plenty for a real review, and a ceiling if a link ends up somewhere it shouldn't. */
const MAX_NOTES_PER_LINK = 400;

export const watchPath = (token: string) => `/watch/${token}`;

export type ViewerNote = { id: number; name: string; at: number; note: string; createdAt: string; sentAt: string | null; doneAt: string | null };

const noteView = (r: typeof shareNotes.$inferSelect): ViewerNote => ({
  id: r.id,
  name: r.name,
  at: r.at,
  note: r.note,
  createdAt: r.createdAt.toISOString(),
  sentAt: r.sentAt?.toISOString() ?? null,
  doneAt: r.doneAt?.toISOString() ?? null,
});

/** The scene's working link, or null when it isn't shared. */
export async function sceneLink(db: Db, projectId: number): Promise<{ token: string; createdAt: string } | null> {
  const [row] = await db
    .select({ token: shareLinks.token, createdAt: shareLinks.createdAt })
    .from(shareLinks)
    .where(and(eq(shareLinks.projectId, projectId), isNull(shareLinks.turnedOffAt)));
  return row ? { token: row.token, createdAt: row.createdAt.toISOString() } : null;
}

/** Shares the scene: its working link, made if there isn't one. */
export async function shareScene(db: Db, projectId: number, by: string): Promise<string> {
  const existing = await sceneLink(db, projectId);
  if (existing) return existing.token;
  const token = randomBytes(32).toString("base64url");
  try {
    await db.insert(shareLinks).values({ projectId, token, createdBy: by });
    return token;
  } catch (error) {
    // Made by someone else at the same moment: theirs is the link.
    const made = await sceneLink(db, projectId);
    if (made) return made.token;
    throw error;
  }
}

/** Stops sharing: the link stops working for good (sharing again makes a new address). */
export async function unshareScene(db: Db, projectId: number, by: string): Promise<void> {
  await db.update(shareLinks).set({ turnedOffAt: new Date(), turnedOffBy: by }).where(and(eq(shareLinks.projectId, projectId), isNull(shareLinks.turnedOffAt)));
}

/** Every viewer note on the scene, newest last (all its links, so notes outlive a link that was turned off). */
export async function sceneNotes(db: Db, projectId: number): Promise<ViewerNote[]> {
  const rows = await db.select().from(shareNotes).where(eq(shareNotes.projectId, projectId)).orderBy(asc(shareNotes.id)).limit(MAX_NOTES_PER_LINK);
  return rows.map(noteView);
}

/** A viewer note passed on to Loupe (sent) or put aside (done), by someone on the scene. */
export async function markNote(db: Db, projectId: number, id: number, what: "sent" | "done"): Promise<ViewerNote | null> {
  const [row] = await db
    .update(shareNotes)
    .set(what === "sent" ? { sentAt: new Date() } : { doneAt: new Date() })
    .where(and(eq(shareNotes.id, id), eq(shareNotes.projectId, projectId)))
    .returning();
  return row ? noteView(row) : null;
}

export type WatchState = {
  scene: string;
  cut: { id: number; title: string; seconds: number; preview: string; subs: CutResult["subs"]; shots: { at: number; seconds: number; who: string; kind: string }[]; lead: string } | null;
  notes: ViewerNote[];
};

/** The link's working scene, or null (never existed, or turned off). */
async function linkScene(db: Db, token: string) {
  if (!TOKEN.test(token)) return null;
  const [link] = await db
    .select({ id: shareLinks.id, projectId: shareLinks.projectId, name: projects.name, prefix: projects.storagePrefix })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.turnedOffAt)));
  return link ?? null;
}

/** What a share link shows: the newest finished cut, to watch, and the notes left on this link. */
export async function watchState(db: Db, token: string, sign: (key: string, version?: string, extension?: string) => Promise<string>): Promise<WatchState | null> {
  const link = await linkScene(db, token);
  if (!link) return null;
  const [done] = await db
    .select({ id: cuts.id, result: cuts.result })
    .from(cuts)
    .where(and(eq(cuts.projectId, link.projectId), eq(cuts.status, "done")))
    .orderBy(desc(cuts.id))
    .limit(1);
  const result = (done?.result as CutResult | undefined) ?? null;
  const notes = await db.select().from(shareNotes).where(eq(shareNotes.linkId, link.id)).orderBy(asc(shareNotes.id)).limit(MAX_NOTES_PER_LINK);
  return {
    scene: link.name,
    cut:
      done && result
        ? {
            id: done.id,
            title: result.title,
            seconds: result.seconds,
            preview: await sign(`${link.prefix}/${CUT_FOLDER}/${result.preview.path}`, `cut-${done.id}`, "mp4"),
            subs: result.subs,
            shots: result.shots.map((s) => ({ at: s.at, seconds: s.seconds, who: s.who, kind: s.kind })),
            lead: result.client,
          }
        : null,
    notes: notes.map(noteView),
  };
}

export class NoteError extends Error {}

/** A viewer's note on a link, pinned to a moment of the version they're watching. */
export async function addViewerNote(db: Db, token: string, input: { name: string; at: number; note: string; cutId: number | null }): Promise<ViewerNote | null> {
  const link = await linkScene(db, token);
  if (!link) return null;
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, MAX_VIEWER_NAME);
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, MAX_VIEWER_NOTE);
  if (!name) throw new NoteError("Add your name, so they know who the note's from.");
  if (!note) throw new NoteError("Write the note first.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(shareNotes).where(eq(shareNotes.linkId, link.id));
  if (n >= MAX_NOTES_PER_LINK) throw new NoteError("This link has taken all the notes it can. Ask for a new link.");
  // The version must be this scene's; otherwise the note is just pinned to the time.
  const [cut] = input.cutId ? await db.select({ id: cuts.id }).from(cuts).where(and(eq(cuts.id, input.cutId), eq(cuts.projectId, link.projectId))) : [];
  const [row] = await db
    .insert(shareNotes)
    .values({ linkId: link.id, projectId: link.projectId, cutId: cut?.id ?? null, name, at: Math.max(0, Math.min(36_000, input.at)), note })
    .returning();
  return noteView(row);
}
