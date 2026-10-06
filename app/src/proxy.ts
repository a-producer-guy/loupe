import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@/lib/security";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookies";

// Runs before every page. Each page view gets a fresh nonce and the Content-Security-Policy built
// on it (Next.js stamps the nonce on its own scripts, so only those run). On every page except
// sign-in, it also keeps the sign-in session fresh and sends signed-out visitors to /login. API
// routes aren't matched here: they check sign-in themselves, and every page checks team
// membership too.

type Cookie = { name: string; value: string; options: Parameters<NextResponse["cookies"]["set"]>[2] };

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
    storageOrigin: process.env.B2_ENDPOINT,
  });

  const path = request.nextUrl.pathname;
  const signInPage = path === "/login" || path.startsWith("/auth/");
  // Local testing only; see currentEmail() in lib/auth.ts.
  const devSignIn = process.env.NODE_ENV === "development" && Boolean(process.env.DEV_SIGN_IN_AS);
  const refreshed: Cookie[] = [];
  const extraHeaders: Record<string, string> = {};

  if (!signInPage && !devSignIn) {
    const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          // Seen by this request's page, and sent back to the browser below.
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          refreshed.push(...cookiesToSet);
          Object.assign(extraHeaders, headers ?? {});
        },
      },
    });
    const { data } = await supabase.auth.getClaims();
    if (!data?.claims) {
      const login = request.nextUrl.clone();
      login.pathname = "/login";
      login.search = "";
      if (path !== "/") login.searchParams.set("next", path);
      return NextResponse.redirect(login);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const { name, value, options } of refreshed) response.cookies.set(name, value, options);
  for (const [key, value] of Object.entries(extraHeaders)) response.headers.set(key, value);
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Every page, sign-in included. Not API routes, and not static files.
      source: "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|otf|woff2?)$).*)",
      // Prefetches don't render a page, so they need no nonce.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
