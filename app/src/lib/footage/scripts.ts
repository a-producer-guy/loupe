import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { projects, scripts, type ScriptLine } from "@/lib/db/schema";

// A scene's script (Loupe stage 2). It usually comes in with the scene's own folder (a Final Draft file or its PDF
// among the cards) and is read the moment it's uploaded; it can also be added on its own. Each account has its own:
// a script is only ever matched against that account's scenes. Reading a script only needs the dialogue, who says
// it, and the stage directions between (moves and beats shape the cut). The reader is Reelarc Footage's.

export class ScriptError extends Error {}

export type ParsedScript = { title: string; heading: string | null; roles: string[]; lines: ScriptLine[] };

export const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;

/** "Scene 1- The New Partner drft 5.pdf" → "Scene 1- The New Partner"; "GROVEL_DRFT_1.pdf" → "Grovel". */
export function titleFromFileName(name: string): string {
  let base = name.replace(/\.(fdx|pdf)$/i, "");
  // A name typed without spaces ("Scene1-BurntPancakesdrft3"): split it where the words meet.
  if (!/\s/.test(base)) {
    base = base
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])(\d)/g, "$1 $2");
  }
  const title = base
    .replace(/[\s_-]*(drft|draft|dft|v|ver|version|rev)\.?\s*\d+[a-z]?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return (title === title.toUpperCase() ? readableTitle(title) : title) || "Untitled scene";
}

