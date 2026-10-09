// The cut queue (loupe_cuts): the app adds a row once a scene's proxies are
// ready (or for a note), the worker takes it, makes the cut (run.ts), puts the
// package in the scene's "Loupe Cut" folder in B2 and records the result. Safe
// to restart at any time: a job cut off mid-way goes back in the queue.

import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FalClient } from "../ai/fal.js";
import type { Sql } from "../jobs.js";
import type { Tools } from "../proxy.js";
import type { Storage } from "../storage.js";
import type { Setup } from "./engine.js";
import { CUT_FOLDER } from "./finish.js";
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
  /** Whose scene it is ("Whose scene is it?"), when set: the engine's "client". */
  lead_role: string | null;
  coverage: Record<string, Setup | null> | null;
  /** The director's notes to Loupe (direction.ts); null when there are none. */
  direction: unknown;
  attempts: number;
  /** Paid for (the scene unlocked, or a live Pro/Studio plan): the full cut, studio voice isolation included. Free
   *  cuts are previews, made with Loupe's own cleanup, and the voice is isolated once the scene is paid for. */
  paid: boolean;
};

/**
 * What a free cut takes from the free-cutting fund (loupe_fund): the most it can cost. A first cut is judged, seen and
 * transcribed take by take, so it grows with the footage; a later version reuses all that (remember.ts) and mostly
 * pays for Loupe reading the note. Kept on the safe side; lowered once real costs are known.
 */
export const FREE_CUT_BASE_CENTS = 50;
export const FREE_CUT_CENTS_PER_MINUTE = 7;
export const FREE_VERSION_CENTS = 50;
/** One claim at a time decides on the fund, so two workers can't both spend its last dollars. */
const FUND_LOCK = 7_406_001;

/** Two tries, then "failed" with the reason on the shoot page. */
export const MAX_ATTEMPTS = 2;

const toJob = (row: Record<string, unknown>): AssemblyJob => ({
  id: Number(row.id),
  project_id: Number(row.project_id),
  script_id: row.script_id == null ? null : Number(row.script_id),
  lead_role: row.lead_role == null ? null : String(row.lead_role),
  coverage: (row.coverage as AssemblyJob["coverage"]) ?? null,
  direction: row.direction ?? null,
  attempts: Number(row.attempts),
  paid: row.paid === true,
});

/**
 * Takes the next waiting cut, or returns null. Fair between customers: the oldest waiting cut of the account whose
 * last cut started longest ago goes first, so one account dropping ten scenes doesn't hold up everyone else.
 */
