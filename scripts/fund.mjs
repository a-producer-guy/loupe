#!/usr/bin/env node
// The free-cutting fund at a glance: what's in it, and its last movements (sales in, free cuts out).
//
//   node scripts/fund.mjs
//
// Free cuts only start when the fund can cover them, so free cutting never costs more than the launch budget plus
// half of all sales (app/src/lib/fund.ts).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const postgres = createRequire(path.join(APP, "package.json"))("postgres");
const env = parseEnv(readFileSync(path.join(APP, ".env.local"), "utf8"));
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const money = (cents) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const KIND = { start: "Launch budget", sale: "Sale (half)", plan: "Plan month (half)", free_cut: "Free cut", adjust: "Adjustment" };

const [{ balance, sales, spent }] = await sql`
  select coalesce(sum(amount_cents), 0)::int as balance,
         coalesce(sum(amount_cents) filter (where kind in ('sale', 'plan')), 0)::int as sales,
         coalesce(-sum(amount_cents) filter (where kind = 'free_cut'), 0)::int as spent
    from loupe_fund`;
console.log(`\nFree-cutting fund: ${money(balance)}`);
console.log(`  From sales: ${money(sales)}   Spent on free cuts: ${money(spent)}\n`);
const rows = await sql`select amount_cents, kind, created_at from loupe_fund order by id desc limit 15`;
for (const r of rows) console.log(`  ${r.created_at.toISOString().slice(0, 16).replace("T", " ")}  ${money(r.amount_cents).padStart(10)}  ${KIND[r.kind] ?? r.kind}`);
console.log("");
await sql.end();
