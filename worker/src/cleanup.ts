import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import type { Sql } from "./jobs.js";

// The footage cleanup (approved by Guy, Oct 9: "Loupe footage cleanup rules"). Only camera originals (a scene's Raw
// folder) are ever taken away; proxies, previews, versions and finals stay for good. A scene's camera files are kept
// 14 days after its last activity when it was never exported, and 30 / 60 / 90 days after export on Indie / Pro /
// Studio, unless Keep footage is on. The owner is emailed 7 days and 3 days before, and the scene says so. Taking a
// file away only hides it: Backblaze removes hidden files for good 7 days later (the bucket's rule), so for 7 days
// anything can be brought back. It runs in "report" mode (FOOTAGE_CLEANUP unset): it works out and logs what it would
// do, sends nothing and hides nothing, until it's switched "on".

export const DAY = 86_400_000;
export const KEEP_DAYS = { unexported: 14, indie: 30, pro: 60, studio: 90 } as const;
export type CleanupMode = "report" | "on";
type Plan = "indie" | "pro" | "studio";

export type SceneFacts = {
  unlockedAt: Date | null;
  plan: Plan;
  /** The latest upload, version, final or export. */
  lastActivity: Date;
  keepFootage: boolean;
  /** Uploading, cutting or making a final right now. */
  busy: boolean;
  warnedAt: Date | null;
  warned3At: Date | null;
};

export type Decision = { until: Date; action: "warn" | "warn_3" | "remove" | null; clearWarnings: boolean };

const later = (a: number, b: number) => new Date(Math.max(a, b));

/**
 * What happens to a scene's camera files today. The clock starts at the latest activity (an export, a new version or
 * a final restarts it). Nothing is ever taken away less than 7 days after the first warning and 3 after the second,
 * whatever the date says: a warning sent late moves the date.
 */
export function decide(s: SceneFacts, now: Date): Decision {
  const start = Math.max(s.lastActivity.getTime(), s.unlockedAt?.getTime() ?? 0);
  const due = start + (s.unlockedAt ? KEEP_DAYS[s.plan] : KEEP_DAYS.unexported) * DAY;
  // Warnings sent before the latest activity were about an earlier date: a new round.
  const stale = Boolean(s.warnedAt && s.warnedAt.getTime() < start);
  const warnedAt = stale ? null : s.warnedAt;
  const warned3At = stale ? null : s.warned3At;
  let until = due;
  if (warnedAt) until = Math.max(until, warnedAt.getTime() + 7 * DAY);
  if (warned3At) until = Math.max(until, warned3At.getTime() + 3 * DAY);
  const t = now.getTime();
  if (s.keepFootage) return { until: new Date(until), action: null, clearWarnings: Boolean(s.warnedAt) };
  if (s.busy) return { until: new Date(until), action: null, clearWarnings: stale };
  if (!warnedAt) return t >= due - 7 * DAY ? { until: later(due, t + 7 * DAY), action: "warn", clearWarnings: stale } : { until: new Date(due), action: null, clearWarnings: stale };
  if (!warned3At) return t >= until - 3 * DAY ? { until: later(until, t + 3 * DAY), action: "warn_3", clearWarnings: false } : { until: new Date(until), action: null, clearWarnings: false };
  return { until: new Date(until), action: t >= until ? "remove" : null, clearWarnings: false };
}

/** Taking camera files away (hiding them in B2), and finding hidden files that aren't camera files. */
export type CleanupStorage = {
  hide(key: string): Promise<void>;
  /** Hidden files (their newest version is a hide marker) outside any Raw folder. */
  oddHidden(): Promise<string[]>;
};

