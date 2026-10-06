"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { findMember, safeNext } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { clearWrongCodes, minutesLocked, recordWrongCode } from "@/lib/footage/sign-in-guard";
import { createSupabase } from "@/lib/supabase/server";

export type LoginState = { step: "email" | "code"; email?: string; next: string; error?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function appOrigin(): Promise<string> {
  if (env.appUrl) return env.appUrl;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3210";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function sendLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  if (!EMAIL.test(email)) return { step: "email", email, next, error: "That doesn't look like an email address." };

  if (!(await findMember(email))) {
    return { step: "email", email, next, error: "That email isn't on the Reelarc team list yet. Ask Guy to add you." };
  }

  const callback = new URL("/auth/callback", await appOrigin());
  if (next !== "/") callback.searchParams.set("next", next);
  const supabase = await createSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callback.toString(), shouldCreateUser: true },
  });
  // What Supabase said, for the server log: the reason an email didn't go out
  // (SMTP settings, rate limits) never shows on the page.
  console.info(
    error
      ? `Sign-in email to ${email} refused by Supabase: ${error.status ?? "?"} ${error.code ?? ""} ${error.message}`
      : `Sign-in email to ${email} accepted by Supabase.`,
  );
  if (error) {
    const tooSoon = error.status === 429 || /rate limit|security purposes/i.test(error.message);
    return {
      step: "email",
      email,
      next,
      error: tooSoon
        ? "A link was sent a moment ago. Check your email, or wait a minute and try again."
        : "Couldn't send the sign-in email. Try again in a minute.",
    };
  }
  return { step: "code", email, next };
}

export async function verifyCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  const token = String(form.get("code") ?? "").replace(/\D/g, "");
  if (token.length < 6) return { step: "code", email, next, error: "Type all 6 digits from the email." };
  const wrong = { step: "code" as const, email, next, error: "That code didn't work. Use the newest email, or ask for a new link." };

  // Only team members have codes to check, and each gets 5 tries per 15 minutes.
  const db = getDb();
  if (!EMAIL.test(email) || !(await findMember(email))) return wrong;
  const wait = await minutesLocked(db, email);
  if (wait > 0) {
    console.info(`Sign-in code for ${email} not checked: too many wrong codes, ${wait} min to wait.`);
    return {
      step: "code",
      email,
      next,
      error: `Too many wrong codes. Wait ${wait} minute${wait === 1 ? "" : "s"}, then ask for a new link.`,
    };
  }

  const supabase = await createSupabase();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) {
    await recordWrongCode(db, email);
    console.info(`Sign-in code for ${email} refused by Supabase: ${error.status ?? "?"} ${error.code ?? ""} ${error.message}`);
    return wrong;
  }
  await clearWrongCodes(db, email);
  redirect(next);
}
