// The first assembly queue (footage_assemblies): the shoot page adds a row,
// the mover service takes it, makes the assembly (run.ts), puts the package
// in the shoot's "First Assembly" folder in B2 and records the result. Safe
// to restart at any time: a job cut off mid-way goes back in the queue.

import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FalClient } from "../ai/fal.js";
import type { Sql } from "../jobs.js";
import type { Tools } from "../proxy.js";
import type { Storage } from "../storage.js";
import type { Setup } from "./engine.js";
import { makeAssembly, type Shoot, type ShootTake, type Step } from "./run.js";
import type { LibraryScript } from "./scene.js";
import type { ScriptLine, Word } from "./text.js";
import { parseDirection, pendingNote, type Direction } from "./direction.js";
import { readNote, type CutContext } from "./loupe.js";
import type { AssemblyResult } from "./run.js";

export type AssemblyJob = {
  id: number;
  project_id: number;
  script_id: number | null;
  client_role: string | null;
  coverage: Record<string, Setup | null> | null;
  /** The director's notes to Loupe (direction.ts); null before migration 0017 or when there are none. */
  direction: unknown;
  attempts: number;
};

/** Two tries, then "failed" with the reason on the shoot page. */
export const MAX_ATTEMPTS = 2;

const toJob = (row: Record<string, unknown>): AssemblyJob => ({
  id: Number(row.id),
  project_id: Number(row.project_id),
  script_id: row.script_id == null ? null : Number(row.script_id),
  client_role: row.client_role == null ? null : String(row.client_role),
  coverage: (row.coverage as AssemblyJob["coverage"]) ?? null,
  direction: row.direction ?? null,
  attempts: Number(row.attempts),
});

/** Takes the oldest waiting assembly, or returns null. */
export async function claimAssembly(sql: Sql, workerId: string): Promise<AssemblyJob | null> {
  try {
    const rows = await sql`
      update footage_assemblies a
         set status = 'working', attempts = a.attempts + 1, locked_by = ${workerId}, locked_at = now(),
             started_at = coalesce(a.started_at, now()), step = 'listening', error = null
       where a.id = (
         select id from footage_assemblies
          where status = 'waiting'
          order by id
          limit 1
          for update skip locked)
      returning a.id, a.project_id, a.script_id, a.client_role, a.coverage, a.direction, a.attempts`;
    return rows[0] ? toJob(rows[0]) : null;
  } catch (error) {
    // Before migration 0017 there are no notes to Loupe: as before.
    if ((error as { code?: string }).code !== "42703") throw error;
  }
  const rows = await sql`
    update footage_assemblies a
       set status = 'working', attempts = a.attempts + 1, locked_by = ${workerId}, locked_at = now(),
           started_at = coalesce(a.started_at, now()), step = 'listening', error = null
     where a.id = (
       select id from footage_assemblies
        where status = 'waiting'
        order by id
        limit 1
        for update skip locked)
    returning a.id, a.project_id, a.script_id, a.client_role, a.coverage, a.attempts`;
  return rows[0] ? toJob(rows[0]) : null;
}

/** Records the step and keeps the job ours. False: it was taken back. */
export async function touchAssembly(sql: Sql, id: number, workerId: string, step?: Step): Promise<boolean> {
  const rows = step
    ? await sql`update footage_assemblies set step = ${step}, locked_at = now() where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`
    : await sql`update footage_assemblies set locked_at = now() where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`;
  return rows.length > 0;
}

/** Keeps Loupe's answer to a note (the shoot page shows it while the assembly is made again). */
export async function saveDirection(sql: Sql, id: number, workerId: string, direction: Direction) {
  await sql`update footage_assemblies set direction = ${sql.json(direction as never)} where id = ${id} and locked_by = ${workerId}`;
}

/** The shoot's last finished assembly before this one: the cut a note is about. */
export async function lastDone(sql: Sql, projectId: number, before: number): Promise<AssemblyResult | null> {
  const [row] = await sql`
    select result from footage_assemblies
     where project_id = ${projectId} and id < ${before} and status = 'done' and result is not null
     order by id desc limit 1`;
  return row ? (row.result as AssemblyResult) : null;
}

