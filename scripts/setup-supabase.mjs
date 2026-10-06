#!/usr/bin/env node
// One-time Supabase sign-in setup for Loupe.
//
//   node scripts/setup-supabase.mjs
//
// Works out the project's address from the database login scripts/migrate.ts
// saved, asks for the project's Publishable key (typed in, kept off the
// screen), checks it and whether email sign-in is switched on, then saves both
// into app/.env.local. The key is only ever used on the server: the backend's
// tables don't use row-level security, so this key must never reach a browser.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { ask, writeEnv } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ENV = path.join(ROOT, "app/.env.local");
const PROJECT_URL = /^https:\/\/[a-z0-9]+\.supabase\.co$/;

/** https://<ref>.supabase.co, from the saved settings or the loupe_app login ("loupe_app.<ref>"). */
function savedProjectUrl() {
  if (!existsSync(APP_ENV)) return null;
  const env = parseEnv(readFileSync(APP_ENV, "utf8"));
  if (env.SUPABASE_URL) return env.SUPABASE_URL.replace(/\/+$/, "");
  if (!env.DATABASE_URL) return null;
  const login = new URL(env.DATABASE_URL);
  const user = decodeURIComponent(login.username);
  const ref = user.includes(".") ? user.split(".").pop() : login.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  return ref ? `https://${ref}.supabase.co` : null;
}

/** Secret keys skip every safeguard, so the app must never hold one. */
function isSecretKey(key) {
  if (key.startsWith("sb_secret_")) return true;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

async function main() {
  console.log("\nLoupe: Supabase sign-in setup\n");
  let url = savedProjectUrl();
  if (url) console.log(`Project: ${url}\n`);
  else url = (await ask("  Project URL (https://….supabase.co): ")).replace(/\/+$/, "");
  if (!PROJECT_URL.test(url)) throw new Error("That doesn't look like a Supabase project URL (https://….supabase.co).");

  console.log("Paste the project's Publishable key (or the legacy \"anon public\" key). It's saved only in app/.env.local.\n");
  const key = await ask("  key (hidden): ", { hidden: true });
  if (!key) throw new Error("No key was pasted.");
  if (isSecretKey(key)) throw new Error("That's a secret key. Copy the Publishable (or anon) key instead; nothing was saved.");

  const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  const settings = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Supabase didn't accept that key (${settings.message || settings.msg || response.status}). Copy it again; nothing was saved.`);
  }

  writeEnv(APP_ENV, { SUPABASE_URL: url, SUPABASE_ANON_KEY: key });
  console.log("\n✓ The key works. Saved it into app/.env.local (kept out of git).");
  console.log(
    settings.external?.email
      ? "✓ Email sign-in is switched on."
      : "! Email sign-in is off. Turn it on in Supabase: Authentication → Sign In / Providers → Email.",
  );
  console.log(
    settings.disable_signup
      ? '! New sign-ups are off, so a team member\'s first sign-in would fail. Turn on "Allow new users to sign up" in Authentication → Sign In / Providers.'
      : "✓ Team members can sign in for the first time.",
  );
  console.log("\nAll done.\n");
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});
