// Sign-in cookies. Only the server ever reads them (the browser never talks to
// Supabase directly), so they're httpOnly: page scripts can't touch them.
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
