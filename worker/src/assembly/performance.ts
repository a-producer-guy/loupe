// Judging the acting (Guy, Oct 6): Gemini watches and listens to every take
// of each setup side by side (fal's video endpoint, the same account) and
// says how each performance plays: a score against the setup's other takes and
// one line on what stands out ("rawer; her voice breaks on the last line").
// The score leans the engine's take choice a little (never past the script,
// the framing or the no-jump-cut rules); the line goes in the shot's reason
// and gives Loupe something to go on for notes like "find the take where she
// cracks". The takes' previews go to fal for this, small (Guy said yes, Oct 6).

import { dataUri, type FalClient } from "../ai/fal.js";
import { ffmpegPipe } from "./audio.js";

export const PERFORMANCE_ENDPOINT = "openrouter/router/video";
export const PERFORMANCE_MODEL = "google/gemini-3.8-flash";

export type Performance = { bonus: number; note: string };
export type SetupTakes = { who: string; framing: string; lines: string[]; takes: { take: string; video: string; from: number; to: number }[] };

/** A take's scene, small enough to send: 480 wide, 12 frames a second, mono sound. */
async function smallClip(ffmpeg: string, video: string, from: number, to: number, signal?: AbortSignal): Promise<Buffer> {
  const start = Math.max(0, from - 1);
  const length = Math.min(240, Math.max(2, to - from + 2));
  return ffmpegPipe(
    ffmpeg,
    ["-v", "error", "-nostdin", "-ss", start.toFixed(2), "-t", length.toFixed(2), "-i", video, "-vf", "scale=480:-2,fps=12", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-c:a", "aac", "-ac", "1", "-b:a", "64k", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "-"],
    undefined,
    signal,
  );
}

export function performancePrompt(s: SetupTakes): string {
  return [
    `These ${s.takes.length} videos are takes of the same shot in a dialogue scene: ${s.who}, ${s.framing}. In this order: ${s.takes.map((t) => t.take).join(", ")}.`,
    `${s.who}'s lines in the scene:`,
    s.lines.map((l) => `- ${l}`).join("\n"),
    "",
    "Watch and listen to each take as a casting director and a film editor would. Judge the performance only (not the camera, focus or sound quality): is it truthful and specific, does the feeling land, does it build, are the lines clear, any flubs, stumbles or a broken moment that an editor would have to cut around.",
    "Compare the takes with each other. For each one give:",
    '- "score": 1 to 10 against the other takes here,',
    '- "note": one short line a director would find useful, naming what stands out and where (like "rawer; her voice breaks on the last line", "steady but flat until the end", "stumbles on \'drawer\'").',
    `Answer with JSON only, one entry per take, like {"${s.takes[0].take}": {"score": 7, "note": "..."}}.`,
  ].join("\n");
}

/** Scores as a nudge to the engine: the setup's average is 0, each point ±0.03, at most ±0.15. */
export function parsePerformances(output: string, takes: string[]): Record<string, Performance> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const read = takes.flatMap((t) => {
    const x = (parsed[t] && typeof parsed[t] === "object" ? parsed[t] : {}) as Record<string, unknown>;
    const score = typeof x.score === "number" && Number.isFinite(x.score) ? Math.min(10, Math.max(1, x.score)) : null;
    const note = typeof x.note === "string" ? x.note.trim().slice(0, 200) : "";
    return score !== null ? [{ take: t, score, note }] : [];
  });
  if (read.length < 2) return null;
  const mean = read.reduce((a, r) => a + r.score, 0) / read.length;
  return Object.fromEntries(
    read.map((r) => [r.take, { bonus: Math.round(Math.min(0.15, Math.max(-0.15, (r.score - mean) * 0.03)) * 1000) / 1000, note: r.note ? `on watching: ${r.note}` : "" }]),
  );
}

/** Every setup with two takes or more, judged; a setup Gemini can't judge is left to the other clues. */
export async function judgePerformances(opts: {
  fal: FalClient;
  ffmpeg: string;
  setups: SetupTakes[];
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<Record<string, Performance>> {
  const out: Record<string, Performance> = {};
  for (const s of opts.setups.filter((x) => x.takes.length >= 2)) {
    try {
      const clips = await Promise.all(
        s.takes.map((t) => smallClip(opts.ffmpeg, t.video, t.from, t.to, opts.signal)),
      );
      const answer = await opts.fal.run<{ output?: string }>(
        PERFORMANCE_ENDPOINT,
        {
          model: PERFORMANCE_MODEL,
          system_prompt: "You judge screen performances for a film editor. You answer with JSON only.",
          prompt: performancePrompt(s),
          video_urls: clips.map((c) => dataUri(c, "video/mp4")),
          temperature: 0.2,
          max_tokens: 3000,
        },
        { signal: opts.signal, timeoutMs: 10 * 60_000 },
      );
      const judged = parsePerformances(answer.output ?? "", s.takes.map((t) => t.take));
      if (judged) Object.assign(out, judged);
      else opts.log?.(`Performances of ${s.who} ${s.framing}: no usable answer.`);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      opts.log?.(`Performances of ${s.who} ${s.framing}: not judged (${(error as Error).message}).`);
    }
  }
  return out;
}
