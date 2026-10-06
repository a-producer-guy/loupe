// What the browser is allowed to do on footage.reelarc.com. No server-only imports here:
// next.config.ts and proxy.ts both use it.

/**
 * The Content-Security-Policy for one page view. Scripts run only if they carry this request's
 * nonce (Next.js adds it to its own), so injected scripts can't. Stills, clip previews, uploads
 * and downloads may only come from the footage bucket (`storageOrigin`, B2's endpoint); nothing
 * else outside the app is reachable, and no other site may frame the app.
 */
export function contentSecurityPolicy(nonce: string, options: { dev: boolean; https: boolean; storageOrigin?: string }): string {
  const storage = options.storageOrigin ? ` ${new URL(options.storageOrigin).origin}` : "";
  const directives = [
    "default-src 'self'",
    // React only needs eval in development, for its error overlays.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    // Progress bars and covers set style attributes, which nonces can't cover. Styles can't run code.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${storage}`,
    `media-src 'self' blob:${storage}`,
    `connect-src 'self'${storage}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only on https pages (the live site): a plain-http test server on a Mac would lose its own files.
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/**
 * Only allows redirects back into this app (never to another site). Checked the way a browser
 * reads the address, so tricks like "/\t/evil.com" or "/\evil.com" (browsers drop tabs and treat
 * "\" as "/") can't turn it into another site's address.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const base = "https://app.invalid";
  try {
    const url = new URL(value, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

/** Sent with every response. */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
