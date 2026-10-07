// Loupe's brain (Guy, Oct 6): Claude reads a director's note on the first
// assembly ("she's too composed here, find the take where she cracks", "warmer
// and moodier", "let it breathe"), works out what to change, and answers in
// Loupe's voice. The worker then makes the assembly again with the change.
// Claude Opus 5.5, on fal (the same account as everything else here); only
// text goes out: the scene's lines, the takes and what's known about them.

import type { FalClient } from "../ai/fal.js";
import type { Direction } from "./direction.js";
import { sameLine } from "./engine.js";

export const BRAIN_ENDPOINT = "openrouter/router";
export const BRAIN_MODEL = "anthropic/claude-opus-5.5";

/** What Loupe knows about the cut the note is about (from the last assembly's result). */
export type CutContext = {
  title: string;
  tone?: string;
  place?: string;
  seconds: number;
  client: string;
  partner: string;
  /** In the order the cut plays them. */
  shots: { take: string; who: string; framing: string; kind: string; line: string; speaker: string; why: string }[];
  takes: { take: string; setup: { who: string; framing: string } | null; used: boolean }[];
  /** How each performance plays, from watching it (performance.ts), when known. */
  performances?: Record<string, string>;
  lines: { who: string; text: string }[];
  look?: string | null;
};

export type Reading = { reply: string; remake: boolean; direction: Direction };

export function brainPrompt(note: string, cut: CutContext, d: Direction): string {
  const shots = cut.shots
    .filter((s) => s.kind !== "establishing")
    .map((s) => `- ${s.take} (${s.kind === "reaction" ? `${s.who} reacting` : `${s.who}, ${s.framing}`}) over ${s.speaker}: "${s.line}". Why: ${s.why}`)
    .join("\n");
  const takes = cut.takes
    .map((t) => `- ${t.take}: ${t.setup ? `${t.setup.who}, ${t.setup.framing}` : "not usable (a false start or an insert)"}${t.used ? ", in the cut" : ""}${cut.performances?.[t.take] ? `. Performance: ${cut.performances[t.take]}` : ""}`)
    .join("\n");
  const now = {
    look: d.look ?? null,
    music: d.music ?? null,
    picks: d.picks ?? [],
    reactions: d.reactions ?? "normal",
    pace: d.pace ?? "normal",
    clean: d.clean ?? "isolate",
  };
  return [
    `A director is giving a note on the first assembly of a dialogue scene: "${cut.title}"${cut.tone ? `, played as a ${cut.tone}` : ""}${cut.place ? `, in a ${cut.place}` : ""}. It runs ${Math.round(cut.seconds)} s. ${cut.client} and ${cut.partner}.`,
    "",
    "The scene's lines, in order:",
    cut.lines.map((l, i) => `${i + 1}. ${l.who}: ${l.text}`).join("\n"),
    "",
    "The cut, shot by shot:",
    shots,
    "",
    "Every take that was shot:",
    takes,
    "",
    "What's set now:",
    JSON.stringify(now),
    "",
    `The note: "${note}"`,
    "",
    "What you can change (anything else, you can't yet):",
    '- "look": the colour grade, as a note for the colourist in plain words (like "warmer, deeper shadows, skin natural"). Null takes the grade off. A new look note replaces the old one, so carry over what should stay.',
    '- "music": a note on the score (like "sadder, sparser, no piano"). Null goes back to the score the scene suggests.',
    '- "picks": a take for a line: {"line": the line\'s exact text from the list above, "take": a take that has that actor on camera}. Picks add to the ones set; "unpick": lines to give back to the automatic choice.',
    '- "reactions": "more", "fewer" or "normal": how often the other actor is seen listening.',
    '- "pace": "tighter", "looser" or "normal": the pauses where the picture cuts (pauses inside one continuous take stay as performed).',
    '- "clean": "isolate" (the usual: voice isolation that strips noise, hum and music from every line) or "standard" (filters only, the voice exactly as recorded, for when isolation sounds processed).',
    "",
    "You're Loupe, the director's invisible assistant editor. Do what the note asks with those, as a good editor would; when it names a performance, choose from the takes' performance notes. If the note asks for something you can't do, say so plainly and suggest the nearest thing you can. If it's a question, answer it and change nothing.",
    'Answer with JSON only: {"set": only what changes, like {"look": "..."} or {"picks": [...], "unpick": [...]}; "remake": true when anything changed, else false; "reply": one or two short, warm sentences in Loupe\'s voice saying what you did and why, in plain words a director would use (never "AI", no jargon), giving the credit away ("Your call.")}',
  ].join("\n");
}

