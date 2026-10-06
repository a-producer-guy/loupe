import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { contentSecurityPolicy, safeNext, SECURITY_HEADERS } from "../src/lib/security";
import { tlsFor } from "../src/lib/db/supabase-tls";
import { clearWrongCodes, MAX_WRONG_CODES, minutesLocked, recordWrongCode } from "../src/lib/footage/sign-in-guard";

describe("security", () => {
  test("after signing in, people only ever land back inside the app", () => {
    assert.equal(safeNext("/shoots/1001?view=list#clips"), "/shoots/1001?view=list#clips");
    assert.equal(safeNext("/%2F%2Fexample.com"), "/%2F%2Fexample.com", "encoded slashes stay a path here");
    for (const trick of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r\n/evil.com", "https://evil.com", "evil.com", "", 42, undefined]) {
      assert.equal(safeNext(trick), "/", JSON.stringify(trick));
    }
  });

  test("the browser may only run the app's own scripts and load footage from its bucket", () => {
    const live = contentSecurityPolicy("n0nce", { dev: false, https: true, storageOrigin: "https://s3.us-east-005.backblazeb2.com" });
    assert.match(live, /script-src 'self' 'nonce-n0nce' 'strict-dynamic';/);
    assert.doesNotMatch(live, /unsafe-eval/);
    for (const kind of ["img-src", "media-src", "connect-src"]) {
      assert.match(live, new RegExp(`${kind} [^;]*https://s3\\.us-east-005\\.backblazeb2\\.com`), kind);
    }
    assert.match(live, /frame-ancestors 'none'/);
    assert.match(live, /object-src 'none'/);
    assert.match(live, /upgrade-insecure-requests$/);
    const dev = contentSecurityPolicy("n0nce", { dev: true, https: false });
    assert.match(dev, /'unsafe-eval'/, "React's dev overlay needs eval");
    assert.doesNotMatch(dev, /upgrade-insecure-requests/, "localhost is plain http");
    assert.ok(SECURITY_HEADERS.some((h) => h.key === "X-Frame-Options" && h.value === "DENY"));
  });

  test("database connections to Supabase are encrypted and checked against Supabase's certificate", () => {
    const tls = tlsFor("postgresql://loupe_app.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    assert.ok(tls && tls.rejectUnauthorized && tls.servername === "aws-0-us-east-1.pooler.supabase.com");
    assert.match(tls.ca, /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/);
    assert.equal(tlsFor("postgres://loupe_app:pw@localhost:54329/postgres"), false, "local test databases have no TLS");
  });

  test("a sign-in code can't be guessed: 5 wrong ones per 15 minutes per email", async () => {
    const { db } = await createTestDb();
    const email = "guy@reelarc.com";
    for (let i = 1; i < MAX_WRONG_CODES; i++) await recordWrongCode(db, email);
    assert.equal(await minutesLocked(db, email), 0, "4 wrong codes: still allowed");
    await recordWrongCode(db, email);
    assert.equal(await minutesLocked(db, email), 15, "the 5th locks it for the rest of the 15 minutes");
    assert.equal(await minutesLocked(db, "someone@reelarc.com"), 0, "other people aren't affected");

    await db.execute(sql`update loupe_sign_in_attempts set window_start = now() - interval '16 minutes'`);
    assert.equal(await minutesLocked(db, email), 0, "15 minutes later it's open again");
    await recordWrongCode(db, email);
    const [row] = (await db.execute(sql`select failures from loupe_sign_in_attempts`)).rows as { failures: number }[];
    assert.equal(row.failures, 1, "and the count starts over");

    await clearWrongCodes(db, email);
    assert.equal(await minutesLocked(db, email), 0);
  });
});