export async function claimAssembly(sql: Sql, workerId: string): Promise<AssemblyJob | null> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${FUND_LOCK})`;
    const [{ balance }] = await tx`select coalesce(sum(amount_cents), 0)::int as balance from loupe_fund`;
    // Paid work always goes; a free cut only when the fund holds the most it can cost (Guy, Oct 9: always in the
    // black). A free cut already paid for from the fund (a second try) costs nothing more.
    const [next] = await tx`
      select w.id, z.paid, z.cost from loupe_cuts w
        join loupe_projects p on p.id = w.project_id
        join loupe_accounts a on a.id = p.account_id
        cross join lateral (
          select (p.unlocked_at is not null
                  or (a.plan in ('pro', 'studio') and a.subscription_status in ('active', 'trialing', 'past_due'))) as paid,
                 case when exists (select 1 from loupe_fund f where f.ref = 'cut:' || w.id) then 0
                      when exists (select 1 from loupe_cuts d where d.project_id = w.project_id and d.status = 'done') then ${FREE_VERSION_CENTS}
                      else ${FREE_CUT_BASE_CENTS} + ceil(${FREE_CUT_CENTS_PER_MINUTE} * coalesce(
                             (select sum((j.media->>'durationSeconds')::float8) from loupe_proxy_jobs j where j.project_id = w.project_id), 0) / 60)::int
                 end as cost) z
       where w.status = 'waiting'
         -- One version at a time per scene: a queued request waits for the one being made.
         and not exists (select 1 from loupe_cuts x where x.project_id = w.project_id and x.status = 'working')
         and (z.paid or z.cost <= ${balance})
       -- Priority (the Pro plan's promise): Pro and Studio first, then scenes paid for, then free cuts; within each,
       -- fair between customers.
       order by case when a.plan in ('pro', 'studio') and a.subscription_status in ('active', 'trialing', 'past_due') then 0
                     when p.unlocked_at is not null then 1 else 2 end,
                (select max(x.started_at) from loupe_cuts x join loupe_projects q on q.id = x.project_id
                  where q.account_id = p.account_id and x.id <> w.id) asc nulls first, w.id
       limit 1
       for update of w skip locked`;
    if (!next) return null;
    const [row] = await tx`
      update loupe_cuts c
         set status = 'working', attempts = c.attempts + 1, locked_by = ${workerId}, locked_at = now(),
             started_at = coalesce(c.started_at, now()), step = 'listening', error = null
       where c.id = ${next.id}
      returning c.id, c.project_id, c.script_id, c.lead_role, c.coverage, c.direction, c.attempts`;
    if (!next.paid && Number(next.cost) > 0) {
      await tx`
        insert into loupe_fund (amount_cents, kind, ref, account_id, project_id)
        select ${-Number(next.cost)}, 'free_cut', ${`cut:${next.id}`}, p.account_id, p.id from loupe_projects p where p.id = ${row.project_id}
        on conflict (ref) do nothing`;
    }
    return toJob({ ...row, paid: next.paid });
  });
}

/**
 * The scene's first cut, the moment it can be made (Guy: nobody presses anything): every file in, every proxy
 * finished one way or another, at least two takes ready, and no cut yet. Called after each proxy job ends; the app's
 * scene page does the same (app/src/lib/footage/cuts.ts, startCutIfReady). True if it started one.
 */
export async function startCutIfReady(sql: Sql, projectId: number): Promise<boolean> {
  const rows = await sql`
    insert into loupe_cuts (project_id, requested_by)
    select p.id, null from loupe_projects p
     where p.id = ${projectId} and p.status = 'uploaded'
       and not exists (select 1 from loupe_cuts c where c.project_id = p.id)
       and not exists (select 1 from loupe_files f where f.project_id = p.id and f.status <> 'uploaded')
       and not exists (select 1 from loupe_proxy_jobs j where j.project_id = p.id and j.status not in ('done', 'failed', 'skipped'))
       and (select count(*) from loupe_proxy_jobs j where j.project_id = p.id and j.status = 'done' and j.preview_size_bytes is not null) >= 2
    on conflict do nothing
    returning id`;
  return rows.length > 0;
}

/** Records the step and keeps the job ours. False: it was taken back. */
export async function touchAssembly(sql: Sql, id: number, workerId: string, step?: Step): Promise<boolean> {
  const rows = step
    ? await sql`update loupe_cuts set step = ${step}, locked_at = now() where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`
    : await sql`update loupe_cuts set locked_at = now() where id = ${id} and locked_by = ${workerId} and status = 'working' returning id`;
  return rows.length > 0;
}

/** Keeps Loupe's answer to a note (the shoot page shows it while the assembly is made again). */
export async function saveDirection(sql: Sql, id: number, workerId: string, direction: Direction) {
  await sql`update loupe_cuts set direction = ${sql.json(direction as never)} where id = ${id} and locked_by = ${workerId}`;
}

/** The scene's last finished version before this one, as made and as directed: what a queued request builds on. */
export async function lastDoneRow(sql: Sql, projectId: number, before: number) {
  const [row] = await sql`
    select script_id, lead_role, coverage, direction from loupe_cuts
     where project_id = ${projectId} and id < ${before} and status = 'done' and result is not null
     order by id desc limit 1`;
  return row
    ? {
        scriptId: row.script_id == null ? null : Number(row.script_id),
        leadRole: row.lead_role == null ? null : String(row.lead_role),
        coverage: (row.coverage as AssemblyJob["coverage"]) ?? null,
        direction: parseDirection(row.direction),
      }
    : null;
}

/**
 * A request made while Loupe was busy (Guy, Oct 7): it was queued in words, and is only now read, against the
 * version that was being made when it came in (now finished): that one's direction, its script and setups, plus
 * the queued words as the note to read.
 */
export async function unqueue(sql: Sql, job: AssemblyJob, workerId: string): Promise<AssemblyJob> {
  const raw = (job.direction && typeof job.direction === "object" ? job.direction : {}) as { queued?: boolean; studioSound?: boolean; notes?: { note: string; reply: string | null; at: string }[] };
  if (!raw.queued) return job;
  const before = await lastDoneRow(sql, job.project_id, job.id);
  const words = (raw.notes ?? []).filter((n) => n.reply === null).map((n) => n.note).join(" Then: ");
  // The version before's choices, without what only described that version (going back, the studio sound).
  const { restoredFrom: _from, restoredHow: _how, studioSound: _studio, ...base } = (before?.direction ?? {}) as Record<string, unknown> & { notes?: { note: string; reply: string | null; at: string }[] };
  void [_from, _how, _studio];
  const direction = {
    ...base,
    notes: [...(base.notes ?? []).filter((n) => n.reply !== null), ...(words ? [{ note: words, reply: null, at: new Date().toISOString() }] : [])],
    ...(raw.studioSound ? { studioSound: true } : {}),
  };
  const next = {
    ...job,
    script_id: job.script_id ?? before?.scriptId ?? null,
    lead_role: job.lead_role ?? before?.leadRole ?? null,
    coverage: job.coverage ?? before?.coverage ?? null,
    direction,
  };
  await sql`
    update loupe_cuts set direction = ${sql.json(direction as never)}, script_id = ${next.script_id}, lead_role = ${next.lead_role},
           coverage = ${next.coverage ? sql.json(next.coverage as never) : null}
     where id = ${job.id} and locked_by = ${workerId}`;
  return next;
}

/** The scene's last finished version before this one: the cut a note is about. */
export async function lastDone(sql: Sql, projectId: number, before: number): Promise<AssemblyResult | null> {
  const [row] = await sql`
    select result from loupe_cuts
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
    update loupe_cuts
       set status = 'done', step = null, result = ${sql.json(result as never)}, error = null,
           finished_at = now(), locked_by = null, locked_at = null
     where id = ${id} and locked_by = ${workerId}`;
}

/** A failed try goes back in the queue once; the second time it stays failed, with the reason. */
export async function failAssembly(sql: Sql, job: AssemblyJob, workerId: string, message: string) {
  const giveUp = job.attempts >= MAX_ATTEMPTS;
  await sql`
    update loupe_cuts
       set status = ${giveUp ? "failed" : "waiting"}, step = null, error = ${message.slice(0, 500)},
           finished_at = ${giveUp ? sql`now()` : null}, locked_by = null, locked_at = null
     where id = ${job.id} and locked_by = ${workerId}`;
}

/** Hands a job back without counting the try (the service is stopping). */
export async function releaseAssembly(sql: Sql, id: number, workerId: string) {
  await sql`
    update loupe_cuts set status = 'waiting', attempts = greatest(attempts - 1, 0), step = null, locked_by = null, locked_at = null
     where id = ${id} and locked_by = ${workerId} and status = 'working'`;
}

/** Assemblies whose worker vanished (crashed, redeployed) go back in the queue. */
export async function requeueStaleAssemblies(sql: Sql, staleMinutes = 15): Promise<number> {
  const rows = await sql`
    update loupe_cuts
       set status = case when attempts >= ${MAX_ATTEMPTS} then 'failed' else 'waiting' end,
           error = 'Loupe was interrupted while cutting this; it tries again by itself.',
           finished_at = case when attempts >= ${MAX_ATTEMPTS} then now() else null end,
           step = null, locked_by = null, locked_at = null
     where status = 'working' and locked_at < now() - make_interval(mins => ${staleMinutes})
    returning id`;
  return rows.length;
}

/** The shoot as the assembly needs it: every clip with a finished proxy and web preview. */
export async function loadShoot(sql: Sql, projectId: number): Promise<Shoot> {
  const [p] = await sql`
    select p.id, p.account_id, p.name, p.storage_prefix, l.id as lut_id, l.name as lut_name, l.storage_key as lut_key
      from loupe_projects p left join loupe_luts l on l.id = p.lut_id
     where p.id = ${projectId}`;
  if (!p) throw new Error("The scene isn't there any more.");
  const rows = await sql`
    select f.path, j.proxy_key, j.media, j.made_with_lut_id
      from loupe_files f join loupe_proxy_jobs j on j.file_id = f.id
     where f.project_id = ${projectId} and j.status = 'done' and j.preview_size_bytes is not null
     order by f.path`;
  const lutName = p.lut_name == null ? null : String(p.lut_name);
  // As the Premiere download names it (app/src/lib/footage/luts.ts, lutFileName).
  const safe = lutName?.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s-]+|[.\s]+$/g, "").slice(0, 80);
  return {
    id: Number(p.id),
    accountId: Number(p.account_id),
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

/**
 * The scripts this scene may be: only its own account's (never another customer's). One that came in with the scene's
 * own folder comes first, and is the one used when nothing else is said.
 */
export async function loadLibrary(sql: Sql, accountId: number, projectId: number): Promise<{ library: LibraryScript[]; own: number | null }> {
  const rows = await sql`
    select id, title, lines, heading, project_id from loupe_scripts
     where account_id = ${accountId}
     order by (project_id = ${projectId}) desc nulls last, id desc`;
  const own = rows.find((r) => r.project_id != null && Number(r.project_id) === projectId);
  return {
    library: rows.map((r) => ({ id: Number(r.id), title: String(r.title), lines: r.lines as ScriptLine[], heading: r.heading == null ? null : String(r.heading) })),
    own: own ? Number(own.id) : null,
  };
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
  const label = `[cut ${job.id}, scene ${job.project_id}]`;
  const log = (line: string) => ctx.log(`${label} ${line}`);
  try {
    await mkdir(ctx.workDir, { recursive: true });
    const disk = await statfs(ctx.workDir);
    if (disk.bavail * disk.bsize < 3e9) throw new Error("Loupe's worker is short of room right now; it'll try again shortly.");
    dir = await mkdtemp(path.join(ctx.workDir, `cut-${job.id}-`));
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
      const reply = reading?.reply ?? (previous ? "Sorry, I didn't catch that one. Could you say it another way?" : "There's no cut to change yet. Once the first one's ready, tell me what to change.");
      direction = { ...(reading?.direction ?? direction), notes: [...(direction.notes ?? []).slice(0, -1), { ...pending, reply }] };
      await saveDirection(ctx.sql, job.id, ctx.workerId, direction);
      log(`Note: "${pending.note}" → ${reading?.remake ? "making it again" : "no change"}: ${reply}`);
      if (!reading?.remake) {
        // Nothing to change (a question, or nothing Loupe could do): the same cut, and not one of the scene's changes.
        if (previous) await finishAssembly(ctx.sql, job.id, ctx.workerId, { ...previous, unchanged: true });
        else await failAssembly(ctx.sql, { ...job, attempts: MAX_ATTEMPTS }, ctx.workerId, reply);
        return;
      }
    }
    const shoot = await loadShoot(ctx.sql, job.project_id);
    const { library, own } = await loadLibrary(ctx.sql, shoot.accountId!, shoot.id);
    log(`${shoot.takes.length} takes, ${library.length} scripts in the account${own ? ", one from the scene's folder" : ""} (try ${job.attempts}).`);
    // Each version's package in a folder of its own (Guy, Oct 8: versions you can go back to): nothing is overwritten.
    const versionFolder = `${CUT_FOLDER}/v${job.id}`;
    const folder = `${shoot.prefix}/${versionFolder}`;
    // Transcripts are kept beside the package, so a note doesn't transcribe twice.
    const transcriptKey = (t: ShootTake) => `${shoot.prefix}/Loupe work/${path.posix.basename(t.proxyKey)}.words.json`;
    const establishingKey = `${shoot.prefix}/Loupe work/establishing-matched.mp4`;
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
        // What the paid AI calls answered (how each take is performed and what it shows, each take's voice
        // isolated), kept beside the scene so the next version reuses them instead of paying again.
        work: {
          get: async (name, file) => {
            const key = `${shoot.prefix}/Loupe work/kept/${name}`;
            if ((await ctx.storage.size(key)) === null) return false;
            await ctx.storage.download(key, file, signal);
            return true;
          },
          put: (name, file, contentType) => ctx.storage.upload(`${shoot.prefix}/Loupe work/kept/${name}`, file, contentType, signal),
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
      { scriptId: job.script_id ?? own, client: job.lead_role, coverage: job.coverage },
      { direction, isolate: job.paid },
    );
    for (const f of files) {
      const key = `${folder}/${f.path}`;
      await ctx.storage.upload(key, f.file, f.contentType, signal);
      const expected = result.files.find((x) => x.path === f.path)?.size;
      if ((await ctx.storage.size(key)) !== expected) throw new Error(`B2 doesn't hold all of ${f.path}.`);
    }
    await finishAssembly(ctx.sql, job.id, ctx.workerId, { ...result, folder: versionFolder });
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

