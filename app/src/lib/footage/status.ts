// What each shoot's status line says. "Safe to wipe" is worked out here from
// the file rows (never from the browser), so every screen agrees.

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { files, projects, proxyJobs, type ClipMedia, type FileStatus, type JobStatus, type ProjectStatus } from "@/lib/db/schema";
import { shootLuts, type Lut } from "./luts";
import { searchWords, thumbnailKey } from "./names";

/**
 * Turns a still's storage key into a link the browser can show; `version`
 * changes the link when the still changes. Tests pass a stand-in.
 */
export type SignView = (key: string, version?: string) => Promise<string>;

/** Stills made with a LUT get a link of their own, so a new look shows right away. */
const stillVersion = (madeWithLutId: number | null | undefined) => (madeWithLutId ? `look-${madeWithLutId}` : undefined);

export type FileCounts = {
  total: number;
  uploaded: number;
  problems: number;
  bytesTotal: number;
  bytesUploaded: number;
};

export type ProxyCounts = {
  videos: number;
  done: number;
  skipped: number;
  failed: number;
  running: number;
  queued: number;
  /** 0 to 1 across every clip, counting clips mid-conversion. */
  progress: number;
};

export type CardSummary = { card: string; files: FileCounts; safeToWipe: boolean };

export type ShootSummary = {
  id: number;
  name: string;
  shootDate: string;
  storagePrefix: string;
  /** Who shot it, when someone has said. */
  dpName: string | null;
  status: ProjectStatus;
  files: FileCounts;
  cards: CardSummary[];
  proxies: ProxyCounts;
  /** Every file on every card dropped so far is in B2 at the right size. */
  safeToWipe: boolean;
  proxiesReady: boolean;
  /** Total length of the clips whose proxies are done. */
  runtimeSeconds: number;
  /** A still from the shoot's first finished clip, for its tile. */
  coverUrl: string | null;
};

export type ClipRow = {
  id: number;
  card: string;
  path: string;
  sizeBytes: number;
  status: FileStatus;
  proxy: {
    jobId: number;
    status: JobStatus;
    progress: number | null;
    error: string | null;
    attempts: number;
    /** An existing proxy being made again because its shoot's or card's LUT changed. */
    lookUpdating: boolean;
  } | null;
  media: ClipMedia | null;
  thumbUrl: string | null;
  /** A browser-playable preview exists (the player asks for its link). */
  preview: boolean;
};

export type ShootDetail = ShootSummary & {
  /** The LUT the shoot was filmed with, and the cards that used a different one. */
  lut: Lut | null;
  cardLuts: { card: string; lut: Lut | null }[];
  clips: ClipRow[];
  problems: { card: string; path: string; problem: string }[];
  otherFiles: { count: number; bytes: number };
};

const emptyFiles = (): FileCounts => ({ total: 0, uploaded: 0, problems: 0, bytesTotal: 0, bytesUploaded: 0 });