/** A character cue without its extensions: "ELLIS (CONT'D)" → "ELLIS". */
export function cueName(cue: string): string {
  return cue
    .replace(/\((?:CONT['’]?D|CONTINUING|V\.?O\.?|O\.?S\.?|O\.?C\.?|PRE-?LAP|FILTERED|ON PHONE|INTO PHONE|ON RECORDING|RECORDING|RECORDED|ON SPEAKER|ON TV)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    // "VALE'S VOICE" (a recording of Vale) is Vale.
    .replace(/['’]S VOICE$/, "");
}

const TRANSITION = /^(FADE (OUT|IN|TO BLACK)|SMASH (CUT )?TO BLACK|CUT TO( BLACK)?|DISSOLVE TO|MATCH CUT TO|THE END|END)[.:!]?$/i;
const isHeading = (text: string) => /^(INT|EXT|INT\.?\/EXT|I\/E|EST)[.\s]/i.test(text.trim());
const tidy = (text: string) => text.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();

/** Turns paragraphs (Final Draft's types) into the script: speeches and stage directions. */
export function fromParagraphs(paragraphs: { type: string; text: string }[], fileName: string, title?: string | null): ParsedScript {
  const lines: ScriptLine[] = [];
  let heading: string | null = null;
  let speaker: string | null = null;
  for (const { type, text: raw } of paragraphs) {
    const text = tidy(raw);
    if (!text || /^\((MORE|CONT['’]?D)\)$/i.test(text) || TRANSITION.test(text)) continue;
    const kind = type.toLowerCase();
    if (kind === "scene heading" || (kind === "action" && isHeading(text) && text === text.toUpperCase())) {
      heading ??= text;
      speaker = null;
    } else if (kind === "character") {
      speaker = cueName(text) || null;
    } else if (kind === "dialogue" && speaker) {
      const last = lines.at(-1);
      if (last && last.kind === "speech" && last.who === speaker) last.text = tidy(`${last.text} ${text}`);
      else lines.push({ kind: "speech", who: speaker, text });
    } else if (kind === "parenthetical") {
      // How a line is said ("(beat)", "(quietly)"): not part of what's said.
    } else if (kind === "action" || kind === "general" || kind === "shot") {
      speaker = null;
      lines.push({ kind: "action", text });
    } else {
      speaker = kind === "dialogue" ? speaker : null;
    }
  }
  const counts = new Map<string, number>();
  for (const l of lines) if (l.kind === "speech") counts.set(l.who, (counts.get(l.who) ?? 0) + 1);
  const roles = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([who]) => who);
  if (!roles.length) throw new ScriptError("That file has no dialogue we could read. Add the scene's Final Draft file (.fdx) or a PDF exported from Final Draft.");
  return { title: title || titleFromFileName(fileName), heading, roles, lines };
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** A Final Draft file (.fdx is XML): its paragraphs in order. */
export function parseFdx(xml: string, fileName: string): ParsedScript {
  const body = /<Content\b[^>]*>([\s\S]*?)<\/Content>/i.exec(xml)?.[1];
  if (!body) throw new ScriptError("That doesn't look like a Final Draft file.");
  const paragraphs: { type: string; text: string }[] = [];
  for (const match of body.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/gi)) {
    const type = /\bType="([^"]*)"/i.exec(match[1])?.[1] ?? "General";
    const text = [...match[2].matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/gi)].map((t) => decode(t[1])).join("");
    paragraphs.push({ type, text });
  }
  return fromParagraphs(paragraphs, fileName);
}

/** One line of text on a PDF page: where it starts and ends (points from the left), how high it sits, its type size. */
export type PdfRow = { page: number; y: number; x: number; end: number; text: string; size?: number };

const TIME_OF_DAY = "DAY|NIGHT|MORNING|EVENING|AFTERNOON|DAWN|DUSK|SUNSET|SUNRISE|LATER|CONTINUOUS|SAME TIME|MOMENTS LATER";
/** "INT. HOSPITAL OFFICE — NIGHT — VALE sits…": a scene heading run straight into the first stage direction. */
const HEADING_THEN_ACTION = new RegExp(`^((?:INT|EXT|INT\\.?/EXT|I/E|EST)[.\\s][^a-z]*?\\b(?:${TIME_OF_DAY})\\b)[\\s.,:;—–-]*(.*)$`);
/** "Monsieur Andre (nervous): Madame, these things do happen.": a play-style speech, the speaker's name and a colon first. */
const INLINE_SPEECH = /^([A-Z][A-Za-z'’.-]*(?: [A-Z][A-Za-z'’.-]*){0,3})\s*(?:\([^)]*\))?\s*:\s*(\S.*)$/;
const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "by", "for", "with", "from", "is", "it", "as", "my", "me", "we", "us", "up", "no", "so", "do", "go", "be", "he", "if", "i"]);

/** "THE ER RECORDING" → "The ER Recording": capitals made readable, keeping short ones that aren't words (ER, FBI, CEO). */
export function readableTitle(text: string): string {
  const clean = text.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .split(" ")
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (word.length <= 3 && /^[A-Z]+$/.test(word) && !SMALL_WORDS.has(lower)) return word;
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * A script PDF's lines as paragraphs, whatever program laid it out. A blank
 * line ends a paragraph. Stage directions and scene headings start at the left
 * margin; a paragraph that starts away from it with a short line in capitals is
 * a character speaking (Final Draft indents the name and the dialogue; word
 * processors centre them), and the lines under it are what they say. A
 * stage-play style "Name: line" at the margin is a speech too, when that name
 * speaks more than once. Also finds a title in quotes above the scene.
 */
export function pdfParagraphs(all: PdfRow[]): { paragraphs: { type: string; text: string }[]; title: string | null; titleLine: string | null } {
  // Page numbers, (MORE), (CONT'D) on its own, CONTINUED: page headers. Scene numbers either side of a heading go.
  const rows = all
    .filter((r) => !/^\d+\.?$/.test(r.text) && !/^\((MORE|CONT['’]?D)\)$/i.test(r.text) && !/^\(?CONTINUED\)?:?$/i.test(r.text))
    .map((r) => {
      const numbered = /^(\d+[A-Z]?)\s+(.+?)(?:\s+\1)?$/.exec(r.text);
      return numbered && isHeading(numbered[2]) ? { ...r, text: numbered[2] } : r;
    });
  // The left margin, where stage directions and scene headings start: the first heading's, when stage directions
  // share it, else the leftmost edge two lines share. (A title page's lines can sit further left.)
  const xs = rows.map((r) => r.x);
  const shared = (x: number) => xs.filter((y) => Math.abs(y - x) < 3).length;
  const firstHeading = rows.find((r) => isHeading(r.text));
  const margin = firstHeading && shared(firstHeading.x) >= 3 ? firstHeading.x : Math.min(...xs.filter((x) => shared(x) >= 2));
  const atMargin = (r: PdfRow) => Math.abs(r.x - margin) <= 6;
  // The distance from one line to the next: the smallest one that keeps coming up (a blank line is about twice it,
  // and in a script of one-line paragraphs, blank lines are the commonest gap).
  const gaps = new Map<number, number>();
  rows.slice(1).forEach((r, i) => {
    const gap = rows[i].y - r.y;
    if (r.page === rows[i].page && gap >= 6 && gap <= 40) gaps.set(Math.round(gap), (gaps.get(Math.round(gap)) ?? 0) + 1);
  });
  const total = [...gaps.values()].reduce((a, b) => a + b, 0);
  const spacing = Math.min(...[...gaps.entries()].filter(([, n]) => n >= Math.max(2, total * 0.05)).map(([gap]) => gap), Infinity);
  // Never more than about twice the type size: past that it's a blank line (a script of one-line paragraphs).
  const sizes = rows.flatMap((r) => (r.size ? [r.size] : [])).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)];
  const lineGap = size && (!Number.isFinite(spacing) || spacing > 2 * size) ? 1.2 * size : Number.isFinite(spacing) ? spacing : 12;
  const isCue = (r: PdfRow) =>
    !atMargin(r) && /[A-Z]/.test(r.text) && r.text === r.text.toUpperCase() && r.text.length <= 50 && !TRANSITION.test(r.text) && !/:$/.test(r.text) && !isHeading(r.text);

  const blocks: PdfRow[][] = [];
  for (const row of rows) {
    const block = blocks.at(-1);
    const last = block?.at(-1);
    const sameParagraph =
      block &&
      last &&
      row.page === last.page &&
      last.y - row.y <= lineGap * 1.5 &&
      // No blank line, but plainly a new paragraph: a name under a stage direction, or a stage direction under a speech.
      !(isCue(row) && atMargin(last)) &&
      !(atMargin(row) && !atMargin(block[0]) && isCue(block[0]));
    if (sameParagraph) block.push(row);
    else blocks.push([row]);
  }

  // Play-style speakers: names before a colon that come up more than once.
  const inlineCount = new Map<string, number>();
  for (const block of blocks) {
    const m = atMargin(block[0]) ? INLINE_SPEECH.exec(block[0].text) : null;
    if (m) inlineCount.set(m[1], (inlineCount.get(m[1]) ?? 0) + 1);
  }

  const isSpeech = (block: PdfRow[]) => {
    const inline = atMargin(block[0]) ? INLINE_SPEECH.exec(block[0].text) : null;
    return (inline !== null && (inlineCount.get(inline[1]) ?? 0) >= 2) || (isCue(block[0]) && block.length > 1);
  };
  // Before the first scene heading, with nobody speaking yet: a title page, a writer's notes. Not part of the scene.
  const headingBlock = blocks.findIndex((b) => b.some((r) => isHeading(r.text)));
  const preamble = headingBlock > 0 && !blocks.slice(0, headingBlock).some(isSpeech) ? blocks.slice(0, headingBlock) : [];
  const join = (list: PdfRow[]) => list.map((r) => r.text).join(" ");
  const quoted = (text: string) => /[“"]([^”"]{3,80})[”"]/.exec(text)?.[1] ?? null;
  let title = preamble.map((b) => quoted(join(b))).find(Boolean) ?? null;
  // Otherwise its first line, when that's a title in capitals ("GROVEL").
  const top = preamble[0]?.[0]?.text;
  const titleLine = top && top === top.toUpperCase() && /^[A-Z][A-Z '’&,.!?:-]{1,60}$/.test(top) ? top : null;

  const paragraphs: { type: string; text: string }[] = [];
  let begun = false;
  for (const block of blocks.slice(preamble.length)) {
    const first = block[0];
    if (atMargin(first)) {
      const inline = INLINE_SPEECH.exec(first.text);
      if (inline && (inlineCount.get(inline[1]) ?? 0) >= 2) {
        paragraphs.push({ type: "Character", text: inline[1] });
        // How it's said, in brackets, isn't what's said.
        paragraphs.push({ type: "Dialogue", text: `${inline[2]} ${join(block.slice(1))}`.replace(/\([^)]*\)/g, " ") });
        begun = true;
        continue;
      }
      // Anything above the first scene heading (a title, a writer's note) isn't part of the scene.
      const headingAt = block.findIndex((r) => isHeading(r.text));
      const before = headingAt > 0 ? block.slice(0, headingAt) : headingAt === 0 ? [] : block;
      if (headingAt >= 0 && !begun) {
        title ??= quoted(join(before));
      } else if (before.length) {
        paragraphs.push({ type: "Action", text: join(before) });
      }
      if (headingAt >= 0) {
        const text = join(block.slice(headingAt));
        const split = HEADING_THEN_ACTION.exec(text);
        if (split) {
          paragraphs.push({ type: "Scene Heading", text: split[1] });
          if (split[2]) paragraphs.push({ type: "Action", text: split[2] });
        } else {
          paragraphs.push({ type: text === text.toUpperCase() ? "Scene Heading" : "Action", text });
        }
      }
      begun ||= headingAt >= 0 || before.length > 0;
    } else if (isCue(first)) {
      paragraphs.push({ type: "Character", text: first.text });
      let open = false;
      for (const row of block.slice(1)) {
        const parenthetical: boolean = open || row.text.startsWith("(");
        open = parenthetical && !row.text.includes(")");
        const type = parenthetical ? "Parenthetical" : "Dialogue";
        const previous = paragraphs.at(-1)!;
        if (previous.type === type) previous.text += ` ${row.text}`;
        else paragraphs.push({ type, text: row.text });
      }
      begun = true;
    } else {
      // Away from the margin but not a name: a transition, or a centred stage direction.
      paragraphs.push({ type: "Action", text: join(block) });
    }
  }
  return { paragraphs, title, titleLine };
}

/** A script PDF, as Final Draft, other screenwriting apps or a word processor lays it out (see pdfParagraphs). */
export async function parsePdf(bytes: Uint8Array, fileName: string): Promise<ParsedScript> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    // A copy: the PDF reader takes over the memory it's given, and the file itself is still to be stored.
    pdf = await getDocumentProxy(bytes.slice());
  } catch {
    throw new ScriptError("That PDF couldn't be read.");
  }
  const rows: PdfRow[] = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 40); p++) {
    const page = await pdf.getPage(p).catch(() => null);
    const content = page && (await page.getTextContent().catch(() => null));
    if (!content) throw new ScriptError("That PDF couldn't be read.");
    const byY = new Map<number, { x: number; w: number; h: number; s: string }[]>();
    for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (!item.str || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      const list = byY.get(y) ?? [];
      list.push({ x: item.transform[4], w: item.width ?? 0, h: item.height ?? 0, s: item.str });
      byY.set(y, list);
    }
    for (const [y, all] of byY) {
      all.sort((a, b) => a.x - b.x);
      // A shooting script's scene numbers either side of a heading ("12  INT. KITCHEN - DAY  12") aren't part of it.
      const number = (s: string) => /^\d+[A-Z]?\.?$/.test(s.trim());
      const rest = all.filter((it) => it.s.trim());
      const numbered = rest.length > 1 && number(rest[0].s) && isHeading(rest.slice(1).map((it) => it.s).join(" "));
      const items = numbered ? rest.slice(1, rest.length > 2 && number(rest.at(-1)!.s) ? -1 : undefined) : all;
      let text = "";
      let end = -Infinity;
      for (const it of items) {
        text += (text && it.x > end + 1 && !text.endsWith(" ") && !it.s.startsWith(" ") ? " " : "") + it.s;
        end = it.x + it.w;
      }
      if (text.trim()) rows.push({ page: p, y, x: items[0].x, end, text: text.trim(), size: Math.max(...items.map((it) => it.h)) || undefined });
    }
  }
  rows.sort((a, b) => a.page - b.page || b.y - a.y);
  if (!rows.length) throw new ScriptError("That PDF has no text in it (a scan, maybe). Add the Final Draft file instead.");
  const { paragraphs, title, titleLine } = pdfParagraphs(rows);
  // The title: the file's name, unless that was typed without spaces ("TheERRecording-1.5pg…") and the script
  // has one of its own (in quotes above the scene, or a first line in capitals).
  const named = /\s/.test(fileName.replace(/\.(fdx|pdf)$/i, ""));
  const own = title ?? titleLine;
  return fromParagraphs(paragraphs, fileName, !named && own ? readableTitle(own) : null);
}

export async function parseScript(bytes: Uint8Array, fileName: string): Promise<ParsedScript> {
  if (/\.fdx$/i.test(fileName)) return parseFdx(new TextDecoder().decode(bytes), fileName);
  if (/\.pdf$/i.test(fileName)) return parsePdf(bytes, fileName);
  throw new ScriptError("Add the scene's Final Draft file (.fdx) or a PDF of it.");
}

export type ScriptSummary = { id: number; title: string; roles: string[]; speeches: number; projectId: number | null; addedBy: string | null; createdAt: string };

const summary = (r: typeof scripts.$inferSelect): ScriptSummary => ({
  id: r.id,
  title: r.title,
  roles: r.roles,
  speeches: r.lines.filter((l) => l.kind === "speech").length,
  projectId: r.projectId,
  addedBy: r.addedBy,
  createdAt: r.createdAt.toISOString(),
});

/** The account's scripts, newest first. */
export async function listScripts(db: Db, accountId: number): Promise<ScriptSummary[]> {
  const rows = await db.select().from(scripts).where(eq(scripts.accountId, accountId)).orderBy(desc(scripts.id));
  return rows.map(summary);
}

/** The script that came in with (or was added to) this scene, newest first, if any. */
export async function sceneScript(db: Db, projectId: number): Promise<ScriptSummary | null> {
  const [row] = await db.select().from(scripts).where(eq(scripts.projectId, projectId)).orderBy(desc(scripts.id)).limit(1);
  return row ? summary(row) : null;
}

/** Stores a script added on its own (B2, under the account's Scripts/), tied to a scene when it's added on one. */
export async function addScript(
  db: Db,
  upload: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>,
  file: { name: string; bytes: Uint8Array },
  parsed: ParsedScript,
  owner: { accountId: number; projectId: number | null; by: string },
): Promise<ScriptSummary> {
  const safe = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 120);
  const key = `Scripts/a${owner.accountId}/${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}/${safe}`;
  await upload(key, file.bytes, /\.pdf$/i.test(file.name) ? "application/pdf" : "application/xml");
  const [row] = await db
    .insert(scripts)
    .values({ accountId: owner.accountId, projectId: owner.projectId, title: parsed.title, roles: parsed.roles, lines: parsed.lines, heading: parsed.heading, fileName: file.name, storageKey: key, sizeBytes: file.bytes.byteLength, addedBy: owner.by })
    .returning();
  return summary(row);
}

