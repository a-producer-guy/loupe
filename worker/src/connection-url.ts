// Same rules as app/src/lib/db/connection-url.ts: Supabase's direct host is
// IPv6-only, so use the pooler, and drop "[brackets]" pasted around a password.

const DEFAULT_POOLER_HOST = "aws-0-us-east-1.pooler.supabase.com";

export function normalizeDatabaseUrl(raw: string): string {
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
  if (url.hostname.endsWith(".pooler.supabase.com")) url.port = "6543";
  return url.toString();
}