const fileCountColumns = {
  total: sql<number>`count(*)::int`,
  uploaded: sql<number>`(count(*) filter (where ${files.status} = 'uploaded'))::int`,
  problems: sql<number>`(count(*) filter (where ${files.status} = 'unreadable'))::int`,
  bytesTotal: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8`,
  bytesUploaded: sql<number>`coalesce(sum(${files.sizeBytes}) filter (where ${files.status} = 'uploaded'), 0)::float8`,
};

const isSafe = (counts: FileCounts) => counts.total > 0 && counts.uploaded === counts.total;

async function summarize(db: Db, rows: (typeof projects.$inferSelect)[], signView?: SignView): Promise<ShootSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const cardRows = await db
    .select({ projectId: files.projectId, card: files.card, ...fileCountColumns })
    .from(files)
    .where(inArray(files.projectId, ids))
    .groupBy(files.projectId, files.card)
    .orderBy(asc(files.card));

  const videoRows = await db
    .select({ projectId: files.projectId, videos: sql<number>`count(*)::int` })
    .from(files)
    .where(and(inArray(files.projectId, ids), eq(files.isVideo, true), sql`${files.status} <> 'unreadable'`))
    .groupBy(files.projectId);

  const jobRows = await db
    .select({
      projectId: proxyJobs.projectId,
      done: sql<number>`(count(*) filter (where ${proxyJobs.status} = 'done'))::int`,
      skipped: sql<number>`(count(*) filter (where ${proxyJobs.status} = 'skipped'))::int`,
      failed: sql<number>`(count(*) filter (where ${proxyJobs.status} = 'failed'))::int`,
      running: sql<number>`(count(*) filter (where ${proxyJobs.status} = 'running'))::int`,
      queued: sql<number>`(count(*) filter (where ${proxyJobs.status} = 'queued'))::int`,
      runningProgress: sql<number>`coalesce(sum(${proxyJobs.progress}) filter (where ${proxyJobs.status} = 'running'), 0)::float8`,
      runtime: sql<number>`coalesce(sum((${proxyJobs.media} ->> 'durationSeconds')::float8) filter (where ${proxyJobs.status} = 'done'), 0)::float8`,
      cover: sql<string | null>`min(${proxyJobs.proxyKey}) filter (where ${proxyJobs.status} = 'done' and ${proxyJobs.media} is not null)`,
      coverLook: sql<number | null>`(array_agg(${proxyJobs.madeWithLutId} order by ${proxyJobs.proxyKey}) filter (where ${proxyJobs.status} = 'done' and ${proxyJobs.media} is not null))[1]`,
    })
    .from(proxyJobs)
    .where(inArray(proxyJobs.projectId, ids))
    .groupBy(proxyJobs.projectId);
  const covers = new Map<number, string>();
  if (signView) {
    await Promise.all(
      jobRows
        .filter((j) => j.cover)
        .map(async (j) => covers.set(j.projectId, await signView(thumbnailKey(j.cover!), stillVersion(j.coverLook)))),
    );
  }

  return rows.map((project) => {
    const cards = cardRows
      .filter((c) => c.projectId === project.id)
      .map((c) => {
        const counts = { total: c.total, uploaded: c.uploaded, problems: c.problems, bytesTotal: c.bytesTotal, bytesUploaded: c.bytesUploaded };
        return { card: c.card, files: counts, safeToWipe: isSafe(counts) };
      });
    const totals = cards.reduce((sum, c) => {
      for (const k of Object.keys(sum) as (keyof FileCounts)[]) sum[k] += c.files[k];
      return sum;
    }, emptyFiles());
    const videos = videoRows.find((v) => v.projectId === project.id)?.videos ?? 0;
    const jobs = jobRows.find((j) => j.projectId === project.id);
    const finished = (jobs?.done ?? 0) + (jobs?.skipped ?? 0);
    const safeToWipe = isSafe(totals);
    return {
      id: project.id,
      name: project.name,
      shootDate: project.shootDate,
      storagePrefix: project.storagePrefix,
      dpName: project.dpName,
      status: project.status,
      files: totals,
      cards,
      proxies: {
        videos,
        done: jobs?.done ?? 0,
        skipped: jobs?.skipped ?? 0,
        failed: jobs?.failed ?? 0,
        running: jobs?.running ?? 0,
        queued: jobs?.queued ?? 0,
        progress: videos ? Math.min(1, (finished + (jobs?.runningProgress ?? 0)) / videos) : 0,
      },
      safeToWipe,
      proxiesReady: safeToWipe && finished >= videos,
      runtimeSeconds: jobs?.runtime ?? 0,
      coverUrl: covers.get(project.id) ?? null,
    };
  });
}

/** Shoots dated between the two days (YYYY-MM-DD), newest first. */
export async function listShoots(db: Db, fromDate: string, toDate: string, signView?: SignView): Promise<ShootSummary[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(gte(projects.shootDate, fromDate), lte(projects.shootDate, toDate)))
    .orderBy(desc(projects.shootDate), desc(projects.id));
  return summarize(db, rows, signView);
}

/** Every shoot, from any date, whose name, DP or date contains all the words searched for. Newest first. */
export async function searchShoots(db: Db, query: string, signView?: SignView, limit = 60): Promise<ShootSummary[]> {
  const words = searchWords(query);
  if (words.length === 0) return [];
  // The same text as shootSearchText, built by the database.
  const text = sql`lower(${projects.name} || ' ' || coalesce(${projects.dpName} || ' ', '') || to_char(${projects.shootDate}, 'YYYY-MM-DD FMMonth Mon FMDD') || ' p' || ${projects.id})`;
  const rows = await db
    .select()
    .from(projects)
    .where(and(...words.map((word) => sql`strpos(${text}, ${word}) > 0`)))
    .orderBy(desc(projects.shootDate), desc(projects.id))
    .limit(limit);
  return summarize(db, rows, signView);
}

export async function getShoot(db: Db, id: number, signView?: SignView): Promise<ShootDetail | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return null;
  const [summary] = await summarize(db, [project], signView);

  const clipRows = await db
    .select({
      id: files.id,
      card: files.card,
      path: files.path,
      sizeBytes: files.sizeBytes,
      status: files.status,
      jobId: proxyJobs.id,
      jobStatus: proxyJobs.status,
      progress: proxyJobs.progress,
      error: proxyJobs.error,
      attempts: proxyJobs.attempts,
      proxyKey: proxyJobs.proxyKey,
      media: proxyJobs.media,
      proxySize: proxyJobs.proxySizeBytes,
      previewSize: proxyJobs.previewSizeBytes,
      lutId: proxyJobs.lutId,
      madeWithLutId: proxyJobs.madeWithLutId,
    })
    .from(files)
    .leftJoin(proxyJobs, eq(proxyJobs.fileId, files.id))
    .where(and(eq(files.projectId, id), eq(files.isVideo, true), sql`${files.status} <> 'unreadable'`))
    .orderBy(asc(files.path));

  const problems = await db
    .select({ card: files.card, path: files.path, problem: files.problem })
    .from(files)
    .where(and(eq(files.projectId, id), eq(files.status, "unreadable")))
    .orderBy(asc(files.path));

  const [other] = await db
    .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8` })
    .from(files)
    .where(and(eq(files.projectId, id), eq(files.isVideo, false), sql`${files.status} <> 'unreadable'`));

  // A clip keeps showing its still while its proxy is re-made with a new LUT.
  const thumbs = new Map<number, string>();
  if (signView) {
    await Promise.all(
      clipRows
        .filter((row) => (row.jobStatus === "done" || row.proxySize !== null) && row.media && row.proxyKey)
        .map(async (row) => thumbs.set(row.id, await signView(thumbnailKey(row.proxyKey!), stillVersion(row.madeWithLutId)))),
    );
  }
  const looks = await shootLuts(db, id);

  return {
    ...summary,
    lut: looks.lut,
    cardLuts: looks.cards,
    clips: clipRows.map((row) => ({
      id: row.id,
      card: row.card,
      path: row.path,
      sizeBytes: row.sizeBytes,
      status: row.status,
      proxy:
        row.jobId === null
          ? null
          : {
              jobId: row.jobId,
              status: row.jobStatus!,
              progress: row.progress,
              error: row.error,
              attempts: row.attempts ?? 0,
              lookUpdating:
                (row.jobStatus === "queued" || row.jobStatus === "running") &&
                row.proxySize !== null &&
                row.lutId !== row.madeWithLutId,
            },
      media: row.media ?? null,
      thumbUrl: thumbs.get(row.id) ?? null,
      preview: row.previewSize !== null && row.previewSize !== undefined,
    })),
    problems: problems.map((p) => ({ ...p, problem: p.problem ?? "Couldn't be copied." })),
    otherFiles: other ?? { count: 0, bytes: 0 },
  };
}
