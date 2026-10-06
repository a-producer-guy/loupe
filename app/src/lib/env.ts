import "server-only";

// Server-side settings. None of these reach the browser: the app talks to
// Supabase and Backblaze only from the server, and hands the browser
// short-lived signed links instead.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Add it to app/.env.local (see SETUP.md).`);
  return value;
}

export const env = {
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseAnonKey() {
    return required("SUPABASE_ANON_KEY");
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get b2() {
    return {
      endpoint: required("B2_ENDPOINT"),
      region: required("B2_REGION"),
      bucket: required("B2_BUCKET"),
      keyId: required("B2_KEY_ID"),
      appKey: required("B2_APP_KEY"),
    };
  },
  /** Public address of the app, for sign-in links. Falls back to the request's own address. */
  get appUrl() {
    return process.env.APP_URL?.trim() || undefined;
  },
};