/** The cut as Loupe reads it (loupe.ts). */
export function cutContext(result: AssemblyResult, direction: Direction): CutContext {
  return {
    title: result.title,
    tone: result.tone,
    place: result.place,
    seconds: result.seconds,
    client: result.client,
    partner: result.partner,
    shots: result.shots.map((s) => ({ take: s.take, who: s.who, framing: s.framing, kind: s.kind, line: s.line, speaker: s.speaker, why: s.why })),
    takes: result.takes.map((t) => ({ take: t.take, setup: t.setup, used: t.used })),
    performances: result.performances,
    lines: result.lines,
    look: direction.look ?? null,
  };
}

export async function finishAssembly(sql: Sql, id: number, workerId: string, result: object) {
  await sql`
    update footage_assemblies
       set status = 'done', step = null, result = ${sql.json(result as never)}, error = null,
           finished_at = now(), locked_by = null, locked_at = null
     where id = ${id} and locked_by = ${workerId}`;
}

/** A failed try goes back in the queue once; the second time it stays failed, with the reason. */
export async function failAssembly(sql: Sql, job: AssemblyJob, workerId: string, message: string) {
  const giveUp = job.attempts >= MAX_ATTEMPTS;
  await sql`
    update footage_assemblies
       set status = ${giveUp ? "failed" : "waiting"}, step = null, error = ${message.slice(0, 500)},
           finished_at = ${giveUp ? sql`now()` : null}, locked_by = null, locked_at = null
     where id = ${job.id} and locked_by = ${workerId}`;
}

/** Hands a job back without counting the try (the service is stopping). */
export async function releaseAssembly(sql: Sql, id: number, workerId: string) {
  await sql`
    update footage_assemblies set status = 'waiting', attempts = greatest(attempts - 1, 0), step = null, locked_by = null, locked_at = null
     where id = ${id} and locked_by = ${workerId} and status = 'working'`;
}

/** Assemblies whose worker vanished (crashed, redeployed) go back in the queue. */
export async function requeueStaleAssemblies(sql: Sql, staleMinutes = 15): Promise<number> {
  const rows = await sql`
    update footage_assemblies
       set status = case when attempts >= ${MAX_ATTEMPTS} then 'failed' else 'waiting' end,
           error = 'The worker stopped while making this assembly.',
           finished_at = case when attempts >= ${MAX_ATTEMPTS} then now() else null end,
           step = null, locked_by = null, locked_at = null
     where status = 'working' and locked_at < now() - make_interval(mins => ${staleMinutes})
    returning id`;
  return rows.length;
}

/** The shoot as the assembly needs it: every clip with a finished proxy and web preview. */
export async function loadShoot(sql: Sql, projectId: number): Promise<Shoot> {
  const [p] = await sql`
    select p.id, p.name, p.storage_prefix, l.id as lut_id, l.name as lut_name, l.storage_key as lut_key
      from footage_projects p left join footage_luts l on l.id = p.lut_id
     where p.id = ${projectId}`;
  if (!p) throw new Error("The shoot isn't there any more.");
  const rows = await sql`
    select f.path, j.proxy_key, j.media, j.made_with_lut_id
      from footage_files f join footage_proxy_jobs j on j.file_id = f.id
     where f.project_id = ${projectId} and j.status = 'done' and j.preview_size_bytes is not null
     order by f.path`;
  const lutName = p.lut_name == null ? null : String(p.lut_name);
  // As the Premiere download names it (app/src/lib/footage/luts.ts, lutFileName).
  const safe = lutName?.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s-]+|[.\s]+$/g, "").slice(0, 80);
  return {
    id: Number(p.id),
    name: String(p.name),
    prefix: String(p.storage_prefix),
    lut: p.lut_key ? { key: String(p.lut_key), name: lutName!, fileName: `${safe || `LUT ${p.lut_id}`}.cube` } : null,
    takes: rows.map((r) => ({
      path: String(r.path),
      proxyKey: String(r.proxy_key),
      previewKey: String(r.proxy_key).replace("/Proxies/", "/Previews/").replace(/\.mov$/i, ".mp4"),
      media: (r.media as ShootTake["media"]) ?? null,
      madeWithLut: r.made_with_lut_id != null,
    })),
  };
}

