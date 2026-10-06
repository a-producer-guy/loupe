import { defineConfig } from "drizzle-kit";

// Only used to generate migration SQL from src/lib/db/schema.ts. Migrations are
// applied with scripts/migrate.ts after review, never with `drizzle-kit push`:
// this database also holds the Reelarc backend's tables, and tablesFilter keeps
// drizzle-kit from ever looking at anything that isn't a loupe_ table.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./db/migrations",
  tablesFilter: ["loupe_*"],
  migrations: { schema: "drizzle", table: "__loupe_migrations" },
});
