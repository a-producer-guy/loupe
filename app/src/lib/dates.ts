// Shoot dates are plain days (no time), so they're read at noon to stay on the
// same day in every time zone.
const at = (day: string) => new Date(`${day}T12:00:00`);

/** "Sep 23" (or "Sep 23, 2025" when it isn't this year) */
export function shortDate(day: string): string {
  const date = at(day);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "Tuesday, September 23" (with the year when it isn't this year) */
export function longDate(day: string): string {
  const date = at(day);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