export async function loadLibrary(sql: Sql): Promise<LibraryScript[]> {
  const rows = await sql`select id, title, lines, heading from footage_scripts order by id`;
  return rows.map((r) => ({ id: Number(r.id), title: String(r.title), lines: r.lines as ScriptLine[], heading: r.heading == null ? null : String(r.heading) }));
}

export type AssemblyContext = {
  sql: Sql;
  storage: Storage;
  fal: FalClient;
  tools: Tools;
  workDir: string;
  workerId: string;
  signal: AbortSignal;
  log: (line: string) => void;
};

/** Makes one claimed assembly and records how it went. */
export async function runAssemblyJob(ctx: AssemblyContext, job: AssemblyJob) {
  const controller = new AbortController();
  const stop = () => controller.abort(ctx.signal.reason ?? new Error("Stopped"));
  ctx.signal.addEventListener("abort", stop, { once: true });
  const beat = setInterval(() => {
    touchAssembly(ctx.sql, job.id, ctx.workerId)
      .then((ours) => {
        if (!ours) controller.abort(new Error("The assembly was taken back."));
      })
      .catch(() => {});
  }, 30_000);
  const signal = controller.signal;
  let dir: string | undefined;
  const label = `[assembly ${job.id}, shoot ${job.project_id}]`;
  const log = (line: string) => ctx.log(`${label} ${line}`);
  try {
    await mkdir(ctx.workDir, { recursive: true });
    const disk = await statfs(ctx.workDir);
    if (disk.bavail * disk.bsize < 3e9) throw new Error("The worker's disk is too full for an assembly right now.");
    dir = await mkdtemp(path.join(ctx.workDir, `assembly-${job.id}-`));
    // A note to Loupe first (Guy, Oct 6): Claude reads it against the last cut and answers; the answer shows on the
    // shoot page while the assembly is made again with the change. A question, or nothing it can change: the last
    // cut stays, with the answer.
    let direction = parseDirection(job.direction);
    const pending = pendingNote(direction);
    if (pending) {
      const previous = await lastDone(ctx.sql, job.project_id, job.id);
      const reading = previous ? await readNote(ctx.fal, pending.note, cutContext(previous, direction), direction, signal).catch((e: Error) => {
        if (signal.aborted) throw e;
        log(`Couldn't read the note (${e.message}).`);
        return null;
      }) : null;
      const reply = reading?.reply ?? (previous ? "Sorry, I didn't catch that one. Could you say it another way?" : "There's no cut to change yet: make the first assembly, then tell me what to change.");
      direction = { ...(reading?.direction ?? direction), notes: [...(direction.notes ?? []).slice(0, -1), { ...pending, reply }] };
      await saveDirection(ctx.sql, job.id, ctx.workerId, direction);
      log(`Note: "${pending.note}" → ${reading?.remake ? "making it again" : "no change"}: ${reply}`);
      if (!reading?.remake) {
        if (previous) await finishAssembly(ctx.sql, job.id, ctx.workerId, previous);
        else await failAssembly(ctx.sql, { ...job, attempts: MAX_ATTEMPTS }, ctx.workerId, reply);
        return;
      }
    }
    const shoot = await loadShoot(ctx.sql, job.project_id);
    const library = await loadLibrary(ctx.sql);
    log(`${shoot.takes.length} takes, ${library.length} scripts in the library (try ${job.attempts}).`);
    const folder = `${shoot.prefix}/First Assembly`;
    // Transcripts are kept beside the package, so "Make again" doesn't transcribe twice.
    const transcriptKey = (t: ShootTake) => `${shoot.prefix}/Assembly work/${path.posix.basename(t.proxyKey)}.words.json`;
    // Made to match the scene's own frames since Oct 5 (an older one, from words alone, stays where it was).
    const establishingKey = `${shoot.prefix}/Assembly work/establishing-matched.mp4`;
    const { result, files } = await makeAssembly(
      {
        tools: ctx.tools,
        fal: ctx.fal,
        workDir: dir,
        signal,
        log,
        step: async (step) => {
          if (!(await touchAssembly(ctx.sql, job.id, ctx.workerId, step))) throw new Error("The assembly was taken back.");
        },
        download: (key, file) => ctx.storage.download(key, file, signal),
        transcripts: {
          get: async (t) => {
            const key = transcriptKey(t);
            if ((await ctx.storage.size(key)) === null) return null;
            const file = path.join(dir!, `cached-${path.posix.basename(key)}`);
            await ctx.storage.download(key, file, signal);
            const saved = JSON.parse(await readFile(file, "utf8")) as { proxyKey: string; words: Word[] };
            return saved.proxyKey === t.proxyKey && Array.isArray(saved.words) ? saved.words : null;
          },
          put: async (t, words) => {
            const file = path.join(dir!, `words-${path.posix.basename(t.proxyKey)}.json`);
            await writeFile(file, JSON.stringify({ proxyKey: t.proxyKey, words }));
            await ctx.storage.upload(transcriptKey(t), file, "application/json", signal);
          },
        },
        // The establishing shot is made once per shoot and kept for "Make again".
        establishing: {
          get: async (file) => {
            if ((await ctx.storage.size(establishingKey)) === null) return false;
            await ctx.storage.download(establishingKey, file, signal);
            return true;
          },
          put: (file) => ctx.storage.upload(establishingKey, file, "video/mp4", signal),
        },
      },
      shoot,
      library,
      { scriptId: job.script_id, client: job.client_role, coverage: job.coverage },
      { direction },
    );
    for (const f of files) {
      const key = `${folder}/${f.path}`;
      await ctx.storage.upload(key, f.file, f.contentType, signal);
      const expected = result.files.find((x) => x.path === f.path)?.size;
      if ((await ctx.storage.size(key)) !== expected) throw new Error(`B2 doesn't hold all of ${f.path}.`);
    }
    await finishAssembly(ctx.sql, job.id, ctx.workerId, result);
    log(`done: ${result.seconds.toFixed(0)} s, ${result.counts.shots} shots.`);
  } catch (error) {
    if (ctx.signal.aborted) {
      await releaseAssembly(ctx.sql, job.id, ctx.workerId).catch(() => {});
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await failAssembly(ctx.sql, job, ctx.workerId, message).catch((e) => log(`couldn't record the failure: ${e}`));
    log(`failed${job.attempts >= MAX_ATTEMPTS ? "" : ", will try again"}: ${message}`);
  } finally {
    clearInterval(beat);
    ctx.signal.removeEventListener("abort", stop);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Takes first assemblies off the queue one at a time until `signal` stops it (the mover service runs this). */
export async function runAssemblyLoop(ctx: AssemblyContext & { sleep: (ms: number) => Promise<void> }) {
  ctx.log("First assemblies: on.");
  let lastStaleCheck = 0;
  while (!ctx.signal.aborted) {
    try {
      if (Date.now() - lastStaleCheck > 5 * 60_000) {
        lastStaleCheck = Date.now();
        const requeued = await requeueStaleAssemblies(ctx.sql);
        if (requeued) ctx.log(`Put ${requeued} interrupted first assembl${requeued === 1 ? "y" : "ies"} back in the queue.`);
      }
      const job = await claimAssembly(ctx.sql, ctx.workerId);
      if (!job) {
        await ctx.sleep(10_000);
        continue;
      }
      await runAssemblyJob(ctx, job);
    } catch (error) {
      // Before the database has the first assembly tables (migration 0014), wait quietly.
      if ((error as { code?: string }).code === "42P01") {
        ctx.log("First assemblies wait for the database update (migration 0014).");
        await ctx.sleep(10 * 60_000);
        continue;
      }
      ctx.log(`first assemblies: ${(error as Error).message}`);
      await ctx.sleep(60_000);
    }
  }
}
