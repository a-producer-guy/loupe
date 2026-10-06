import "server-only";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "@/lib/env";
import { normalizeDatabaseUrl } from "./connection-url";
import * as schema from "./schema";
import { tlsFor } from "./supabase-tls";

// Connects as loupe_app through Supabase's transaction pooler, the right
// choice for serverless: prepared statements off, and a small pool per
// function instance. Encrypted, and checked to really be Supabase.

/** Any footage database handle, including a transaction or a test database. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let instance: ReturnType<typeof create> | undefined;

function create() {
  const url = normalizeDatabaseUrl(env.databaseUrl, "transaction");
  const client = postgres(url, {
    prepare: false,
    max: 5,
    ssl: tlsFor(url),
  });
  return drizzle(client, { schema });
}

export function getDb(): Db {
  return (instance ??= create());
}