export function createCleanupStorage(config: { endpoint: string; region: string; bucket: string; keyId: string; appKey: string }): CleanupStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.keyId, secretAccessKey: config.appKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.bucket;
  return {
    // No version id: B2 hides the file (a delete marker); the bucket's 7-day rule removes it for good.
    hide: async (key) => void (await client.send(new DeleteObjectCommand({ Bucket, Key: key }))),
    oddHidden: async () => {
      const odd: string[] = [];
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;
      do {
        const page = await client.send(new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
        for (const m of page.DeleteMarkers ?? []) if (m.IsLatest && m.Key && !m.Key.includes("/Raw/")) odd.push(m.Key);
        KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (KeyMarker);
      return odd;
    },
  };
}

export type Mailer = (to: string[], subject: string, html: string) => Promise<void>;

/** Emails through Resend, from hi@editloupe.com (the sign-in emails' sender). */
export function resendMailer(apiKey: string): Mailer {
  return async (to, subject, html) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Loupe <hi@editloupe.com>", to, subject, html }),
    });
    if (!response.ok) throw new Error(`Resend said ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
}

const SITE = "https://editloupe.com";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const dateWords = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const page = (body: string) =>
  `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#161614;max-width:520px">${body}<p style="color:#8a8a84;font-size:13px">Loupe · editloupe.com</p></div>`;
const button = (href: string, words: string) =>
  `<a href="${href}" style="display:inline-block;background:#161614;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;margin:4px 8px 4px 0">${words}</a>`;

export function warningEmail(scene: { id: number; name: string }, until: Date, daysLeft: number) {
  const link = `${SITE}/scenes/${scene.id}`;
  return {
    subject: daysLeft <= 3 ? `3 days left: the camera files for ${scene.name}` : `Your camera files for ${scene.name} are kept until ${dateWords(until)}`,
    html: page(
      `<p>Hi,</p><p>The camera files for <b>${esc(scene.name)}</b> are kept in Loupe until <b>${dateWords(until)}</b>${daysLeft <= 3 ? " (3 days left)" : ""}.</p>` +
        `<p>Your cuts, timelines and proxies stay either way. To keep the originals too, switch on Keep footage, or download them.</p>` +
        `<p>${button(`${link}?export=1`, "Download them")}${button(`${link}?keep=1`, "Keep them")}</p>`,
    ),
  };
}

export function removedEmail(scene: { id: number; name: string }, on: Date) {
  return {
    subject: `The camera files for ${scene.name} were removed`,
    html: page(
      `<p>Hi,</p><p>The camera files for <b>${esc(scene.name)}</b> were removed on ${dateWords(on)}. Your cuts, timelines and proxies are all still there.</p>` +
        `<p>To bring the originals back, drop the same cards onto the scene: Loupe uploads only what's missing.</p><p>${button(`${SITE}/scenes/${scene.id}`, "Open the scene")}</p>`,
    ),
  };
}

type Row = {
  id: number;
  name: string;
  account_id: number;
  storage_prefix: string;
  unlocked_at: Date | null;
  keep_footage: boolean;
  footage_warned_at: Date | null;
  footage_warned_3_at: Date | null;
  plan: Plan;
  last_activity: Date;
  busy: boolean;
  files: number;
  bytes: number;
};

/**
 * One pass over every scene with camera files. "report": works out each scene's date and what would happen, logs it
 * ("would_…" rows) and changes nothing else. "on": sends the warnings, takes away what's due, logs it.
 */
export async function runCleanup(opts: { sql: Sql; mode: CleanupMode; storage?: CleanupStorage; mail?: Mailer; now?: Date; log: (line: string) => void }) {
  const { sql, mode, log } = opts;
  const now = opts.now ?? new Date();
  const on = mode === "on";
  if (on && (!opts.storage || !opts.mail)) throw new Error("The footage cleanup is on but has no cleanup key or no email key.");
  // Camera files brought back by dropping the cards again: the scene is whole again.
  await sql`
    update loupe_projects p set footage_removed_at = null, footage_warned_at = null, footage_warned_3_at = null
     where p.footage_removed_at is not null
       and not exists (select 1 from loupe_files f where f.project_id = p.id and f.status = 'removed')`;
  const rows = (await sql`
    select p.id, p.name, p.account_id, p.storage_prefix, p.unlocked_at, p.keep_footage, p.footage_warned_at, p.footage_warned_3_at,
           case when a.plan in ('pro', 'studio') and a.subscription_status in ('active', 'trialing', 'past_due') then a.plan else 'indie' end as plan,
           greatest(p.created_at, p.unlocked_at,
                    (select max(coalesce(f.uploaded_at, f.created_at)) from loupe_files f where f.project_id = p.id),
                    (select max(coalesce(c.finished_at, c.created_at)) from loupe_cuts c where c.project_id = p.id),
                    (select max(coalesce(x.finished_at, x.created_at)) from loupe_finals x where x.project_id = p.id)) as last_activity,
           (exists (select 1 from loupe_files f where f.project_id = p.id and f.status in ('pending', 'uploading'))
            or exists (select 1 from loupe_cuts c where c.project_id = p.id and c.status in ('waiting', 'working'))
            or exists (select 1 from loupe_finals x where x.project_id = p.id and x.status in ('waiting', 'working'))) as busy,
           (select count(*) from loupe_files f where f.project_id = p.id and f.status = 'uploaded')::int as files,
           (select coalesce(sum(f.size_bytes), 0) from loupe_files f where f.project_id = p.id and f.status = 'uploaded')::float8 as bytes
      from loupe_projects p join loupe_accounts a on a.id = p.account_id`) as unknown as Row[];

  // A "would_…" or odd row once a day, not every pass.
  const logOnce = async (projectId: number | null, action: string, files: number, bytes: number, detail: string | null) => {
    const [seen] = await sql`
      select 1 from loupe_cleanups
       where action = ${action} and project_id is not distinct from ${projectId} and detail is not distinct from ${detail}
         and created_at > now() - interval '20 hours'`;
    if (!seen) await sql`insert into loupe_cleanups (project_id, action, files, bytes, detail) values (${projectId}, ${action}, ${files}, ${bytes}, ${detail})`;
  };
  const owners = async (accountId: number) =>
    (await sql`select email from loupe_members where account_id = ${accountId} and role = 'owner'`).map((r) => String(r.email));

  const tally = { warn: 0, warn_3: 0, remove: 0, bytes: 0 };
  for (const r of rows) {
    if (r.files === 0) {
      await sql`update loupe_projects set footage_until = null where id = ${r.id} and footage_until is not null`;
      continue;
    }
    const d = decide(
      { unlockedAt: r.unlocked_at, plan: r.plan, lastActivity: new Date(r.last_activity), keepFootage: r.keep_footage, busy: r.busy, warnedAt: r.footage_warned_at, warned3At: r.footage_warned_3_at },
      now,
    );
    await sql`update loupe_projects set footage_until = ${r.keep_footage ? null : d.until} where id = ${r.id}`;
    if (on && d.clearWarnings) await sql`update loupe_projects set footage_warned_at = null, footage_warned_3_at = null where id = ${r.id}`;
    if (!d.action) continue;
    tally[d.action] += 1;
    if (!on) {
      await logOnce(r.id, `would_${d.action}`, r.files, r.bytes, `${r.name} · until ${d.until.toISOString().slice(0, 10)}`);
      if (d.action === "remove") tally.bytes += r.bytes;
      continue;
    }
    const to = await owners(r.account_id);
    if (d.action === "warn" || d.action === "warn_3") {
      if (!to.length) continue;
      const email = warningEmail(r, d.until, d.action === "warn_3" ? 3 : 7);
      try {
        await opts.mail!(to, email.subject, email.html);
      } catch (error) {
        // Not sent: not marked, so it goes again next pass (and nothing is taken away without it).
        log(`Cleanup: couldn't email the ${d.action} for scene ${r.id}: ${(error as Error).message}`);
        continue;
      }
      if (d.action === "warn") await sql`update loupe_projects set footage_warned_at = ${now} where id = ${r.id}`;
      else await sql`update loupe_projects set footage_warned_3_at = ${now} where id = ${r.id}`;
      await sql`insert into loupe_cleanups (project_id, action, files, bytes, detail) values (${r.id}, ${d.action}, ${r.files}, ${r.bytes}, ${to.join(", ")})`;
      continue;
    }
    // Taking the camera files away: only files in the scene's own Raw folder, one at a time, each marked as it goes.
    const raw = await sql`select id, storage_key, size_bytes from loupe_files where project_id = ${r.id} and status = 'uploaded'`;
    let files = 0;
    let bytes = 0;
    for (const f of raw) {
      const key = String(f.storage_key);
      if (!key.startsWith(`${r.storage_prefix}/Raw/`)) {
        log(`Cleanup: skipped ${key}: not in the scene's Raw folder.`);
        continue;
      }
      await opts.storage!.hide(key);
      await sql`update loupe_files set status = 'removed' where id = ${f.id}`;
      files += 1;
      bytes += Number(f.size_bytes);
    }
    await sql`update loupe_projects set footage_removed_at = ${now} where id = ${r.id}`;
    await sql`insert into loupe_cleanups (project_id, action, files, bytes, detail) values (${r.id}, 'remove', ${files}, ${bytes}, ${r.name})`;
    tally.bytes += bytes;
    const email = removedEmail(r, now);
    await opts.mail!(to, email.subject, email.html).catch((error) => log(`Cleanup: couldn't email the removal for scene ${r.id}: ${(error as Error).message}`));
  }

  // Anything hidden that isn't a camera file would be removed for good by the 7-day rule: flagged for a person.
  if (opts.storage) {
    for (const key of await opts.storage.oddHidden()) await logOnce(null, "odd_hidden", 1, 0, key);
  }
  log(
    `Cleanup (${mode}): ${tally.warn} first warnings, ${tally.warn_3} last warnings, ${tally.remove} scenes ${on ? "cleared" : "due"} (${(tally.bytes / 1e9).toFixed(1)} GB).`,
  );
  return tally;
}
