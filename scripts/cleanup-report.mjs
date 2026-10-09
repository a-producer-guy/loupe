#!/usr/bin/env node
// What the footage cleanup did, or would do (report-only mode), over the last days: scenes due a warning, scenes due
// to have their camera files taken away (with the space that frees), and any hidden file that isn't a camera file.
//
//   node scripts/cleanup-report.mjs        (the last 7 days)
//   node scripts/cleanup-report.mjs 30     (the last 30)

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const postgres = createRequire(path.join(APP, "package.json"))("postgres");
const env = parseEnv(readFileSync(path.join(APP, ".env.local"), "utf8"));
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const days = Math.max(1, Number(process.argv[2]) || 7);
const WHAT = {
  would_warn: "Would send the 7-day warning",
  would_warn_3: "Would send the 3-day warning",
  would_remove: "Would take the camera files away",
  warn: "Sent the 7-day warning",
  warn_3: "Sent the 3-day warning",
  remove: "Took the camera files away",
  odd_hidden: "LOOK AT THIS: a hidden file that isn't a camera file",
};
const gb = (b) => `${(Number(b) / 1e9).toFixed(1)} GB`;

const rows = await sql`
  select c.created_at, c.action, c.files, c.bytes, c.detail, p.name
    from loupe_cleanups c left join loupe_projects p on p.id = c.project_id
   where c.created_at > now() - make_interval(days => ${days})
   order by c.created_at desc`;
console.log(`\nFootage cleanup, the last ${days} days: ${rows.length ? "" : "nothing to report."}`);
for (const r of rows) {
  const when = r.created_at.toISOString().slice(0, 10);
  const size = Number(r.bytes) ? ` · ${r.files} files, ${gb(r.bytes)}` : "";
  console.log(`  ${when}  ${WHAT[r.action] ?? r.action}: ${r.name ?? r.detail}${size}${r.detail && r.name ? ` (${r.detail})` : ""}`);
}
const [{ freed }] = await sql`select coalesce(sum(bytes), 0)::float8 as freed from loupe_cleanups where action = 'remove'`;
const [{ kept }] = await sql`select count(*)::int as kept from loupe_projects where keep_footage`;
console.log(`\nSpace freed so far: ${gb(freed)} (about $${((freed / 1e12) * 6.95).toFixed(2)} a month). Scenes with Keep footage: ${kept}.\n`);
await sql.end();
