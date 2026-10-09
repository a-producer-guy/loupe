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
      "loupe_finals",
      "loupe_luts",
      "loupe_members",
      "loupe_payments",
      "loupe_projects",
      "loupe_proxy_jobs",
      "loupe_scripts",
      "loupe_share_links",
      "loupe_share_notes",
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
  const link = await pg.query<{ id: number }>(`insert into loupe_share_links (project_id, token) values (1001, 'secret') returning id`);
  await assert.rejects(pg.query(`insert into loupe_share_links (project_id, token) values (1001, 'another')`), /loupe_share_links_one_per_scene_idx/);
  await pg.query(`insert into loupe_share_notes (link_id, project_id, name, at, note) values ($1, 1001, 'Dana', 12.5, 'Hold on her longer')`, [link.rows[0].id]);
  await pg.query(`insert into loupe_finals (cut_id, project_id, kind) select id, 1001, 'original' from loupe_cuts limit 1`);
  await assert.rejects(pg.query(`insert into loupe_finals (cut_id, project_id, kind) select id, 1001, 'original' from loupe_cuts limit 1`), /loupe_finals_one_at_a_time_idx/);
  await assert.rejects(pg.query(`update loupe_finals set kind = 'vhs'`), /loupe_finals_kind_valid/);
  // A payment, and a scene unlocked by it; only the values Loupe knows.
  await pg.query(`insert into loupe_payments (account_id, project_id, kind, amount_cents, stripe_session_id) select account_id, 1001, 'scene', 3900, 'cs_test_1' from loupe_projects where id = 1001`);
  await assert.rejects(pg.query(`insert into loupe_payments (account_id, project_id, kind, amount_cents, stripe_session_id) select account_id, 1001, 'scene', 3900, 'cs_test_1' from loupe_projects where id = 1001`), /loupe_payments_stripe_session_id_unique/);
  await assert.rejects(pg.query(`update loupe_payments set kind = 'tip'`), /loupe_payments_kind_valid/);
  await assert.rejects(pg.query(`update loupe_projects set unlocked_how = 'begged'`), /loupe_projects_unlocked_how_valid/);
  // One version waits per scene (and one is made), so requests queue.
  await assert.rejects(pg.query(`insert into loupe_cuts (project_id) values (1001)`), /loupe_cuts_one_waiting_idx/);
  await pg.query(`update loupe_cuts set status = 'working' where project_id = 1001`);
  await pg.query(`insert into loupe_cuts (project_id) values (1001)`);
  await assert.rejects(pg.query(`update loupe_cuts set status = 'working' where project_id = 1001 and status = 'waiting'`), /loupe_cuts_one_working_idx/);
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
    for (const table of ["loupe_accounts", "loupe_members", "loupe_projects", "loupe_luts", "loupe_card_luts", "loupe_sign_in_attempts", "loupe_scripts", "loupe_cuts", "loupe_share_links", "loupe_share_notes", "loupe_finals", "loupe_payments"]) {
      await assert.rejects(pg.query(`select * from ${table}`), /permission denied/, `${role} on ${table}`);
    }
    await pg.exec(`reset role`);
  }

  const history = await pg.query<{ n: number }>(`select count(*)::int as n from drizzle.__loupe_migrations`);
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS.migrationsFolder, "meta/_journal.json"), "utf8"));
  assert.equal(history.rows[0].n, journal.entries.length, "every migration recorded in Loupe's own history");
});
