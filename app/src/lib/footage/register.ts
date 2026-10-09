// Recording a drop: before a single byte uploads, every file on the card gets a
// row, so the shoot knows exactly what "everything" means. That list is what
// "safe to wipe cards" is checked against later.

import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { files, projects } from "@/lib/db/schema";
import { accountPlan, accountUsage, PLAN_LIMITS } from "./access";
import { cardNameCandidates, cleanRelativePath, formatBytes, isHiddenPath, isVideoPath, keyFits, rawPath } from "./names";

export type DroppedFile = { path: string; size: number; lastModified: number };

/** One top-level item of a drop: a card folder, or "" for loose files. */
export type DropGroup = {
  name: string;
  files: DroppedFile[];
  /** Paths the browser saw but couldn't read (a failing card, a locked folder). */
  unreadable?: string[];
};

export type RegisteredFile = {
  path: string;
  key: string;
  size: number;
  /** upload: send it. resume: part of it is already in B2. done: already uploaded and checked. */
  state: "upload" | "resume" | "done";
  uploadId?: string;
};

export type RegisteredGroup = {
  name: string;
  /** The folder it actually went into under Raw/ (can differ from the name, e.g. "Untitled 2"). */
  card: string;
  files: RegisteredFile[];
  problems: { path: string; problem: string }[];
};

export class DropError extends Error {}

export const UNREADABLE = "Couldn't be read from the card. Don't wipe this card; drop it again to retry.";
export const UNSTORABLE = "This file's name or folder path can't be stored. Rename it and drop it again.";

export async function registerDrop(
  db: Db,
  projectId: number,
  groups: DropGroup[],
  uploadedBy: string,
): Promise<RegisteredGroup[]> {
  return db.transaction(async (tx) => {
    // One drop at a time per shoot, so two cards called "Untitled" dropped
    // together can't both claim the same folder.
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw new DropError("That scene doesn't exist any more.");

    const results: RegisteredGroup[] = [];
    for (const group of groups) results.push(await registerGroup(tx, project, group, uploadedBy));

    // The footage limit for scenes waiting to be exported (pay-as-you-go), checked with this drop counted (a card dropped again isn't
    // counted twice). Over it, the whole drop is undone and nothing uploads.
    const limit = PLAN_LIMITS[await accountPlan(tx, project.accountId)].bytes;
    if (Number.isFinite(limit)) {
      const used = await accountUsage(tx, project.accountId);
      if (used.bytes > limit) {
        throw new DropError(
          `That's more footage than scenes waiting to be exported can hold (${formatBytes(limit)} in all). Export a scene or choose Pro to upload more, or drop fewer cards.`,
        );
      }
    }

    const anythingToUpload = results.some((g) => g.problems.length > 0 || g.files.some((f) => f.state !== "done"));
    if (anythingToUpload && (project.status === "scheduled" || project.status === "uploaded")) {
      await tx.update(projects).set({ status: "uploading" }).where(eq(projects.id, projectId));
    }
    return results;
  });
}

type Project = typeof projects.$inferSelect;
type FileRow = Pick<
  typeof files.$inferSelect,
  "id" | "path" | "storageKey" | "sizeBytes" | "lastModifiedMs" | "status" | "uploadId"
>;

function cleanCardName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[/\\\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 120);
}

