// Voice isolation (Guy, Oct 6): ElevenLabs' Audio Isolation (on fal) strips
// noise, hum and music from a take's cleaned dialogue, for a scene shot
// somewhere loud, or when a director asks Loupe for cleaner dialogue. It runs
// after the room tone is built (from the takes' own pauses, so the room is
// still there to lay under the lines), and the result is lined up with the
// original to the sample and brought back to the dialogue's level, so the
// cut, the timeline and the mix don't move. If fal can't, the take keeps its
// filtered dialogue.
// The take's sound goes to fal for this (Guy said yes, Oct 6).

import { rm, writeFile } from "node:fs/promises";
import { dataUri, type FalClient } from "../ai/fal.js";
import { ffmpegPipe, readAudio, SR, writeAudio } from "./audio.js";
import { hold, linesOf } from "./dialogue.js";
import type { Take } from "./engine.js";
import type { Unit } from "./text.js";

export const ISOLATION_ENDPOINT = "fal-ai/elevenlabs/audio-isolation";

/**
 * How far `moved` lags `original` (in samples, negative: it's early), from
 * their loudness envelopes at 1 kHz, within ±0.3 s. Encoders add a little
 * silence at the start; this finds it.
 */
export function lagOf(original: Float32Array, moved: Float32Array, rate = SR): number {
  const step = Math.max(1, Math.round(rate / 1000));
  const env = (x: Float32Array) => {
    const out = new Float32Array(Math.floor(x.length / step));
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += Math.abs(x[i * step + j]);
      out[i] = sum / step;
    }
    return out;
  };
  const a = env(original);
  const b = env(moved);
  const span = Math.min(a.length, b.length);
  const max = 300;
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = -max; lag <= max; lag++) {
    let score = 0;
    for (let i = Math.max(0, -lag); i < span && i + lag < b.length; i++) score += a[i] * b[i + lag];
    if (score > bestScore) [bestScore, best] = [score, lag];
  }
  // Then to the sample, around that.
  const lo = best * step - step;
  const hi = best * step + step;
  let sample = best * step;
  bestScore = -Infinity;
  const stride = Math.max(1, Math.floor(original.length / 200_000));
  for (let lag = lo; lag <= hi; lag++) {
    let score = 0;
    for (let i = Math.max(0, -lag); i < original.length && i + lag < moved.length; i += stride) score += original[i] * moved[i + lag];
    if (score > bestScore) [bestScore, sample] = [score, lag];
  }
  return sample;
}

/** `moved` shifted back by `lag` samples, the length of `length`. */
export function realign(moved: Float32Array, lag: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = i + lag;
    if (j >= 0 && j < moved.length) out[i] = moved[j];
  }
  return out;
}

/** A take's cleaned dialogue (`file`, rewritten in place) with the voice isolated. Throws if fal can't. */
export async function isolateVoice(fal: FalClient, ffmpeg: string, units: Unit[], take: Take, file: string, signal?: AbortSignal) {
  const [original] = await readAudio(ffmpeg, file, 1, SR, signal);
  const flac = await ffmpegPipe(ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-ac", "1", "-c:a", "flac", "-f", "flac", "-"], undefined, signal);
  const result = await fal.run<{ audio?: { url: string } }>(ISOLATION_ENDPOINT, { audio_url: dataUri(flac, "audio/flac") }, { signal, timeoutMs: 10 * 60_000 });
  if (!result.audio?.url) throw new Error("fal sent no isolated voice.");
  const response = await fetch(result.audio.url, { signal });
  if (!response.ok) throw new Error(`fal's isolated voice wouldn't download (${response.status}).`);
  const back = `${file}.isolated`;
  await writeFile(back, Buffer.from(await response.arrayBuffer()));
  const [isolated] = await readAudio(ffmpeg, back, 1, SR, signal);
  const aligned = realign(isolated, lagOf(original, isolated), original.length);
  const { speech, own } = linesOf(units, take);
  await writeAudio(ffmpeg, file, [await hold(ffmpeg, aligned, own.length ? own : speech, signal)], SR, "pcm_s24le", signal);
  await rm(back, { force: true });
}
