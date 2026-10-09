import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cuts } from "@/lib/db/schema";
import { CutError, requestCut, sceneCuts } from "@/lib/footage/cuts";
import { changesOf, folderOf, short, whatChanged, type Change, type CutResult, type CutView, type Direction, type RestoredHow, type VersionView } from "@/lib/footage/cut-types";

// Versions (Guy, Oct 8: undo and going back, "SUPER smart but an easy breezy process"). Every finished version is
// kept. Each is named by what changed, in plain words. Going back to one never deletes anything: it becomes the
// newest version (instantly when its preview is kept, from Oct 8 on; otherwise Loupe makes it again from its
// choices). Undo goes back to the version before. And each change in the current cut can be taken out on its own,
// keeping everything else.

/** The direction without one change. */
function without(d: Direction, key: string): Direction {
  const next: Direction = { ...d, notes: (d.notes ?? []).filter((n) => n.reply !== null) };
  if (key === "look") next.look = null;
  else if (key === "pace") next.pace = null;
  else if (key === "reactions") next.reactions = null;
  else if (key === "clean") next.clean = null;
  else if (key === "music") {
    next.music = null;
    const { score: _, ...rest } = next.extras ?? {};
    void _;
    next.extras = Object.keys(rest).length ? rest : undefined;
  } else if (key.startsWith("extras.")) {
    const extra = key.slice(7) as "score" | "ambience" | "establishing";
    const kept = Object.fromEntries(Object.entries(next.extras ?? {}).filter(([k, v]) => k !== extra && v));
    next.extras = Object.keys(kept).length ? kept : undefined;
    if (extra === "score") next.music = null;
  } else if (key.startsWith("pick:")) {
    const line = key.slice(5);
    const picks = (next.picks ?? []).filter((p) => p.line !== line);
    next.picks = picks.length ? picks : undefined;
  }
  return next;
}

type Row = typeof cuts.$inferSelect;

/** A version's name: going back, the note that made it, or what changed from the one before. */
function labelOf(row: Row, before: Row | null, n: (id: number) => number | null): string {
  const result = row.result as CutResult | null;
  const d = row.direction as Direction | null;
  const back = result?.restoredFrom ?? d?.restoredFrom;
  if (back) return `Back to version ${n(back) ?? "earlier"}`;
  if (d?.studioSound) return "Studio sound, for the export";
  if (!before) return "First cut";
  const notes = (d?.notes ?? []).filter((x) => x.reply !== null);
  const earlier = new Set(((before.direction as Direction | null)?.notes ?? []).map((x) => x.at));
  const said = notes.filter((x) => !earlier.has(x.at)).map((x) => x.note.replace(/^[^:]{0,160}(lines?|cut|sound|colour|nothing)[^:]*: /i, ""));
  if (said.length) return said.map((s) => short(s, 48)).join(" · ");
  return whatChanged(before, row) ?? (row.scriptId !== before.scriptId ? "With the script" : "Made again");
}

/** Every finished version of the scene, newest first, named in plain words. */
export async function sceneVersions(db: Db, projectId: number, prefix: string, sign: (key: string, version?: string, extension?: string) => Promise<string>): Promise<{ versions: VersionView[]; changes: Change[] }> {
  const rows = await db.select().from(cuts).where(and(eq(cuts.projectId, projectId), eq(cuts.status, "done"))).orderBy(asc(cuts.id));
  const number = new Map(rows.map((r, i) => [r.id, i + 1]));
  const current = rows.at(-1);
  const versions = await Promise.all(
    rows.map(async (row, i) => {
      const result = row.result as CutResult | null;
      const whole = Boolean(result?.folder);
      return {
        id: row.id,
        n: i + 1,
        label: labelOf(row, rows[i - 1] ?? null, (id) => number.get(id) ?? null),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        current: row.id === current?.id,
        whole,
        preview: whole && result ? await sign(`${prefix}/${folderOf(result)}/${result.preview.path}`, `cut-${row.id}`, "mp4") : null,
      };
    }),
  );
  return { versions: versions.reverse(), changes: current ? changesOf(current.direction as Direction | null, current.leadRole) : [] };
}

/**
 * Goes back to a version: it becomes the newest one. Kept whole (Oct 8 on): instantly, the same files. Older: Loupe
 * makes it again from its choices (a few minutes). Nothing is deleted, so going forward again is just as easy.
 */
