// A throwaway Postgres (PGlite, in memory) with the real migrations applied,
// plus stand-ins for what Supabase already has: the anon/authenticated roles
// and one of the backend's tables.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "../../src/lib/db/schema";

export const MIGRATIONS = {
  migrationsFolder: path.join(__dirname, "../../db/migrations"),
  migrationsSchema: "drizzle",
  migrationsTable: "__loupe_migrations",
};

export async function createTestDb() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create table public.users (id serial primary key, email text);
    insert into public.users (email) values ('client@example.com');
  `);
  const db = drizzle(pg, { schema });
  await migrate(db, MIGRATIONS);
  return { pg, db };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
