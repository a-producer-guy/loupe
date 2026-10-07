// Loupe's worker: an always-on loop that takes waiting proxy jobs, downloads
// each raw clip from B2, makes its ProRes Proxy, uploads it to the scene's
// Proxies/ folder, and records the result. Beside it, with FAL_KEY set, the
// cut loop (assembly/job.ts) cuts scenes one at a time. Safe to restart at any
// time: a job cut off mid-way goes back in the queue.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FalClient } from "./ai/fal.js";
import { runAssemblyLoop, startCutIfReady } from "./assembly/job.js";
import { loadConfig } from "./config.js";
import { claimJob, connect, heartbeat, markDone, markFailed, markSkipped, releaseJobs, requeueStale, type Job } from "./jobs.js";
import { buildThumbnailArgs, makeProxy, PermanentProxyError, runFfmpeg, unsupportedFormatReason } from "./proxy.js";
import { createStorage } from "./storage.js";

const config = loadConfig();
const sql = connect(config.databaseUrl);
const storage = createStorage(config.b2);
const workerId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const running = new Map<number, { controller: AbortController; done: Promise<void> }>();
let stopping = false;
// The cut loop, when FAL_KEY is set: stopped with the worker.
const cuts = new AbortController();
let cutLoop: Promise<void> | null = null;

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function processJob(job: Job, signal: AbortSignal) {
  const name = path.posix.basename(job.raw_key);
  const label = `[job ${job.id}] ${job.raw_key.split("/").slice(-3).join("/")}`;
  let progress = 0;
  const started = Date.now();
  const beat = setInterval(() => {
    heartbeat(sql, job, workerId, progress)
      .then((stillOurs) => {
        if (!stillOurs) running.get(job.id)?.controller.abort(new Error("The job was taken back."));
      })
      .catch(() => {});
  }, 20_000);
  let dir: string | undefined;

  try {
    // A proxy must never land on a raw file.
    if (!job.raw_key.includes("/Raw/") || !job.proxy_key.includes("/Proxies/") || job.raw_key === job.proxy_key) {
      throw new PermanentProxyError("The proxy's location looks wrong, so nothing was written.");
    }
    const early = unsupportedFormatReason(name);
    if (early) throw new PermanentProxyError(early);

    // Room for the raw clip plus its proxy.
    const disk = await statfs(config.workDir);
    if (disk.bavail * disk.bsize < job.raw_size * 1.2 + 512 * 1024 * 1024) {
      throw new Error("The worker's disk is too full for this clip right now.");
    }

    dir = await mkdtemp(path.join(config.workDir, `job-${job.id}-`));
    const input = path.join(dir, `raw${path.extname(name)}`);
    const output = path.join(dir, "proxy.mov");
    const preview = path.join(dir, "preview.mp4");
    log(`${label}: downloading ${(job.raw_size / 1e9).toFixed(2)} GB (attempt ${job.attempts})`);
    await storage.download(job.raw_key, input, signal);
    let lut: string | undefined;
    if (job.lut_key) {
      lut = path.join(dir, "look.cube");
      await storage.download(job.lut_key, lut, signal);
    }

    const result = await makeProxy(config.tools, {
      input,
      output,
      sourceName: name,
      lut,
      preview,
      signal,
      onProgress: (fraction) => (progress = fraction),
    });
    if (result.kind === "skipped") {
      await markSkipped(sql, job, workerId, result.reason);
      log(`${label}: skipped (${result.reason})`);
      return;
    }

    const size = (await stat(output)).size;
    await storage.upload(job.proxy_key, output, "video/quicktime", signal);
    const stored = await storage.size(job.proxy_key);
    if (stored !== size) throw new Error(`B2 holds ${stored ?? 0} bytes of the ${size}-byte proxy.`);
    await uploadThumbnail(job, output, result.media.durationSeconds, dir, signal);
    const previewSize = result.previewMade ? await uploadPreview(job, preview, signal) : null;
    await markDone(sql, job, workerId, size, result.media, previewSize);
    log(`${label}: proxy ready${lut ? " with its LUT" : ""} in ${Math.round((Date.now() - started) / 1000)}s (${(size / 1e6).toFixed(1)} MB)`);
  } catch (error) {
    if (signal.aborted) return; // shutting down or taken back: someone else finishes it
    const message = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof PermanentProxyError;
    await markFailed(sql, job, workerId, message, permanent).catch((e) => log(`${label}: couldn't record failure: ${e}`));
    log(`${label}: failed${permanent || job.attempts >= job.max_attempts ? "" : ", will retry"}: ${message}`);
  } finally {
    clearInterval(beat);
    // The last proxy of a scene: its cut starts by itself (once the cut tables are there; quietly before).
    if (!signal.aborted) {
      await startCutIfReady(sql, job.project_id)
        .then((started) => started && log(`[scene ${job.project_id}] every proxy is made: the cut is queued.`))
        .catch((e: { code?: string }) => e?.code !== "42P01" && log(`[scene ${job.project_id}] couldn't queue the cut: ${e}`));
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A still for the shoot page, next to (never inside) the Proxies folder so
 * Premiere can't mistake it for a proxy. Nice to have: failure is only logged.
 */
async function uploadThumbnail(job: Job, proxy: string, durationSeconds: number | undefined, dir: string, signal: AbortSignal) {
  const key = thumbnailKey(job.proxy_key);
  if (!key.includes("/Thumbnails/")) return;
  const still = path.join(dir, "thumbnail.jpg");
  try {
    await runFfmpeg(config.tools, buildThumbnailArgs({ input: proxy, output: still, durationSeconds }), { signal });
    await storage.upload(key, still, "image/jpeg", signal, "public, max-age=31536000, immutable");
  } catch (error) {
    if (!signal.aborted) log(`[job ${job.id}] no thumbnail: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * The web preview, in Previews/ beside Proxies/. Nice to have, like the still:
 * a failure is only logged, and the shoot page says there's no preview.
 */
async function uploadPreview(job: Job, file: string, signal: AbortSignal): Promise<number | null> {
  const key = previewKey(job.proxy_key);
  if (!key.includes("/Previews/")) return null;
  try {
    const size = (await stat(file)).size;
    await storage.upload(key, file, "video/mp4", signal, "public, max-age=31536000, immutable");
    return (await storage.size(key)) === size ? size : null;
  } catch (error) {
    if (!signal.aborted) log(`[job ${job.id}] no web preview: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export function previewKey(proxyKey: string): string {
  return proxyKey.replace("/Proxies/", "/Previews/").replace(/\.mov$/i, ".mp4");
}

export function thumbnailKey(proxyKey: string): string {
  return proxyKey.replace("/Proxies/", "/Thumbnails/").replace(/\.mov$/i, ".jpg");
}

async function fillSlots() {
  while (!stopping && running.size < config.concurrency) {
    const job = await claimJob(sql, workerId);
    if (!job) return;
    const controller = new AbortController();
    const done = processJob(job, controller.signal).finally(() => running.delete(job.id));
    running.set(job.id, { controller, done });
  }
}

async function main() {
  await mkdir(config.workDir, { recursive: true });
  // Leftovers from a previous run that was cut off.
  for (const entry of await readdir(config.workDir)) {
    if (entry.startsWith("job-") || entry.startsWith("cut-")) await rm(path.join(config.workDir, entry), { recursive: true, force: true });
  }
  log(`Proxy worker ${workerId} started (${config.concurrency} at a time).`);
  const falKey = process.env.FAL_KEY?.trim();
  if (falKey) {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        cuts.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    cutLoop = runAssemblyLoop({ sql, storage, fal: new FalClient(falKey), tools: config.tools, workDir: config.workDir, workerId, signal: cuts.signal, log, sleep }).catch((error) =>
      log(`The cut loop stopped: ${error instanceof Error ? error.message : error}`),
    );
  } else {
    log("Cuts: off (no FAL_KEY).");
  }

  let lastStaleCheck = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastStaleCheck > 60_000) {
        lastStaleCheck = Date.now();
        const requeued = await requeueStale(sql);
        if (requeued) log(`Put ${requeued} interrupted job(s) back in the queue.`);
      }
      await fillSlots();
    } catch (error) {
      log(`Couldn't reach the database, trying again shortly: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

async function shutdown(signalName: string) {
  if (stopping) return;
  stopping = true;
  log(`${signalName}: stopping, handing ${running.size} job(s) back to the queue.`);
  const ids = [...running.keys()];
  for (const { controller } of running.values()) controller.abort(new Error("Worker shutting down."));
  cuts.abort(new Error("Worker shutting down."));
  await Promise.allSettled([...running.values()].map((r) => r.done));
  await cutLoop?.catch(() => {});
  await releaseJobs(sql, ids, workerId).catch(() => {});
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
