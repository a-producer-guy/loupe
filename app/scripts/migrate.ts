// Sets up (and later updates) Loupe's tables in Loupe's own Supabase project.
//
//   MIGRATION_DATABASE_URL='<that project's postgres connection>' npm run db:migrate
//   npm run db:migrate -- --admin-env <file with DATABASE_URL=...>   (the same, read from a file)
//   npm run db:migrate -- --check   (look only, change nothing)
//
// Prints exactly what will run and waits for "yes". It only adds loupe_
// tables and the loupe_app login; it never alters anything that exists.
// It refuses a Supabase database that holds another app's tables, so Loupe
// can never land in the Reelarc backend's or Reelarc Footage's database.
// The first time, it gives loupe_app a random password and saves the
// loupe_app connection into app/.env.local and worker/.env. The admin
// connection is only used here and is never saved anywhere.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { normalizeDatabaseUrl } from "../src/lib/db/connection-url";
import { tlsFor } from "../src/lib/db/supabase-tls";

const APP = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(APP, "db/migrations");
// Where the loupe_app connection is saved. LOUPE_ENV_FILES (comma-separated) overrides it for test runs.
const ENV_FILES = process.env.LOUPE_ENV_FILES?.split(",") ?? [path.join(APP, ".env.local"), path.join(APP, "../worker/.env")];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function readEnvValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
}

function writeEnv(file: string, values: Record<string, string>) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** Postgres's own password format, so the plain password never reaches the server (or its logs). */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

async function confirm(question: string): Promise<boolean> {
  if (flag("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function main() {
  const adminEnv = option("--admin-env");
  const raw = process.env.MIGRATION_DATABASE_URL || (adminEnv ? readEnvValue(path.resolve(adminEnv), "DATABASE_URL") : undefined);
  if (!raw) throw new Error("Point me at Loupe's Supabase project's database: set MIGRATION_DATABASE_URL, or --admin-env <file>.");
  const adminUrl = normalizeDatabaseUrl(raw, "session");
  const host = new URL(adminUrl).hostname;
  const sql = postgres(adminUrl, { max: 1, prepare: false, ssl: tlsFor(adminUrl), onnotice: () => {} });

  try {
    const [who] = await sql`select current_user as name`;
    console.log(`\nConnected to ${host} as ${who.name}.`);

    const tables = await sql<{ name: string; rls: boolean }[]>`
      select c.relname as name, c.relrowsecurity as rls
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`;
    const loupeTables = tables.filter((t) => t.name.startsWith("loupe_"));
    const [{ role }] = await sql`select exists (select 1 from pg_roles where rolname = 'loupe_app') as role`;
    const [{ history }] = await sql`select to_regclass('drizzle.__loupe_migrations') is not null as history`;
    const applied = history
      ? await sql<{ created_at: string }[]>`select created_at from drizzle.__loupe_migrations order by created_at`
      : [];
    console.log(`The database has ${tables.length} tables; ${loupeTables.length} of them are Loupe tables.`);

    // Loupe has its own Supabase project. A Supabase database holding other tables is someone
    // else's (Reelarc's backend, or Reelarc Footage), and Loupe must never be set up there.
    const others = tables.filter((t) => !t.name.startsWith("loupe_"));
    if (tlsFor(adminUrl) && others.length > 0) {
      throw new Error(
        `Stopped: this database also holds ${others.length} other table(s) (${others.slice(0, 3).map((t) => t.name).join(", ")}…), so it isn't Loupe's own project. Nothing was changed.`,
      );
    }

    if (flag("--check")) {
      const open = tables.filter((t) => !t.rls && !t.name.startsWith("loupe_"));
      console.log(`Loupe migrations applied: ${applied.length}. loupe_app login exists: ${role ? "yes" : "no"}.`);
      console.log(
        open.length
          ? `Tables without row-level security (${open.length}): ${open.map((t) => t.name).join(", ")}`
          : "Every table has row-level security on.",
      );
      return;
    }

    // First run: the database must be free of anything Loupe-shaped.
    if (applied.length === 0 && (loupeTables.length > 0 || role)) {
      throw new Error("Stopped: Loupe tables or the loupe_app login already exist, but no Loupe migrations are recorded. Nothing was changed.");
    }

    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const last = applied.length ? Number(applied[applied.length - 1].created_at) : 0;
    const pending = journal.entries.filter((entry) => entry.when > last);

    if (pending.length === 0) {
      console.log("Nothing new to apply.");
    } else {
      for (const entry of pending) {
        console.log(`\n──── ${entry.tag}.sql ────\n`);
        console.log(readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
      }
      if (!(await confirm(`\nApply ${pending.length === 1 ? "this change" : "these changes"} to ${host}? Type yes to go ahead: `))) {
        console.log("Stopped. Nothing was changed.");
        return;
      }
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS, migrationsSchema: "drizzle", migrationsTable: "__loupe_migrations" });
      console.log("✓ Applied. Everything ran in one transaction.");
    }

    const appUrl = new URL(normalizeDatabaseUrl(raw, "transaction"));
    const savedUrl = readEnvValue(ENV_FILES[0], "DATABASE_URL");
    const savedForThisDb = savedUrl?.includes("loupe_app") && new URL(savedUrl).hostname === appUrl.hostname;
    if (flag("--new-app-password") || !savedForThisDb) {
      const password = randomBytes(24).toString("base64url");
      await sql.unsafe(`alter role loupe_app with password '${scramVerifier(password)}'`);
      // Supabase's pooler wants "role.projectref" as the user name.
      const ref = appUrl.username.split(".")[1];
      appUrl.username = ref ? `loupe_app.${ref}` : "loupe_app";
      appUrl.password = password;
      for (const file of ENV_FILES) writeEnv(file, { DATABASE_URL: appUrl.toString() });

      // The pooler can take a few seconds to notice a new login.
      let members = -1;
      for (let attempt = 1; attempt <= 10 && members < 0; attempt++) {
        const check = postgres(appUrl.toString(), {
          max: 1,
          prepare: false,
          connect_timeout: 15,
          ssl: tlsFor(appUrl.toString()),
          onnotice: () => {},
        });
        try {
          const [row] = await check`select count(*)::int as n from loupe_members`;
          members = row.n;
        } catch (error) {
          if (attempt === 10) throw new Error(`loupe_app couldn't sign in: ${(error as Error).message}`);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        } finally {
          await check.end({ timeout: 2 });
        }
      }
      const saved = ENV_FILES.map((file) => path.relative(process.cwd(), file)).join(" and ");
      console.log(`✓ loupe_app can sign in and sees ${members} team member(s). Saved its connection into ${saved}.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
