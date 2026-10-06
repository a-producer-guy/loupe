import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { AUTH_COOKIE_OPTIONS } from "./cookies";

/** Supabase Auth for this request (sign-in links and sessions only; data goes through Drizzle). */
export async function createSupabase() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Pages can't set cookies while rendering; proxy.ts keeps the session fresh for them.
        }
      },
    },
  });
}
