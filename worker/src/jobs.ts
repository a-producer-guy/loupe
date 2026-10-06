import postgres from "postgres";
import { normalizeDatabaseUrl } from "./connection-url.js";
import { tlsFor } from "./supabase-tls.js";

// The proxy job queue in loupe_proxy_jobs. Claiming uses SKIP LOCKED, so
// several workers could share the queue without ever taking the same clip.

export type Job = {
  id: number;
  file_id: number;
  project_id: number;
  raw_key: string;
  proxy_key: string;
  attempts: number;
  max_attempts: number;
  raw_size: number;
  /** The LUT to bake in (null: none), and where its .cube file is in B2. */
  lut_id: number | null;
  lut_key: string | null;
};

export type Sql = ReturnType<typeof connect>;

export function connect(databaseUrl: string) {
  const url = normalizeDatabaseUrl(databaseUrl);
  return postgres(url, {
    prepare: false, // required by Supabase's transaction pooler
    max: 4,
    idle_timeout: 60,
    connect_timeout: 30,
    ssl: tlsFor(url), // encrypted, and checked to really be Supabase
  });
}

const toJob = (row: Record<string, unknown>): Job => ({
  id: Number(row.id),
  file_id: Number(row.file_id),
  project_id: Number(row.project_id),
  raw_key: String(row.raw_key),
  proxy_key: String(row.proxy_key),
  attempts: Number(row.attempts),
  max_attempts: Number(row.max_attempts),
  raw_size: Number(row.raw_size ?? 0),
  lut_id: row.lut_id == null ? null : Number(row.lut_id),
  lut_key: row.lut_key == null ? null : String(row.lut_key),
});

/** Takes the oldest waiting job, or returns null when there's nothing to do. */
export async function claimJob(sql: Sql, workerId: string): Promise<Job | null> {
  const rows = await sql`
    update loupe_proxy_jobs j
       set status = 'running', attempts = j.attempts + 1, locked_by = ${workerId},
           locked_at = now(), started_at = now(), progress = 0
     where j.id = (
       select id from loupe_proxy_jobs
        where status = 'queued' and run_after <= now()
        order by run_after, id
        limit 1
        for update skip locked)
    returning j.*,
      (select f.size_bytes from loupe_files f where f.id = j.file_id) as raw_size,
      (select l.storage_key from loupe_luts l where l.id = j.lut_id) as lut_key`;
  return rows[0] ? toJob(rows[0]) : null;
}

/** Keeps a claimed job ours. False means it was taken back (stale, or retried by someone). */
export async function heartbeat(sql: Sql, job: Job, workerId: string, progress: number): Promise<boolean> {
  const rows = await sql`
    update loupe_proxy_jobs set locked_at = now(), progress = ${progress}
     where id = ${job.id} and locked_by = ${workerId} and status = 'running'
    returning id`;
  return rows.length > 0;
}

/**
 * Records the finished proxy and the LUT it was made with. If someone picked a
 * different LUT while it was being made, it goes straight back in the queue to
 * be made again with the new one.
 */
export async function markDone(sql: Sql, job: Job, workerId: string, proxySize: number, media: object, previewSize: number | null) {
  const same = sql`lut_id is not distinct from ${job.lut_id}`;
  await sql`
    update loupe_proxy_jobs
       set status = case when ${same} then 'done' else 'queued' end,
           progress = case when ${same} then 1 else null end,
           attempts = case when ${same} then attempts else 0 end,
           run_after = now(), made_with_lut_id = ${job.lut_id},
           proxy_size_bytes = ${proxySize}, preview_size_bytes = ${previewSize}, media = ${sql.json(media as never)}, error = null,
           finished_at = now(), locked_by = null, locked_at = null
     where id = ${job.id} and locked_by = ${workerId}`;
}

export async function markSkipped(sql: Sql, job: Job, workerId: string, reason: string) {
  await sql`
    update loupe_proxy_jobs
       set status = 'skipped', progress = null, error = ${reason},
           finished_at = now(), locked_by = null, locked_at = null
     where id = ${job.id} and locked_by = ${workerId}`;
}

/**
 * Records a failed attempt. It goes back in the queue (after a short wait)
 * until it has used up its attempts, or straight to failed if retrying can't help.
 */
export async function markFailed(sql: Sql, job: Job, workerId: string, message: string, permanent: boolean) {
  const giveUp = permanent || job.attempts >= job.max_attempts;
  const waitSeconds = job.attempts <= 1 ? 30 : 120;
  await sql`
    update loupe_proxy_jobs
       set status = ${giveUp ? "failed" : "queued"},
           attempts = ${giveUp ? sql`greatest(attempts, max_attempts)` : sql`attempts`},
           run_after = now() + make_interval(secs => ${waitSeconds}),
           error = ${message.slice(0, 1000)}, progress = null,
           finished_at = ${giveUp ? sql`now()` : null},
           locked_by = null, locked_at = null
     where id = ${job.id} and locked_by = ${workerId}`;
}

/** Hands jobs back without counting the attempt (the worker is shutting down). */
export async function releaseJobs(sql: Sql, ids: number[], workerId: string) {
  if (ids.length === 0) return;
  await sql`
    update loupe_proxy_jobs
       set status = 'queued', attempts = greatest(attempts - 1, 0), progress = null,
           locked_by = null, locked_at = null, run_after = now()
     where id in ${sql(ids)} and locked_by = ${workerId} and status = 'running'`;
}

/** Jobs whose worker vanished (crashed, redeployed) mid-proxy go back in the queue. */
export async function requeueStale(sql: Sql, staleMinutes = 10): Promise<number> {
  const rows = await sql`
    update loupe_proxy_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           error = 'The proxy worker stopped while making this proxy.',
           finished_at = case when attempts >= max_attempts then now() else null end,
           progress = null, locked_by = null, locked_at = null, run_after = now()
     where status = 'running' and locked_at < now() - make_interval(mins => ${staleMinutes})
    returning id`;
  return rows.length;
}