/** A file in a scene's folder that could be its script: a Final Draft file, or a PDF, small enough. */
export const mightBeScript = (path: string, size: number) => /\.(fdx|pdf)$/i.test(path) && size > 0 && size <= MAX_SCRIPT_BYTES;

/**
 * Reads a script that came in with the scene's folder, once it's safely uploaded (Guy: drop the whole folder, the
 * script included, and nothing else to do). A PDF that isn't a script (a call sheet, a release) is left alone.
 * Returns the script, or null.
 */
export async function readSceneScript(
  db: Db,
  read: (key: string, maxBytes: number) => Promise<Uint8Array | null>,
  file: { projectId: number; path: string; storageKey: string; sizeBytes: number; uploadedBy: string | null },
): Promise<ScriptSummary | null> {
  if (!mightBeScript(file.path, file.sizeBytes)) return null;
  const [known] = await db.select({ id: scripts.id }).from(scripts).where(eq(scripts.storageKey, file.storageKey));
  if (known) return null;
  const bytes = await read(file.storageKey, MAX_SCRIPT_BYTES);
  if (!bytes) return null;
  let parsed: ParsedScript;
  try {
    parsed = await parseScript(bytes, file.path.split("/").at(-1)!);
  } catch (error) {
    if (error instanceof ScriptError) return null;
    throw error;
  }
  // A scene needs two people talking; anything less isn't this scene's script.
  if (parsed.roles.length < 2 || parsed.lines.filter((l) => l.kind === "speech").length < 2) return null;
  const [project] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.id, file.projectId));
  if (!project) return null;
  const [row] = await db
    .insert(scripts)
    .values({
      accountId: project.accountId,
      projectId: file.projectId,
      title: parsed.title,
      roles: parsed.roles,
      lines: parsed.lines,
      heading: parsed.heading,
      fileName: file.path.split("/").at(-1)!,
      storageKey: file.storageKey,
      sizeBytes: file.sizeBytes,
      addedBy: file.uploadedBy,
    })
    .onConflictDoNothing()
    .returning();
  return row ? summary(row) : null;
}

/** The account's script with this id, or null (another account's script never shows). */
export async function ownedScript(db: Db, accountId: number, id: number) {
  const [row] = await db.select().from(scripts).where(and(eq(scripts.id, id), eq(scripts.accountId, accountId)));
  return row ?? null;
}
