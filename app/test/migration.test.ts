import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb, MIGRATIONS } from "./helpers/db";

test("the Loupe migrations apply cleanly and lock access down", async () => {
  const { pg } = await createTestDb();

  const tables = await pg.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class where relname like 'loupe_%' and relkind = 'r' order by relname`,
  );
  assert.deepEqual(
    tables.rows.map((r) => r.relname),
    [
      "loupe_accounts",
      "loupe_card_luts",
      "loupe_cuts",
      "loupe_files",
      "loupe_luts",
      "loupe_members",
      "loupe_projects",
      "loupe_proxy_jobs",
      "loupe_scripts",
      "loupe_sign_in_attempts",
    ],
  );
  assert.ok(tables.rows.every((r) => r.relrowsecurity), "row-level security is on for every Loupe table");
  assert.deepEqual((await pg.query(`select * from loupe_members`)).rows, [], "nobody is seeded: anyone can sign up");

  // loupe_app can work with every Loupe table...
  await pg.exec(`set role loupe_app`);
  const account = await pg.query<{ id: number }>(`insert into loupe_accounts (name) values ('Test Studio') returning id`);
  const accountId = account.rows[0].id;
  await pg.query(`insert into loupe_members (account_id, email) values ($1, 'owner@example.com')`, [accountId]);
  const inserted = await pg.query<{ id: number }>(
    `insert into loupe_projects (account_id, name, shoot_date, storage_prefix) values ($1, 'Test', '2026-09-23', 'x') returning id`,
    [accountId],
  );
  assert.equal(Number(inserted.rows[0].id), 1001, "scene ids start at 1001");
  const lut = await pg.query<{ id: number }>(
    `insert into loupe_luts (account_id, name, storage_key, size_bytes, cube_size) values ($1, 'Show LUT', 'LUTs/a1/x/show.cube', 10, 33) returning id`,
    [accountId],
  );
  await pg.query(`insert into loupe_card_luts (project_id, card, lut_id) values (1001, 'B001', $1)`, [lut.rows[0].id]);
  await pg.query(`insert into loupe_sign_in_attempts (email, failures) values ('owner@example.com', 1)`);
  const script = await pg.query<{ id: number }>(
    `insert into loupe_scripts (account_id, project_id, title, roles, lines, file_name, storage_key, size_bytes)
     values ($1, 1001, 'The Offer', '["MAYA","DANIEL"]', '[]', 'offer.fdx', 'Scripts/a1/x/offer.fdx', 10) returning id`,
    [accountId],
  );
  await pg.query(`insert into loupe_cuts (project_id, script_id) values (1001, $1)`, [script.rows[0].id]);
  // One cut waits or works per scene at a time.
  await assert.rejects(pg.query(`insert into loupe_cuts (project_id) values (1001)`), /loupe_cuts_one_at_a_time_idx/);
  await assert.rejects(pg.query(`update loupe_cuts set status = 'maybe'`), /loupe_cuts_status_valid/);
  // ...but nothing else in the database.
  await assert.rejects(pg.query(`select * from public.users`), /permission denied/);
  // Plans and roles only take the values Loupe knows.
  await assert.rejects(pg.query(`update loupe_accounts set plan = 'platinum'`), /loupe_accounts_plan_valid/);
  await assert.rejects(pg.query(`update loupe_members set role = 'admin'`), /loupe_members_role_valid/);
  await pg.exec(`reset role`);

  // Supabase's public API roles get nothing.
  for (const role of ["anon", "authenticated"]) {
    await pg.exec(`set role ${role}`);
    for (const table of ["loupe_accounts", "loupe_members", "loupe_projects", "loupe_luts", "loupe_card_luts", "loupe_sign_in_attempts", "loupe_scripts", "loupe_cuts"]) {
      await assert.rejects(pg.query(`select * from ${table}`), /permission denied/, `${role} on ${table}`);
    }
    await pg.exec(`reset role`);
  }

  const history = await pg.query<{ n: number }>(`select count(*)::int as n from drizzle.__loupe_migrations`);
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS.migrationsFolder, "meta/_journal.json"), "utf8"));
  assert.equal(history.rows[0].n, journal.entries.length, "every migration recorded in Loupe's own history");
});
