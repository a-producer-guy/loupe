// The 4K version of a final (Guy, Oct 7: "the topaz upscale option"): Topaz on fal enlarges the final made from the
// camera originals (final.ts) to 4K, faithfully (Proteus: sharpens without changing faces), and it's put beside it in
// "Loupe Cut/Final". fal reads the final through a signed, read-only link. fal's request is saved the moment it's
// made, so a restarted worker waits for it instead of paying twice. Brought over from Reelarc Footage's 4K step,
// with its settings as tested there (Oct 1). Safe to restart at any time.

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { FalError, FalTimeout, type FalClient, type FalRequest } from "../ai/fal.js";
import type { Sql } from "../jobs.js";
import { audioStreams, mainVideoStream, probe, runFfmpeg, type ProbeResult, type ProbeStream, type Tools } from "../proxy.js";
import type { Storage } from "../storage.js";

export const TOPAZ_ENDPOINT = "fal-ai/topaz/upscale/video";
/**
 * Faithful: Proteus sharpens without changing faces, keeps a little skin texture and adds a whisper of grain.
 * (Starlight, the generative family, invented wrinkles and pores on a close-up and took 8 minutes per 5 seconds:
 * tested in Footage, Oct 1.)
 */
export const TOPAZ_SETTINGS = { model: "Proteus", noise: 0.05, compression: 0.3, halo: 0.1, recover_detail: 0.7, grain: 0.02, H264_output: true } as const;
/** fal's price for 4K output, per second of video (twice that above 30 frames a second). */
export const PRICE_PER_SECOND = 0.08;
/** Anything longer is turned away before a cent is spent. */
export const MAX_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 2;
/** How long fal's link to the final works (it reads it as soon as Topaz starts). */
const LINK_SECONDS = 12 * 60 * 60;

export type TopazJob = { id: number; cut_id: number; project_id: number; attempts: number; request: FalRequest | null };

export type TopazContext = {
  sql: Sql;
  storage: Storage;
  fal: FalClient;
  tools: Tools;
  workDir: string;
  workerId: string;
  signal: AbortSignal;
  log: (line: string) => void;
};

class PermanentTopazError extends Error {}

/** How much to enlarge a picture so it fills 4K (3840×2160, either way up); 1 when it already does. */
export function upscaleFactor(width: number, height: number): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!long || !short) return 1;
  const factor = Math.floor(Math.min(3840 / long, 2160 / short) * 100) / 100;
  // Within 10% of 4K is 4K: enlarging it further would cost the full price for nothing visible.
  return factor < 1.1 ? 1 : Math.min(4, factor);
}

export function frameRate(rate: string | undefined): number {
  const [n, d] = (rate ?? "").split("/").map(Number);
  return n > 0 && d > 0 ? n / d : n > 0 && !d ? n : 0;
}

export const costOf = (seconds: number, fps: number) => Math.round(seconds * PRICE_PER_SECOND * (fps > 30.5 ? 2 : 1) * 100) / 100;

/** Rec. 709 labels for the 4K file when the final is Rec. 709 (or unlabelled HD): Topaz leaves them off. */
export function rec709(video: ProbeStream): { full: boolean } | null {
  const known = [video.color_primaries, video.color_transfer, video.color_space].filter((v) => v && v !== "unknown" && v !== "reserved");
  if (known.some((v) => v !== "bt709")) return null;
  if (!known.length && (video.height ?? 0) < 720) return null;
  return { full: video.color_range === "pc" };
}

