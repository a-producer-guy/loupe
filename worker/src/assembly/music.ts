// The first assembly's ambience and score (Guy chose AI-generated, Oct 1):
// ElevenLabs on fal, the same account as the social cuts. A language model
// reads the scene first and writes the prompts (and, for the picture, the
// establishing shot, the lines where the scene peaks, and its tone: a comedy
// gets a handheld camera); only text goes out here, never the client's sound
// or picture.

import { writeFile } from "node:fs/promises";
import type { FalClient } from "../ai/fal.js";

export const TEXT_ENDPOINT = "openrouter/router";
export const TEXT_MODEL = "anthropic/claude-haiku-4.5";
export const AMBIENCE_ENDPOINT = "fal-ai/elevenlabs/sound-effects/v2";
// Music v2.5, ElevenLabs' newest (Guy, Oct 6); fal retires the old "fal-ai/elevenlabs/music" on Dec 17, 2026.
export const MUSIC_ENDPOINT = "elevenlabs/music/v2.5";

export const TONES = ["comedy", "dramedy", "drama", "thriller"] as const;
export type Tone = (typeof TONES)[number];

export type SoundBrief = {
  place: string;
  ambience: string;
  score: string;
  /** The establishing shot: a still of the place's exterior, and how it moves. Null: no establishing shot. */
  exterior: { image: string; motion: string } | null;
  /** The cut's lines (0-based) where the scene peaks: they get a slow push-in. */
  peaks: number[];
  /** The line (0-based) with the scene's biggest laugh, or null: in a comedy it gets a quick zoom. */
  laugh: number | null;
  /** What kind of scene it is; a comedy or dramedy is shot handheld (Guy, Oct 2). */
  tone: Tone;
};

/** A comedy (or a dramedy) gets a handheld camera; the rest stay steady, with slow push-ins. */
export const cameraFor = (tone: Tone): "handheld" | "steady" => (tone === "comedy" || tone === "dramedy" ? "handheld" : "steady");

export const FALLBACK_BRIEF: SoundBrief = {
  place: "room",
  ambience: "Quiet interior room tone: soft steady air conditioning, very distant muffled city traffic through closed windows. No voices, no music.",
  score:
    "Instrumental underscore for a tense, intimate two-person dialogue scene. Sparse felt piano, soft sustained strings and a subtle low pulse; quietly builds and ends on a held, unresolved note. Sparse so dialogue sits on top. No vocals, no big drums.",
  exterior: null,
  peaks: [],
  laugh: null,
  tone: "drama",
};

/** The scene for the language model: its stage directions, and the cut's lines, numbered. */
export function briefPrompt(heading: string, lines: { who: string; text: string; actionBefore?: string }[]): string {
  const text = lines
    .map((l, i) => `${l.actionBefore ? `(${l.actionBefore})\n` : ""}${i + 1}. ${l.who}: ${l.text}`)
    .join("\n")
    .slice(0, 8000);
  return [
    "This is a short dramatic scene from an actor's reel, as its first assembly cuts it. Brief the sound and the picture for it.",
    heading ? `Scene heading: ${heading}` : "There's no scene heading: work out the place from the dialogue.",
    "",
    text,
    "",
    "Answer with JSON only:",
    '{"place": a few words for where it happens (like "law office"),',
    '"ambience": a 1-2 sentence prompt for a sound-effects model: the room\'s steady background sound only, ending with "No voices, no music.",',
    '"score": a 2-3 sentence prompt for a music model: an instrumental underscore that fits the scene\'s mood and how it ends, sparse so dialogue sits on top, ending with "No vocals.",',
    '"exterior": {"image": a prompt for a photographic still of the EXTERIOR of the building or place where the scene happens, as a film\'s establishing shot: a time of day and weather that fit the scene, cinematic 35mm look, muted natural colour, no readable signs or text, no people in focus,',
    '"motion": one sentence for a video model bringing that still to life for 5 seconds: a single slow camera move (push in, drift or tilt) and gentle ambient life (traffic, wind, lights in windows), no cuts, no people walking toward the camera},',
    '"tone": the kind of scene: "comedy" (it plays for laughs, including banter and dark comedy), "dramedy" (real feeling with laughs in it), "drama" or "thriller",',
    '"peaks": the numbers of the 2 or 3 lines where the tension or the feeling peaks (an accusation, a reveal, a threat, the turn of the scene), most important first,',
    '"laugh": the number of the line that gets the scene\'s biggest laugh (a punchline), or null if nothing in it is played for a laugh}',
  ].join("\n");
}

