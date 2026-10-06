import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb, MIGRATIONS } from "./helpers/db";

test("the footage migrations apply cleanly and lock access down", async () => {
  const { pg } = await createTestDb();

  const tables = await pg.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class where relname like 'footage_%' and relkind = 'r' order by relname`,
  );
  assert.deepEqual(
    tables.rows.map((r) => r.relname),
    ["footage_card_luts", "footage_files", "footage_luts", "footage_members", "footage_projects", "footage_proxy_jobs", "footage_sign_in_attempts"],
  );
  assert.ok(tables.rows.every((r) => r.relrowsecurity), "row-level security is on for every footage table");

  const guy = await pg.query(`select email, role from footage_members`);
  assert.deepEqual(guy.rows, [{ email: "guy@reelarc.com", role: "admin" }]);

  // footage_app can work with footage tables...
  await pg.exec(`set role footage_app`);
  const inserted = await pg.query<{ id: number }>(
    `insert into footage_projects (name, shoot_date, storage_prefix, dp_name) values ('Test', '2026-09-23', 'x', 'Sam Rivera') returning id`,
  );
  assert.equal(Number(inserted.rows[0].id), 1001, "shoot ids start at 1001");
  await pg.query(`select nextval(pg_get_serial_sequence('footage_projects', 'id'))`);
  // ...including the LUT tables.
  const lut = await pg.query<{ id: number }>(
    `insert into footage_luts (name, storage_key, size_bytes, cube_size) values ('Show LUT', 'LUTs/x/show.cube', 10, 33) returning id`,
  );
  await pg.query(`insert into footage_card_luts (project_id, card, lut_id) values (1001, 'B001', $1)`, [lut.rows[0].id]);
  await pg.query(`insert into footage_sign_in_attempts (email, failures) values ('guy@reelarc.com', 1)`);
  // ...but can't see the backend's tables, or call the sign-up check.
  await assert.rejects(pg.query(`select public.footage_before_user_created('{}'::jsonb)`), /permission denied/);
  await assert.rejects(pg.query(`select * from public.users`), /permission denied/);
  await pg.exec(`reset role`);

  // Supabase's public API roles get nothing.
  for (const role of ["anon", "authenticated"]) {
    await pg.exec(`set role ${role}`);
    for (const table of ["footage_projects", "footage_luts", "footage_card_luts", "footage_sign_in_attempts"]) {
      await assert.rejects(pg.query(`select * from ${table}`), /permission denied/, `${role} on ${table}`);
    }
    await assert.rejects(pg.query(`select public.footage_before_user_created('{}'::jsonb)`), /permission denied/, `${role} runs the check`);
    await pg.exec(`reset role`);
  }

  // Supabase Auth's check before it creates any account: team members only.
  const check = async (email: string) =>
    (await pg.query<{ r: object }>(`select public.footage_before_user_created($1::jsonb) as r`, [JSON.stringify({ user: { email } })])).rows[0].r;
  assert.deepEqual(await check("Guy@Reelarc.com"), {}, "on the team list: allowed");
  assert.deepEqual(await check("stranger@example.com"), {
    error: { http_code: 403, message: "This email is not on the Reelarc Footage team list." },
  });

  const history = await pg.query<{ n: number }>(`select count(*)::int as n from drizzle.__footage_migrations`);
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS.migrationsFolder, "meta/_journal.json"), "utf8"));
  assert.equal(history.rows[0].n, journal.entries.length, "every migration recorded in the footage app's own history");
});
