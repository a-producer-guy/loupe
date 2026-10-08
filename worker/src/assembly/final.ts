// The final file of one version of a cut (Guy, Oct 7: "we need to export the final actually"): the same cut as the
// preview, built again from the camera originals at full resolution, with the clips' looks (LUTs), Loupe's grade,
// the push-ins and handheld moves, and the version's own mix. Shot by shot, one camera file on disk at a time
// (clips are gigabytes): each shot becomes a high-quality piece, then the pieces are joined and the mix goes under.
// The file goes in the scene's "Loupe Cut/Final" folder. Safe to restart at any time.

import { mkdir, mkdtemp, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "../jobs.js";
import type { Tools } from "../proxy.js";
import type { Storage } from "../storage.js";
import { ffmpegPipe } from "./audio.js";
import { handheldFilter } from "./camera.js";
import { FPS, frames as fr } from "./engine.js";
import { CUT_FOLDER, FADE_IN, FADE_OUT, shakeOf, zoomFor, type PushIn } from "./finish.js";
import type { AssemblyResult } from "./run.js";

export const FINAL_FOLDER = `${CUT_FOLDER}/Final`;
/** Wider than UHD is brought down to 3840 across: what a final MP4 is for. */
const MAX_WIDTH = 3840;
const MAX_ATTEMPTS = 2;
/** Each shot's piece: near-transparent H.264, so joining them needs no second encode. */
const PIECE_VIDEO = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", "24000/1001", "-g", "48", "-an"];

export type FinalJob = { id: number; cut_id: number; project_id: number; attempts: number };

export type FinalContext = {
  sql: Sql;
  storage: Storage;
  tools: Tools;
  workDir: string;
  workerId: string;
  signal: AbortSignal;
  log: (line: string) => void;
};

/** Takes the oldest waiting final made from the originals, or returns null. */
export async function claimFinal(sql: Sql, workerId: string): Promise<FinalJob | null> {
  const rows = await sql`
    update loupe_finals f
       set status = 'working', attempts = f.attempts + 1, locked_by = ${workerId}, locked_at = now(),
           started_at = coalesce(f.started_at, now()), progress = 0, error = null
     where f.id = (select id from loupe_finals where status = 'waiting' and kind = 'original' order by id limit 1 for update skip locked)
    returning f.id, f.cut_id, f.project_id, f.attempts`;
  return rows[0] ? { id: Number(rows[0].id), cut_id: Number(rows[0].cut_id), project_id: Number(rows[0].project_id), attempts: Number(rows[0].attempts) } : null;
}

async function touchFinal(sql: Sql, id: number, workerId: string, progress?: number): Promise<boolean> {
  const rows =
    progress === undefined
      ? await sql`update loupe_finals set locked_at = now() where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`
      : await sql`update loupe_finals set locked_at = now(), progress = ${progress} where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`;
  return rows.length > 0;
}

async function failFinal(sql: Sql, job: FinalJob, workerId: string, message: string, permanent: boolean) {
  const giveUp = permanent || job.attempts >= MAX_ATTEMPTS;
  await sql`
    update loupe_finals set status = ${giveUp ? "failed" : "waiting"}, error = ${message.slice(0, 500)}, locked_by = null, locked_at = null,
           finished_at = ${giveUp ? sql`now()` : null}
     where id = ${job.id} and locked_by = ${workerId}`;
}

/** Finals whose worker vanished go back in the queue. */
export async function requeueStaleFinals(sql: Sql): Promise<number> {
  const rows = await sql`
    update loupe_finals set status = case when attempts >= ${MAX_ATTEMPTS} then 'failed' else 'waiting' end,
           error = 'Loupe was interrupted while making this; it tries again by itself.', locked_by = null, locked_at = null
     where status = 'working' and locked_at < now() - interval '15 minutes' returning id`;
  return rows.length;
}

class PermanentFinalError extends Error {}

/** The size the final is made at: the takes' own (the commonest, if they differ), no wider than UHD, even numbers. */
export function finalSize(sizes: { width: number; height: number }[]): { width: number; height: number } {
  const counts = new Map<string, number>();
  for (const s of sizes) if (s.width > 0 && s.height > 0) counts.set(`${s.width}x${s.height}`, (counts.get(`${s.width}x${s.height}`) ?? 0) + 1);
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let [width, height] = best ? best[0].split("x").map(Number) : [1920, 1080];
  if (width > MAX_WIDTH) {
    height = Math.round((height * MAX_WIDTH) / width);
    width = MAX_WIDTH;
  }
  return { width: width - (width % 2), height: height - (height % 2) };
}

/** A shot's filters: to the final's size, its look and Loupe's grade, its move, and the fades at either end. */
export function pieceFilter(o: {
  width: number;
  height: number;
  frames: number;
  luts: string[];
  push: PushIn | undefined;
  handheld: boolean;
  piece: number;
  fadeIn: boolean;
  fadeOut: boolean;
}): string {
  const { width: W, height: H } = o;
  const seconds = o.frames / FPS;
  const look = o.luts.filter((l) => /^[\w./ -]+$/.test(l)).map((l) => `,lut3d=file='${l}'`).join("");
  // As the preview moves: handheld, a move and any zoom; steady, a slow push-in (drawn at twice the size up to HD, so it glides).
  const big = W <= 1920 ? 2 : 1;
  const zoom = o.handheld
    ? `,${handheldFilter(shakeOf(o.piece), zoomFor(o.push, seconds), W, H)}`
    : o.push
      ? `,scale=${W * big}:${H * big},scale=w='trunc(${W * big}*(1+${(o.push.scale - 1).toFixed(4)}*t/${seconds.toFixed(3)})/2)*2':h=-2:eval=frame,crop=${W * big}:${H * big}${big > 1 ? `,scale=${W}:${H}` : ""}`
      : "";
  const fades = `${o.fadeIn ? `,fade=t=in:st=0:d=${FADE_IN}` : ""}${o.fadeOut ? `,fade=t=out:st=${Math.max(0, seconds - FADE_OUT).toFixed(3)}:d=${FADE_OUT}` : ""}`;
  return `fps=24000/1001,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1${look}${zoom}${fades}`;
}

/** Makes one final and records how it went. */
export async function runFinal(ctx: FinalContext, job: FinalJob) {
  const controller = new AbortController();
  const stop = () => controller.abort(ctx.signal.reason ?? new Error("Stopped"));
  ctx.signal.addEventListener("abort", stop, { once: true });
  const beat = setInterval(() => {
    touchFinal(ctx.sql, job.id, ctx.workerId)
      .then((ours) => !ours && controller.abort(new Error("The final was taken back.")))
      .catch(() => {});
  }, 30_000);
  const signal = controller.signal;
  const log = (line: string) => ctx.log(`[final ${job.id}, cut ${job.cut_id}] ${line}`);
  let dir: string | undefined;
  try {
    const [row] = await ctx.sql`
      select c.result, p.storage_prefix from loupe_cuts c join loupe_projects p on p.id = c.project_id
       where c.id = ${job.cut_id} and c.status = 'done'`;
    if (!row) throw new PermanentFinalError("That version of the cut isn't there any more.");
    const result = row.result as AssemblyResult;
    const prefix = String(row.storage_prefix);
    const plan = result.render;
    if (!plan) throw new PermanentFinalError("This version was cut before finals existed. Make it again, then export the final.");

    // Each take's camera file, its size and its look, from the scene's files.
    const paths = new Map(result.takes.map((t) => [t.take, t.path]));
    const rows = await ctx.sql`
      select f.path, f.storage_key, f.size_bytes, j.media, l.storage_key as lut_key, l.id as lut_id
        from loupe_files f join loupe_proxy_jobs j on j.file_id = f.id left join loupe_luts l on l.id = j.lut_id
       where f.project_id = ${job.project_id}`;
    const byPath = new Map(rows.map((r) => [String(r.path), r]));
    const used = [...new Set(plan.pieces.map((p) => p.take))];
    const takes = new Map(
      used.map((take) => {
        const r = byPath.get(paths.get(take) ?? "");
        if (!r) throw new PermanentFinalError(`The camera file for take ${take} isn't in the scene any more.`);
        const media = (r.media ?? {}) as { width?: number; height?: number };
        return [take, { key: String(r.storage_key), size: Number(r.size_bytes), width: media.width ?? 0, height: media.height ?? 0, lut: r.lut_key ? { id: Number(r.lut_id), key: String(r.lut_key) } : null }] as const;
      }),
    );
    const size = finalSize([...takes.values()]);

    await mkdir(ctx.workDir, { recursive: true });
    const biggest = Math.max(...[...takes.values()].map((t) => t.size));
    const disk = await statfs(ctx.workDir);
    if (disk.bavail * disk.bsize < biggest * 1.2 + 3e9) throw new Error("Loupe's worker is short of room right now; it'll try again shortly.");
    dir = await mkdtemp(path.join(ctx.workDir, `final-${job.id}-`));
    const folder = `${prefix}/${result.folder ?? CUT_FOLDER}`;

    // The looks: each clip's LUT, then Loupe's grade from a note on the colour.
    const lutFiles = new Map<number, string>();
    for (const t of takes.values()) {
      if (t.lut && !lutFiles.has(t.lut.id)) {
        const file = path.join(dir, `lut-${t.lut.id}.cube`);
        await ctx.storage.download(t.lut.key, file, signal);
        lutFiles.set(t.lut.id, file);
      }
    }
    let grade: string | null = null;
    if (plan.grade) {
      grade = path.join(dir, "grade.cube");
      await ctx.storage.download(`${folder}/${plan.grade}`, grade, signal);
    }
    const mixFile = path.join(dir, "mix.wav");
    await ctx.storage.download(`${folder}/${plan.mix}`, mixFile, signal);

    // The pieces, in timeline order (the establishing shot first, when there is one).
    const segments: string[] = [];
    const total = plan.pieces.length + (plan.intro ? 1 : 0);
    let made = 0;
    const tick = async () => {
      made += 1;
      if (!(await touchFinal(ctx.sql, job.id, ctx.workerId, Math.round((made / (total + 1)) * 100) / 100))) throw new Error("The final was taken back.");
    };
    if (plan.intro) {
      const file = path.join(dir, "establishing.mp4");
      await ctx.storage.download(`${folder}/${plan.intro.path}`, file, signal);
      const seg = path.join(dir, "seg-intro.mp4");
      const frames = fr(plan.intro.seconds);
      await ffmpegPipe(ctx.tools.ffmpeg, ["-v", "error", "-y", "-nostdin", "-i", file, "-vf", pieceFilter({ ...size, frames, luts: [], push: undefined, handheld: false, piece: -1, fadeIn: true, fadeOut: false }), "-frames:v", String(frames), ...PIECE_VIDEO, seg], undefined, signal);
      await rm(file, { force: true });
      segments.push(seg);
      await tick();
    }
    const segFor = (k: number) => path.join(dir!, `seg-${String(k).padStart(4, "0")}.mp4`);
    // One camera file at a time: every shot that uses it, then it's deleted.
    for (const take of used) {
      const t = takes.get(take)!;
      const raw = path.join(dir, `raw${path.extname(t.key) || ".mov"}`);
      log(`take ${take}: ${(t.size / 1e9).toFixed(2)} GB`);
      await ctx.storage.download(t.key, raw, signal);
      for (const [k, p] of plan.pieces.entries()) {
        if (p.take !== take) continue;
        const frames = fr(p.recOut) - fr(p.recIn);
        const filter = pieceFilter({
          ...size,
          frames,
          luts: [...(t.lut ? [lutFiles.get(t.lut.id)!] : []), ...(grade ? [grade] : [])],
          push: plan.pushIns.find((x) => x.piece === k),
          handheld: plan.handheld,
          piece: k,
          fadeIn: k === 0 && !plan.intro,
          fadeOut: k === plan.pieces.length - 1,
        });
        await ffmpegPipe(ctx.tools.ffmpeg, ["-v", "error", "-y", "-nostdin", "-ss", p.in.toFixed(3), "-i", raw, "-vf", filter, "-frames:v", String(frames), ...PIECE_VIDEO, segFor(k)], undefined, signal);
        await tick();
      }
      await rm(raw, { force: true });
    }
    segments.push(...plan.pieces.map((_, k) => segFor(k)));

    // Joined as they are, with the version's own mix under them.
    const list = path.join(dir, "pieces.txt");
    await writeFile(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    const out = path.join(dir, "final.mp4");
    await ffmpegPipe(
      ctx.tools.ffmpeg,
      ["-v", "error", "-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", list, "-i", mixFile, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", out],
      undefined,
      signal,
    );
    const bytes = (await stat(out)).size;
    const key = `${prefix}/${FINAL_FOLDER}/${safeName(result.title)} - Loupe cut v${job.cut_id} (final ${size.width}x${size.height}).mp4`;
    await ctx.storage.upload(key, out, "video/mp4", signal);
    if ((await ctx.storage.size(key)) !== bytes) throw new Error("B2 doesn't hold all of the final.");
    await ctx.sql`
      update loupe_finals set status = 'done', progress = 1, storage_key = ${key}, size_bytes = ${bytes}, width = ${size.width}, height = ${size.height},
             error = null, finished_at = now(), locked_by = null, locked_at = null
       where id = ${job.id} and locked_by = ${ctx.workerId}`;
    log(`done: ${size.width}×${size.height}, ${(bytes / 1e6).toFixed(0)} MB.`);
  } catch (error) {
    if (ctx.signal.aborted) {
      await ctx.sql`update loupe_finals set status = 'waiting', attempts = greatest(attempts - 1, 0), locked_by = null, locked_at = null where id = ${job.id} and locked_by = ${ctx.workerId}`.catch(() => {});
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await failFinal(ctx.sql, job, ctx.workerId, message, error instanceof PermanentFinalError).catch((e) => log(`couldn't record the failure: ${e}`));
    log(`failed: ${message}`);
  } finally {
    clearInterval(beat);
    ctx.signal.removeEventListener("abort", stop);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const safeName = (title: string) => title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 120) || "Scene";

/** Takes finals off the queue one at a time until `signal` stops it. */
export async function runFinalLoop(ctx: FinalContext & { sleep: (ms: number) => Promise<void> }) {
  ctx.log("Finals: on.");
  let lastStale = 0;
  while (!ctx.signal.aborted) {
    try {
      if (Date.now() - lastStale > 5 * 60_000) {
        lastStale = Date.now();
        const n = await requeueStaleFinals(ctx.sql);
        if (n) ctx.log(`Put ${n} interrupted final(s) back in the queue.`);
      }
      const job = await claimFinal(ctx.sql, ctx.workerId);
      if (!job) {
        await ctx.sleep(10_000);
        continue;
      }
      await runFinal(ctx, job);
    } catch (error) {
      if ((error as { code?: string }).code === "42P01") {
        await ctx.sleep(10 * 60_000);
        continue;
      }
      ctx.log(`finals: ${(error as Error).message}`);
      await ctx.sleep(60_000);
    }
  }
}