async function registerGroup(tx: Db, project: Project, group: DropGroup, uploadedBy: string): Promise<RegisteredGroup> {
  const problems: RegisteredGroup["problems"] = [];
  const incoming: { rel: string; size: number; lastModified: number }[] = [];
  const seen = new Set<string>();

  for (const file of group.files) {
    const rel = cleanRelativePath(file.path);
    if (rel && isHiddenPath(rel)) continue;
    if (!rel || !Number.isSafeInteger(file.size) || file.size < 0) {
      problems.push({ path: file.path, problem: UNSTORABLE });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    incoming.push({ rel, size: file.size, lastModified: Math.round(Number(file.lastModified) || 0) });
  }
  for (const path of group.unreadable ?? []) problems.push({ path, problem: UNREADABLE });

  // Pick the card's folder: the first name where nothing already there would be
  // overwritten by a different file. Re-dropping the same card finds its own
  // folder again (same names, sizes and dates), which is how resuming works.
  const cardName = cleanCardName(group.name);
  let card: string | undefined;
  let existing = new Map<string, FileRow>();
  for (const candidate of cardNameCandidates(cardName)) {
    const rows: FileRow[] = await tx
      .select({
        id: files.id,
        path: files.path,
        storageKey: files.storageKey,
        sizeBytes: files.sizeBytes,
        lastModifiedMs: files.lastModifiedMs,
        status: files.status,
        uploadId: files.uploadId,
      })
      .from(files)
      .where(and(eq(files.projectId, project.id), eq(files.card, candidate)));
    const byPath = new Map(rows.map((row) => [row.path, row]));
    const matches = (row: FileRow | undefined, file: (typeof incoming)[number]) =>
      row !== undefined && row.sizeBytes === file.size && row.lastModifiedMs === file.lastModified;
    const clash = incoming.some((file) => {
      const row = byPath.get(rawPath(candidate, file.rel));
      return row !== undefined && row.status !== "unreadable" && !matches(row, file);
    });
    // A folder that couldn't be read last time has an unknown number of files.
    // Only treat new files inside it as that same folder when the rest of the
    // drop proves it's the same card; otherwise a different card with the same
    // name could make the unread folder look finished.
    const sameCard = incoming.some((file) => {
      const row = byPath.get(rawPath(candidate, file.rel));
      return row?.status !== "unreadable" && matches(row, file);
    });
    const intoUnreadFolder = rows.some(
      (row) =>
        row.status === "unreadable" && incoming.some((file) => rawPath(candidate, file.rel).startsWith(`${row.path}/`)),
    );
    if (!clash && (sameCard || !intoUnreadFolder)) {
      card = candidate;
      existing = byPath;
      break;
    }
  }
  if (card === undefined) throw new DropError(`There are too many cards called "${cardName}" in this scene.`);

  // Folders that couldn't be read before and were read this time.
  const stillUnreadable = new Set(problems.map((p) => rawPath(card!, cleanRelativePath(p.path) ?? p.path)));
  for (const row of existing.values()) {
    if (row.status !== "unreadable" || stillUnreadable.has(row.path)) continue;
    if (incoming.some((file) => rawPath(card!, file.rel).startsWith(`${row.path}/`))) {
      await tx.delete(files).where(eq(files.id, row.id));
      existing.delete(row.path);
    }
  }

  const registered: RegisteredFile[] = [];
  const inserts: (typeof files.$inferInsert)[] = [];

  for (const file of incoming) {
    const path = rawPath(card, file.rel);
    const key = `${project.storagePrefix}/${path}`;
    if (!keyFits(key)) {
      problems.push({ path: file.rel, problem: UNSTORABLE });
      continue;
    }
    const row = existing.get(path);
    if (!row) {
      inserts.push({
        projectId: project.id,
        card,
        path,
        storageKey: key,
        sizeBytes: file.size,
        lastModifiedMs: file.lastModified,
        isVideo: isVideoPath(path),
        status: "pending",
        uploadedBy,
      });
      registered.push({ path: file.rel, key, size: file.size, state: "upload" });
    } else if (row.status === "unreadable") {
      // Couldn't be read last time, can be now.
      await tx
        .update(files)
        .set({ sizeBytes: file.size, lastModifiedMs: file.lastModified, status: "pending", problem: null })
        .where(eq(files.id, row.id));
      registered.push({ path: file.rel, key: row.storageKey, size: file.size, state: "upload" });
    } else if (row.status === "uploaded") {
      registered.push({ path: file.rel, key: row.storageKey, size: file.size, state: "done" });
    } else {
      registered.push({
        path: file.rel,
        key: row.storageKey,
        size: file.size,
        state: row.uploadId ? "resume" : "upload",
        uploadId: row.uploadId ?? undefined,
      });
    }
  }

  // Files that can't be copied still get a row, so the card never counts as
  // complete until they're sorted out.
  for (const { path: rel, problem } of problems) {
    // "." means the card itself couldn't be opened.
    const safeRel = rel === "." ? "" : (cleanRelativePath(rel.replace(/[\u0000-\u001f\u007f]/g, "_")) ?? "unnamed");
    const path = safeRel ? rawPath(card, safeRel) : card ? `Raw/${card}` : "Raw";
    const row = existing.get(path);
    if (row?.status === "uploaded") continue;
    if (row) {
      await tx.update(files).set({ status: "unreadable", problem, uploadId: null }).where(eq(files.id, row.id));
      continue;
    }
    let key = `${project.storagePrefix}/${path}`;
    if (!keyFits(key)) key = `${project.storagePrefix}/Raw/${card}/_unstorable-${crypto.randomUUID()}`;
    inserts.push({
      projectId: project.id,
      card,
      path,
      storageKey: key,
      sizeBytes: 0,
      isVideo: false,
      status: "unreadable",
      problem,
    });
  }

  for (let i = 0; i < inserts.length; i += 500) {
    await tx.insert(files).values(inserts.slice(i, i + 500)).onConflictDoNothing();
  }

  return { name: group.name, card, files: registered, problems };
}