/** Takes cuts off the queue one at a time until `signal` stops it. */
export async function runAssemblyLoop(ctx: AssemblyContext & { sleep: (ms: number) => Promise<void> }) {
  ctx.log("Cuts: on.");
  let lastStaleCheck = 0;
  while (!ctx.signal.aborted) {
    try {
      if (Date.now() - lastStaleCheck > 5 * 60_000) {
        lastStaleCheck = Date.now();
        const requeued = await requeueStaleAssemblies(ctx.sql);
        if (requeued) ctx.log(`Put ${requeued} interrupted cut${requeued === 1 ? "" : "s"} back in the queue.`);
      }
      const claimed = await claimAssembly(ctx.sql, ctx.workerId);
      if (!claimed) {
        await ctx.sleep(10_000);
        continue;
      }
      await runAssemblyJob(ctx, await unqueue(ctx.sql, claimed, ctx.workerId));
    } catch (error) {
      // Before the database has the cut tables (migration 0001), wait quietly.
      if ((error as { code?: string }).code === "42P01") {
        ctx.log("Cuts wait for the database update (migration 0001_cuts).");
        await ctx.sleep(10 * 60_000);
        continue;
      }
      ctx.log(`cuts: ${(error as Error).message}`);
      await ctx.sleep(60_000);
    }
  }
}