export function parseBrief(output: string, lineCount = Infinity): SoundBrief | null {
  try {
    const parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as Partial<SoundBrief> & { exterior?: { image?: unknown; motion?: unknown } };
    const ok = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 2 && v.length <= max;
    if (!ok(parsed.place, 60) || !ok(parsed.ambience, 600) || !ok(parsed.score, 900)) return null;
    const exterior = parsed.exterior && ok(parsed.exterior.image, 1200) && ok(parsed.exterior.motion, 600) ? { image: parsed.exterior.image.trim(), motion: parsed.exterior.motion.trim() } : null;
    const peaks = Array.isArray(parsed.peaks)
      ? [...new Set(parsed.peaks.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= lineCount).map((n) => n - 1))].slice(0, 3)
      : [];
    const tone = TONES.find((t) => t === String(parsed.tone ?? "").trim().toLowerCase()) ?? "drama";
    const laugh = Number(parsed.laugh);
    return {
      place: parsed.place.trim(),
      ambience: parsed.ambience.trim(),
      score: parsed.score.trim(),
      exterior,
      peaks,
      laugh: parsed.laugh !== null && Number.isInteger(laugh) && laugh >= 1 && laugh <= lineCount ? laugh - 1 : null,
      tone,
    };
  } catch {
    return null;
  }
}

export async function sceneBrief(fal: FalClient, heading: string, lines: { who: string; text: string; actionBefore?: string }[], signal?: AbortSignal): Promise<SoundBrief> {
  const answer = await fal.run<{ output?: string }>(
    TEXT_ENDPOINT,
    {
      model: TEXT_MODEL,
      system_prompt: "You are a film editor, sound designer and composer. You answer with JSON only.",
      prompt: briefPrompt(heading, lines),
      temperature: 0.4,
      max_tokens: 900,
    },
    { signal },
  );
  return parseBrief(answer.output ?? "", lines.length) ?? FALLBACK_BRIEF;
}

async function save(url: string, file: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`fal's file wouldn't download (${response.status}).`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

/** A seamless 22-second loop of the room's background. */
export async function makeAmbience(fal: FalClient, brief: SoundBrief, file: string, signal?: AbortSignal) {
  const result = await fal.run<{ audio?: { url: string } }>(
    AMBIENCE_ENDPOINT,
    { text: brief.ambience, duration_seconds: 22, loop: true, prompt_influence: 0.45, output_format: "mp3_44100_192" },
    { signal },
  );
  if (!result.audio?.url) throw new Error("fal sent no ambience.");
  await save(result.audio.url, file, signal);
}

/** An instrumental score the cut's length plus a tail. */
export async function makeScore(fal: FalClient, brief: SoundBrief, seconds: number, file: string, signal?: AbortSignal) {
  const result = await fal.run<{ audio?: { url: string } }>(
    MUSIC_ENDPOINT,
    // A clear last chord, for the mix to land on the scene's last line (finalHit, in finish.ts).
    {
      prompt: `${brief.score} It ends on one clear, resolved final chord that rings out for its last few seconds.`,
      // Longer than the scene: the service often ends a piece early, and the mix lines up its real ending.
      music_length_ms: Math.min(600_000, Math.max(10_000, Math.round(seconds * 1000) + 15_000)),
      force_instrumental: true,
      output_format: "mp3_48000_192",
    },
    { signal, timeoutMs: 15 * 60_000 },
  );
  if (!result.audio?.url) throw new Error("fal sent no score.");
  await save(result.audio.url, file, signal);
}