/** The answer applied to the direction: only known settings, takes and lines that exist, anything else ignored. */
export function applyReading(output: string, cut: CutContext, d: Direction): { reply: string; remake: boolean; direction: Direction } | null {
  let parsed: { set?: Record<string, unknown>; remake?: unknown; reply?: unknown };
  try {
    parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim().slice(0, 400) : "";
  if (!reply) return null;
  const set = parsed.set && typeof parsed.set === "object" ? parsed.set : {};
  const next: Direction = { ...d };
  let changed = false;
  const change = <K extends keyof Direction>(key: K, value: Direction[K]) => {
    if (JSON.stringify(next[key] ?? null) !== JSON.stringify(value ?? null)) changed = true;
    next[key] = value;
  };
  const words = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  if ("look" in set) change("look", words(set.look, 300));
  if ("music" in set) change("music", words(set.music, 300));
  if (set.reactions === "more" || set.reactions === "fewer") change("reactions", set.reactions);
  else if (set.reactions === "normal") change("reactions", null);
  if (set.pace === "tighter" || set.pace === "looser") change("pace", set.pace);
  else if (set.pace === "normal") change("pace", null);
  // Isolation is the usual; only "standard" (the filters alone) is kept.
  if (set.clean === "isolate" || set.clean === "standard") change("clean", set.clean === "standard" ? "standard" : null);

  const onCamera = new Map(cut.takes.flatMap((t) => (t.setup ? [[t.take, t.setup.who] as const] : [])));
  const lineOf = (text: unknown) => (typeof text === "string" ? cut.lines.find((l) => sameLine(l.text, text)) : undefined);
  let picks = [...(d.picks ?? [])];
  if (Array.isArray(set.unpick)) {
    for (const text of set.unpick) {
      const line = lineOf(text);
      if (line) picks = picks.filter((p) => !sameLine(p.line, line.text));
    }
  }
  if (Array.isArray(set.picks)) {
    for (const p of set.picks) {
      const x = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      const line = lineOf(x.line);
      const take = typeof x.take === "string" ? x.take.trim() : "";
      // The line's speaker on camera, or the other actor for a reaction-led line: either way, a usable take.
      if (!line || !onCamera.has(take)) continue;
      picks = [...picks.filter((q) => !sameLine(q.line, line.text)), { line: line.text, take }];
    }
  }
  if (JSON.stringify(picks) !== JSON.stringify(d.picks ?? [])) {
    changed = true;
    next.picks = picks.length ? picks : undefined;
  }
  return { reply, remake: changed && parsed.remake !== false, direction: next };
}

/** Claude reads the note; null when its answer can't be used (the run carries on without it). */
export async function readNote(fal: FalClient, note: string, cut: CutContext, d: Direction, signal?: AbortSignal): Promise<Reading | null> {
  const answer = await fal.run<{ output?: string }>(
    BRAIN_ENDPOINT,
    {
      model: BRAIN_MODEL,
      system_prompt: "You are Loupe, an assistant editor working for a film director. You answer with JSON only.",
      prompt: brainPrompt(note, cut, d),
      reasoning: true,
      max_tokens: 6000,
    },
    { signal, timeoutMs: 5 * 60_000 },
  );
  return applyReading(answer.output ?? "", cut, d);
}
