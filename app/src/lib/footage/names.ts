// Naming rules shared by the browser and the server: which files count, where
// they go in B2, and how sizes read on screen. No server-only imports here.

/** System clutter that cards and drives collect. Never uploaded. */
const CLUTTER = new Set([
  "thumbs.db",
  "desktop.ini",
  "system volume information",
  "$recycle.bin",
  "icon\r",
]);

/** Hidden files and folders (.DS_Store, .Spotlight-V100, ._C0001.MP4...) and OS clutter. */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".") || CLUTTER.has(name.toLowerCase());
}

export function isHiddenPath(path: string): boolean {
  return path.split("/").some(isHiddenName);
}

// Clips that get a proxy. Camera RAW formats are listed too: the worker can't
// read them, and says so on the clip instead of quietly skipping it.
// Low-res sidecars (.LRV, .LRF) and thumbnails (.THM) are left out on purpose.
const VIDEO_EXTENSIONS = new Set([
  "mov", "mp4", "m4v", "mxf", "mts", "m2ts", "avi", "mkv", "webm", "mpg", "mpeg", "3gp", "wmv", "dv", "flv",
  "r3d", "braw", "crm", "ari", "arx", "nev",
]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(path));
}

// Letters that don't break down into a plain letter plus an accent.
const LETTERS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th" };

/** "Jane Doe" → "jane-doe". Accents dropped, 40 characters at most. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[øæœßłđðþ]/g, (letter) => LETTERS[letter])
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "shoot";
}

/** The shoot's folder in B2, e.g. "2026-09-23_jane-doe_p1042". */
export function storagePrefix(shootDate: string, name: string, id: number): string {
  return `${shootDate}_${slugify(name)}_p${id}`;
}

/**
 * Tidies a path from the browser, or returns null if it can't be stored
 * safely (empty parts, "..", characters B2 keys can't hold).
 */
export function cleanRelativePath(path: string): string | null {
  const parts = path.normalize("NFC").replace(/\\/g, "/").split("/").filter((p) => p !== "");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === ".." || /[\u0000-\u001f\u007f]/.test(p))) return null;
  return parts.join("/");
}

/** Where a dropped file lives inside the shoot's folder. */
export function rawPath(card: string, relativePath: string): string {
  return card ? `Raw/${card}/${relativePath}` : `Raw/${relativePath}`;
}

/**
 * The proxy's path for a raw clip: same folders under Proxies/ instead of Raw/,
 * same base name, .mov. Premiere's Attach Proxies depends on this.
 */
export function proxyPath(raw: string): string {
  const inside = raw.replace(/^Raw\//, "");
  const slash = inside.lastIndexOf("/");
  const dot = inside.lastIndexOf(".");
  const base = dot > slash + 1 ? inside.slice(0, dot) : inside;
  return `Proxies/${base}.mov`;
}

/** Where the worker keeps a clip's still: beside Proxies/, never inside it, so Premiere can't mistake it for a proxy. */
export function thumbnailKey(proxyKey: string): string {
  return proxyKey.replace("/Proxies/", "/Thumbnails/").replace(/\.mov$/i, ".jpg");
}

/** 125.4 → "2:05", 3725 → "1:02:05" */
export function formatRuntime(seconds: number | undefined | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Folder names to try for a dropped card, in order. Two cards both called
 * "Untitled" must not land in the same folder, so the second becomes
 * "Untitled 2". Loose files (no folder) go straight into Raw/ first.
 */
export function cardNameCandidates(name: string, count = 50): string[] {
  const base = name || "Upload";
  return [name, ...Array.from({ length: count - 1 }, (_, i) => `${base} ${i + 2}`)];
}

export const MAX_KEY_BYTES = 1000; // B2 allows 1024; keep a little room.

export function keyFits(key: string): boolean {
  return new TextEncoder().encode(key).length <= MAX_KEY_BYTES;
}

/** Card folders in reading order: A001, A002 … A010, Untitled, Untitled 2; loose files last. */
export function sortCards(cards: string[]): string[] {
  return [...cards].sort((a, b) => Number(a === "") - Number(b === "") || a.localeCompare(b, undefined, { numeric: true }));
}

/** Sizes the way Finder shows them (1 GB = 1,000,000,000 bytes). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "Jane  Doe sep" → ["jane", "doe", "sep"]: a shoot has to contain every word to match. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

/**
 * The text a shoot can be found by: its name, its DP, its date written a few
 * ways ("2026-09-23 september sep 23") and its number ("p1001"). The database
 * builds the same text in searchShoots, for shoots this screen hasn't loaded.
 */
export function shootSearchText(shoot: { id: number; name: string; shootDate: string; dpName?: string | null }): string {
  const date = new Date(`${shoot.shootDate}T12:00:00Z`);
  const month = (style: "long" | "short") => date.toLocaleDateString("en-US", { month: style, timeZone: "UTC" });
  const dp = shoot.dpName ? `${shoot.dpName} ` : "";
  return `${shoot.name} ${dp}${shoot.shootDate} ${month("long")} ${month("short")} ${date.getUTCDate()} p${shoot.id}`.toLowerCase();
}

/** "about 12 min left", or "less than a minute left" near the end. Empty when unknown. */
export function formatTimeLeft(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  return seconds < 60 ? "less than a minute left" : `about ${formatDuration(seconds)} left`;
}

/** Where a clip's browser-playable preview sits: beside Proxies/, never inside it. */
export function previewKey(proxyKey: string): string {
  return proxyKey.replace("/Proxies/", "/Previews/").replace(/\.mov$/i, ".mp4");
}

/**
 * The clip's own timecode a number of seconds into playback, so the player
 * shows what an editor sees in Premiere. Handles drop-frame (";") at 29.97
 * and 59.94. Null when the clip has no timecode or frame rate.
 */
export function timecodeAt(start: string | undefined, fps: string | undefined, seconds: number): string | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2,3})$/.exec(start?.trim() ?? "");
  const rate = Number(fps);
  if (!match || !Number.isFinite(rate) || rate <= 0) return null;
  const nominal = Math.round(rate); // 23.976 counts 24 frames a timecode second, 29.97 counts 30
  const drop = match[4] === ";" && (nominal === 30 || nominal === 60) ? nominal / 15 : 0;
  const [hours, minutes, secs, frame] = [match[1], match[2], match[3], match[5]].map(Number);
  const allMinutes = hours * 60 + minutes;
  let frames = (hours * 3600 + minutes * 60 + secs) * nominal + frame - drop * (allMinutes - Math.floor(allMinutes / 10));
  frames += Math.floor(seconds * rate + 1e-6);
  if (drop) {
    // Drop-frame skips the first frame numbers of every minute except each tenth one.
    const perTen = nominal * 600 - drop * 9;
    const perMinute = nominal * 60 - drop;
    const rest = frames % perTen;
    frames += drop * 9 * Math.floor(frames / perTen) + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  const day = nominal * 86_400;
  frames = ((frames % day) + day) % day;
  const pad = (n: number) => String(n).padStart(2, "0");
  const totalSeconds = Math.floor(frames / nominal);
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}${drop ? ";" : ":"}${pad(frames % nominal)}`;
}
