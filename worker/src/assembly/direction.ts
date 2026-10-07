// A director's notes to Loupe (Guy, Oct 6), kept with each version of a cut
// (loupe_cuts.direction) and carried from one to the next: the look,
// a take picked for a line, more or fewer reactions, tighter or looser cuts,
// how the dialogue is cleaned. The app adds a note; the worker reads it
// (loupe.ts), answers, and makes the assembly again with it.

import type { Steer } from "./engine.js";

export type Note = { note: string; reply: string | null; at: string };

export type Direction = {
  /** Every note given, oldest first, with Loupe's answer (null until the worker has read it). */
  notes?: Note[];
  /** The colour, in the director's words (grade.ts). */
  look?: string | null;
  /** A note on the score, in the director's words ("sadder, no piano"). */
  music?: string | null;
  picks?: { line: string; take: string }[];
  reactions?: "more" | "fewer" | null;
  pace?: "tighter" | "looser" | null;
  /** How the dialogue is cleaned: ElevenLabs' voice isolation after the filters (isolate.ts) unless "standard", the filters alone. */
  clean?: "isolate" | "standard" | null;
  /**
   * The extras, off unless asked for (Guy, Oct 7: "off by default, one click to add"): an AI establishing shot of the
   * outside (~$2.50, made once per scene), the room's ambience, and a score.
   */
  extras?: Extras;
};

export type Extras = { establishing?: boolean; ambience?: boolean; score?: boolean };

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const oneOf = <T extends string>(v: unknown, options: readonly T[]): T | null => (options.includes(v as T) ? (v as T) : null);

/** Whatever is stored, as a direction: anything unexpected left out. */
export function parseDirection(raw: unknown): Direction {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const notes = Array.isArray(o.notes)
    ? o.notes.flatMap((n) => {
        const x = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
        const note = text(x.note, 600);
        return note ? [{ note, reply: text(x.reply, 400), at: text(x.at, 40) ?? "" }] : [];
      })
    : [];
  const picks = Array.isArray(o.picks)
    ? o.picks.flatMap((p) => {
        const x = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
        const line = text(x.line, 400);
        const take = text(x.take, 80);
        return line && take ? [{ line, take }] : [];
      })
    : [];
  return {
    ...(notes.length ? { notes: notes.slice(-30) } : {}),
    look: text(o.look, 300),
    music: text(o.music, 300),
    ...(picks.length ? { picks: picks.slice(0, 200) } : {}),
    reactions: oneOf(o.reactions, ["more", "fewer"] as const),
    pace: oneOf(o.pace, ["tighter", "looser"] as const),
    clean: oneOf(o.clean, ["isolate", "standard"] as const),
    ...(extrasOf(o.extras) ? { extras: extrasOf(o.extras)! } : {}),
  };
}

function extrasOf(raw: unknown): Extras | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Extras = {};
  for (const k of ["establishing", "ambience", "score"] as const) if (o[k] === true) out[k] = true;
  return Object.keys(out).length ? out : null;
}

/** The note still waiting for Loupe's answer, if the newest one is. */
export const pendingNote = (d: Direction): Note | null => {
  const last = d.notes?.at(-1);
  return last && last.reply === null ? last : null;
};

/** What the engine takes from the direction. */
export const steerOf = (d: Direction, performance?: Steer["performance"]): Steer => ({
  picks: d.picks,
  reactions: d.reactions ?? undefined,
  pace: d.pace ?? undefined,
  performance,
});