/** The 4K file: Topaz's picture as it is, the final's own sound, colour labels, and playable straight away. */
export function finishArgs(o: { made: string; link: string; out: string; topaz: ProbeResult; source: ProbeResult }): string[] {
  const picture = mainVideoStream(o.topaz);
  const sourcePicture = mainVideoStream(o.source);
  const args = ["-v", "error", "-y", "-i", o.made];
  const sound = audioStreams(o.source).length > 0;
  if (sound) args.push("-i", o.link);
  args.push("-map", "0:v:0", "-c:v", "copy");
  // The final's own mix, always: Topaz's copy of it can be re-encoded.
  if (sound) args.push("-map", "1:a:0", "-c:a", "copy");
  const colour = sourcePicture ? rec709(sourcePicture) : null;
  if (colour) {
    const bsf = picture?.codec_name === "h264" ? "h264_metadata" : picture?.codec_name === "hevc" ? "hevc_metadata" : null;
    if (bsf) args.push("-bsf:v", `${bsf}=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=${colour.full ? 1 : 0}`);
    args.push("-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", colour.full ? "pc" : "tv");
  }
  args.push("-shortest", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", o.out);
  return args;
}

/** A failure's reason for the scene page, without the signed link FFmpeg's messages can carry. */
export const withoutLinks = (message: string) => message.replace(/https?:\/\/\S+/g, "(the final's link)");

/** Takes the oldest waiting 4K version whose final from the originals is made, or returns null. */
export async function claimTopaz(sql: Sql, workerId: string): Promise<TopazJob | null> {
  const rows = await sql`
    update loupe_finals f
       set status = 'working', attempts = f.attempts + 1, locked_by = ${workerId}, locked_at = now(),
           started_at = coalesce(f.started_at, now()), progress = 0, error = null
     where f.id = (
       select t.id from loupe_finals t
        where t.status = 'waiting' and t.kind = 'topaz'
          and exists (select 1 from loupe_finals o where o.cut_id = t.cut_id and o.kind = 'original' and o.status = 'done')
        order by t.id limit 1 for update skip locked)
    returning f.id, f.cut_id, f.project_id, f.attempts, f.request`;
  const r = rows[0];
  return r ? { id: Number(r.id), cut_id: Number(r.cut_id), project_id: Number(r.project_id), attempts: Number(r.attempts), request: (r.request as FalRequest | null) ?? null } : null;
}

async function touch(sql: Sql, id: number, workerId: string, progress?: number): Promise<boolean> {
  const rows =
    progress === undefined
      ? await sql`update loupe_finals set locked_at = now() where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`
      : await sql`update loupe_finals set locked_at = now(), progress = ${progress} where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`;
  return rows.length > 0;
}

async function save(url: string, file: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Topaz's file wouldn't download (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(file), { signal });
}

/** Makes one 4K version and records how it went. */
export async function runTopaz(ctx: TopazContext, job: TopazJob) {
  const controller = new AbortController();
  const stop = () => controller.abort(ctx.signal.reason ?? new Error("Stopped"));
  ctx.signal.addEventListener("abort", stop, { once: true });
  const beat = setInterval(() => {
    touch(ctx.sql, job.id, ctx.workerId)
      .then((ours) => !ours && controller.abort(new Error("The 4K version was taken back.")))
      .catch(() => {});
  }, 30_000);
  const signal = controller.signal;
  const log = (line: string) => ctx.log(`[4K ${job.id}, cut ${job.cut_id}] ${line}`);
  let dir: string | undefined;
  let forgetRequest = false;
  try {
    const [original] = await ctx.sql`
      select storage_key from loupe_finals where cut_id = ${job.cut_id} and kind = 'original' and status = 'done' order by id desc limit 1`;
    if (!original?.storage_key) throw new PermanentTopazError("The final this is made from isn't there any more.");
    const sourceKey = String(original.storage_key);
    const link = await ctx.storage.signGet(sourceKey, LINK_SECONDS);
    const source = await probe(ctx.tools, link).catch(() => {
      throw new Error("The final couldn't be read.");
    });
    const video = mainVideoStream(source);
    if (!video?.width || !video.height) throw new PermanentTopazError("The final has no picture to make 4K.");
    const seconds = Number(source.format.duration ?? video.duration ?? 0);
    if (!(seconds > 0)) throw new PermanentTopazError("The final's length couldn't be read.");
    if (seconds > MAX_SECONDS) throw new PermanentTopazError(`This cut is ${Math.round(seconds / 60)} minutes long; 4K versions are for scenes up to 15 minutes.`);
    const fps = frameRate(video.avg_frame_rate ?? video.r_frame_rate);
    const factor = upscaleFactor(video.width, video.height);
    if (factor === 1) throw new PermanentTopazError(`The final is ${video.width}×${video.height} already: it's 4K.`);

    await mkdir(ctx.workDir, { recursive: true });
    const disk = await statfs(ctx.workDir);
    if (disk.bavail * disk.bsize < Math.max(2e9, seconds * 8e6 + 1e9)) throw new Error("Loupe's worker is short of room right now; it'll try again shortly.");
    dir = await mkdtemp(path.join(ctx.workDir, `topaz-${job.id}-`));

    let request = job.request;
    if (request) {
      log(`waiting for Topaz (request ${request.request_id}, from an earlier try).`);
    } else {
      request = await ctx.fal.submit(TOPAZ_ENDPOINT, { video_url: link, upscale_factor: factor, ...TOPAZ_SETTINGS }, signal);
      const saved = await ctx.sql`update loupe_finals set request = ${ctx.sql.json(request as never)}, progress = 0.1 where id = ${job.id} and locked_by = ${ctx.workerId} and status = 'working' returning id`;
      if (!saved.length) throw new Error("The 4K version was taken back.");
      log(`sent to Topaz: ${TOPAZ_SETTINGS.model}, ${video.width}×${video.height} ×${factor}, ${seconds.toFixed(0)} s, about $${costOf(seconds, fps).toFixed(2)}.`);
    }
    const output = await ctx.fal.wait<{ video?: { url?: string } }>(request, { signal, timeoutMs: 4 * 60 * 60_000, pollMs: 15_000 }).catch((error) => {
      // fal failed it (not just slow): the next try asks again.
      if (error instanceof FalError && !(error instanceof FalTimeout)) forgetRequest = true;
      throw error;
    });
    if (!output.video?.url) {
      forgetRequest = true;
      throw new Error("Topaz sent no video back.");
    }
    await touch(ctx.sql, job.id, ctx.workerId, 0.8);

    const made = path.join(dir, "topaz.mp4");
    await save(output.video.url, made, signal);
    const topaz = await probe(ctx.tools, made);
    const picture = mainVideoStream(topaz);
    const madeSeconds = Number(topaz.format.duration ?? picture?.duration ?? 0);
    const wide = Math.round(video.width * factor);
    if (!picture?.width || !picture.height || picture.width < wide * 0.9 || Math.abs(madeSeconds - seconds) > Math.max(1, seconds * 0.02)) {
      forgetRequest = true;
      throw new Error(`Topaz sent back ${picture?.width ?? 0}×${picture?.height ?? 0} and ${madeSeconds.toFixed(1)} s, not about ${wide} wide and ${seconds.toFixed(1)} s.`);
    }
    const out = path.join(dir, "4k.mp4");
    await runFfmpeg(ctx.tools, finishArgs({ made, link, out, topaz, source }), { signal, durationSec: madeSeconds, stallMs: 10 * 60_000 });
    const size = (await stat(out)).size;
    const key = sourceKey.replace(/ \(final [0-9x]+\)\.mp4$/, "").replace(/\.mp4$/, "") + ` (4K Topaz ${picture.width}x${picture.height}).mp4`;
    await ctx.storage.upload(key, out, "video/mp4", signal);
    if ((await ctx.storage.size(key)) !== size) throw new Error("B2 doesn't hold all of the 4K version.");
    await ctx.sql`
      update loupe_finals set status = 'done', progress = 1, storage_key = ${key}, size_bytes = ${size}, width = ${picture.width}, height = ${picture.height},
             cost = ${costOf(seconds, fps)}, error = null, finished_at = now(), locked_by = null, locked_at = null
       where id = ${job.id} and locked_by = ${ctx.workerId}`;
    log(`done: ${picture.width}×${picture.height}, ${(size / 1e6).toFixed(0)} MB, about $${costOf(seconds, fps).toFixed(2)}.`);
  } catch (error) {
    if (ctx.signal.aborted) {
      await ctx.sql`update loupe_finals set status = 'waiting', attempts = greatest(attempts - 1, 0), locked_by = null, locked_at = null where id = ${job.id} and locked_by = ${ctx.workerId}`.catch(() => {});
      return;
    }
    const message = withoutLinks(error instanceof Error ? error.message : String(error));
    const giveUp = error instanceof PermanentTopazError || job.attempts >= MAX_ATTEMPTS;
    await ctx.sql`
      update loupe_finals set status = ${giveUp ? "failed" : "waiting"}, error = ${message.slice(0, 500)}, finished_at = ${giveUp ? ctx.sql`now()` : null},
             locked_by = null, locked_at = null, request = ${forgetRequest ? null : ctx.sql`request`}
       where id = ${job.id} and locked_by = ${ctx.workerId}`.catch((e) => log(`couldn't record the failure: ${e}`));
    log(`failed: ${message}`);
  } finally {
    clearInterval(beat);
    ctx.signal.removeEventListener("abort", stop);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Takes 4K versions off the queue one at a time until `signal` stops it (needs FAL_KEY). */
export async function runTopazLoop(ctx: TopazContext & { sleep: (ms: number) => Promise<void> }) {
  ctx.log("4K (Topaz): on.");
  while (!ctx.signal.aborted) {
    try {
      const job = await claimTopaz(ctx.sql, ctx.workerId);
      if (!job) {
        await ctx.sleep(15_000);
        continue;
      }
      await runTopaz(ctx, job);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Before the database has the 4K columns (migration 0003): wait quietly.
      if (code === "42P01" || code === "42703") {
        await ctx.sleep(10 * 60_000);
        continue;
      }
      ctx.log(`4K: ${(error as Error).message}`);
      await ctx.sleep(60_000);
    }
  }
}
