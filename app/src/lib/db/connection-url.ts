// Normalizes a Supabase DATABASE_URL, same rules as the Reelarc backend's
// src/lib/db/connectionUrl.ts: the Connect dialog's direct host
// (db.<ref>.supabase.co) is IPv6-only and unreachable from Vercel, so it is
// rewritten to the pooler, and a pasted "[password]" loses its brackets.

const DEFAULT_POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";

export function normalizeDatabaseUrl(raw: string, mode: "transaction" | "session" = "transaction"): string {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^["']|["']$/g, ""));
  } catch {
    return raw;
  }
  if (url.password.startsWith("%5B") && url.password.endsWith("%5D")) url.password = url.password.slice(3, -3);
  else if (url.password.startsWith("[") && url.password.endsWith("]")) url.password = url.password.slice(1, -1);

  const direct = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (direct) {
    const user = url.username.includes(".") ? url.username.split(".")[0] : url.username;
    url.username = `${user}.${direct[1]}`;
    url.hostname = process.env.SUPABASE_POOLER_HOST || DEFAULT_POOLER_HOST;
  }
  if (url.hostname.endsWith(".pooler.supabase.com")) {
    url.port = mode === "transaction" ? "6543" : "5432";
  }
  return url.toString();
}