export async function restoreVersion(db: Db, projectId: number, id: number, by: string, how: RestoredHow = "picked"): Promise<{ instant: boolean }> {
  const { done, working } = await sceneCuts(db, projectId);
  if (working) throw new CutError("Loupe is in the middle of a change. Once it's done, you can go back to any version.", 409);
  const [source] = await db.select().from(cuts).where(and(eq(cuts.id, id), eq(cuts.projectId, projectId), eq(cuts.status, "done")));
  if (!source) throw new CutError("That version isn't there.", 404);
  if (done?.id === source.id) return { instant: true };
  const result = source.result as CutResult | null;
  const direction = source.direction as Direction | null;
  if (result?.folder) {
    // The same files: a new newest version that is that one.
    await db.insert(cuts).values({
      projectId,
      scriptId: source.scriptId,
      leadRole: source.leadRole,
      coverage: source.coverage,
      direction: direction ? { ...direction, notes: (direction.notes ?? []).filter((n) => n.reply !== null) } : null,
      status: "done",
      result: { ...result, restoredFrom: source.id, restoredHow: how },
      requestedBy: by,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    return { instant: true };
  }
  await requestCutWith(db, projectId, by, source, direction, how);
  return { instant: false };
}

/** An older version made again from its own choices. */
async function requestCutWith(db: Db, projectId: number, by: string, source: Row, direction: Direction | null, how: RestoredHow): Promise<CutView> {
  const d: Direction = { ...(direction ?? {}), notes: (direction?.notes ?? []).filter((n) => n.reply !== null), restoredFrom: source.id, restoredHow: how };
  return requestCut(db, projectId, by, { scriptId: source.scriptId, leadRole: source.leadRole, direction: d, counted: false });
}

/** A version's own choices: a "go back" copy stands for the version it went back to. */
async function doneRows(db: Db, projectId: number) {
  const rows = await db.select({ id: cuts.id, result: cuts.result, direction: cuts.direction }).from(cuts).where(and(eq(cuts.projectId, projectId), eq(cuts.status, "done"))).orderBy(asc(cuts.id));
  const back = (r: (typeof rows)[number]) => (r.result as CutResult | null)?.restoredFrom ?? (r.direction as Direction | null)?.restoredFrom ?? null;
  const ids = new Set(rows.map((r) => r.id));
  const original = (id: number): number => {
    for (let seen = 0, at = id; seen < 50; seen++) {
      const r = rows.find((x) => x.id === at);
      const to = r ? back(r) : null;
      if (!to || !ids.has(to)) return at;
      at = to;
    }
    return id;
  };
  // The versions that were changes, not trips back.
  const made = rows.filter((r) => !back(r)).map((r) => r.id);
  const newest = rows.at(-1);
  const picked = newest && back(newest) ? ((newest.result as CutResult | null)?.restoredHow ?? (newest.direction as Direction | null)?.restoredHow) === "picked" : false;
  return { newest: newest?.id ?? null, original, made, picked, before: rows.at(-2)?.id ?? null };
}

/**
 * Undo: one step back through the changes. Going back is itself a version, so undo again keeps walking back (not
 * flipping between two), and redo walks forward again. Right after picking a version from the list, undo takes you
 * back to where you were.
 */
export async function undoVersion(db: Db, projectId: number, by: string): Promise<{ instant: boolean; to: number }> {
  const { newest, original, made, picked, before: previous } = await doneRows(db, projectId);
  if (picked && previous) {
    const to = original(previous);
    return { ...(await restoreVersion(db, projectId, to, by, "undo")), to };
  }
  const at = newest ? original(newest) : null;
  const before = at ? made.filter((id) => id < at).at(-1) : undefined;
  if (!before) throw new CutError("There's nothing to undo yet: this is the first cut.");
  return { ...(await restoreVersion(db, projectId, before, by, "undo")), to: before };
}

/** Redo: forward again to the change after the one you're on. */
export async function redoVersion(db: Db, projectId: number, by: string): Promise<{ instant: boolean; to: number }> {
  const { newest, original, made } = await doneRows(db, projectId);
  const at = newest ? original(newest) : null;
  const after = at ? made.find((id) => id > at) : undefined;
  if (!after) throw new CutError("There's nothing to redo: this is the newest change.");
  return { ...(await restoreVersion(db, projectId, after, by, "redo")), to: after };
}

/** Takes one change out of the current cut, keeping everything else: Loupe makes that version. */
export async function removeChange(db: Db, projectId: number, key: string, by: string): Promise<void> {
  const { done } = await sceneCuts(db, projectId);
  if (!done?.result) throw new CutError("There's no cut yet.");
  if (key === "lead") {
    await requestCut(db, projectId, by, { leadRole: null, words: "Whose scene: both actors." });
    return;
  }
  const d = done.direction ?? {};
  const change = changesOf(d, null).find((c) => c.key === key);
  if (!change) throw new CutError("That change isn't in the cut any more.");
  await requestCut(db, projectId, by, { direction: without(d, key), words: `Take this change back out: ${change.label}.` });
}
