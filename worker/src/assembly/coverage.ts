// Who is on camera in each take, and how close: worked out from the takes, so
// nobody has to label coverage (tested on the three pilot scenes, 30 of 30
// takes right). Two clues:
//
// - Sound: the mic follows the actor on camera, so their lines are clearly
//   louder in that take (5 to 20 dB). Lines that are loud in the same takes
//   belong to the same actor, which also tells who says what when there's no
//   script.
// - Picture: the vision model says which actor each take is on (vision.ts);
//   within one actor's takes, where the frames change most is where the
//   medium shot became the close-up (Reelarc shoots each actor medium first,
//   then close).

import { fft, ffmpegPipe, frameLevels, hanning, percentile } from "./audio.js";
import type { Framing, Take } from "./engine.js";
import { isFound, median, type Unit } from "./text.js";

/** How loud a line is: the loud end (80th percentile) of its 100 ms frames, in dB. */
export function lineLevel(audio: Float32Array, rate: number, start: number, end: number): number | null {
  if (end - start < 0.3) return null;
  const part = audio.subarray(Math.floor(start * rate), Math.floor(end * rate));
  const levels = frameLevels(part, Math.round(rate / 10));
  return levels.length ? percentile(levels, 80) : null;
}

/**
 * How a stretch of speech sounds to the mic: how loud (the loud end of its
 * 50 ms frames, dB) and how bright (its 2-6 kHz against its 150-1000 Hz,
 * dB). Close to the boom a voice is loud and bright; across the room, quieter
 * and duller.
 */
export function speechSound(audio: Float32Array, rate: number, start: number, end: number): { level: number; bright: number } | null {
  const part = audio.subarray(Math.max(0, Math.floor(start * rate)), Math.floor(end * rate));
  const n = 1024;
  if (part.length < n) return null;
  const levels = frameLevels(part, Math.round(rate / 20));
  if (!levels.length) return null;
  const window = hanning(n);
  const frames: { level: number; low: number; high: number }[] = [];
  for (let at = 0; at + n <= part.length; at += n / 2) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let power = 0;
    for (let k = 0; k < n; k++) {
      re[k] = part[at + k] * window[k];
      power += part[at + k] * part[at + k];
    }
    fft(re, im);
    let low = 0;
    let high = 0;
    for (let k = 1; k < n / 2; k++) {
      const f = (k * rate) / n;
      const p = re[k] * re[k] + im[k] * im[k];
      if (f >= 150 && f < 1000) low += p;
      else if (f >= 2000 && f < 6000) high += p;
    }
    frames.push({ level: power, low, high });
  }
  // The voiced half of it: the louder frames.
  const loud = [...frames].sort((a, b) => b.level - a.level).slice(0, Math.max(1, Math.ceil(frames.length / 2)));
  const low = loud.reduce((s, f) => s + f.low, 0);
  const high = loud.reduce((s, f) => s + f.high, 0);
  return { level: percentile(levels, 80), bright: 10 * Math.log10((high + 1e-12) / (low + 1e-12)) };
}

/**
 * Talk in a take that isn't one of the scene's lines and was picked up off mic:
 * the other actor's ad-libs (Guy, Oct 5, 2026: "How can we make it a rule ... to
 * know when the mic is picking up from somebody else's coverage"). The boom
 * follows the actor on camera, so the take's own lines teach it how each actor
 * comes through: how loud, and with what colour (brightness). A stretch of talk
 * in no line, said on its own, is off mic when it's as quiet as the other
 * actor's lines and has their colour, not the actor on camera's: a voice keeps
 * its colour when it speaks softly into the mic, and a whisper is brighter
 * still. Colour is each voice's own (shoot 1053's doctor sounded duller on mic
 * than the husband did off it), so a take whose two voices don't clearly differ
 * (12 dB; or 8 dB and some colour; or 5 dB and plainly in colour; never with the
 * boom between them, or a second mic) marks nothing: a word it can't place stays.
 */
export function offMicTalk(take: Take, units: Unit[], audio: Float32Array, rate: number): [number, number][] {
  const onCamera = take.setup?.who;
  if (!onCamera) return [];
  const near: { level: number; bright: number }[] = [];
  const far: { level: number; bright: number }[] = [];
  take.matches.forEach((m, j) => {
    if (!isFound(m, 0.6)) return;
    const sound = speechSound(audio, rate, m.start, m.end);
    if (sound) (units[j].who === onCamera ? near : far).push(sound);
  });
  if (near.length < 2 || far.length < 1) return [];
  const level = [median(near.map((s) => s.level)), median(far.map((s) => s.level))];
  const bright = [median(near.map((s) => s.bright)), median(far.map((s) => s.bright))];
  const [loud, colour] = [level[0] - level[1], Math.abs(bright[0] - bright[1])];
  if (!(loud >= 12 || (loud >= 8 && colour >= 1.5) || (loud >= 5 && colour >= 3))) return [];
  const mid = (level[0] + level[1]) / 2;
  const off: [number, number][] = [];
  const words = take.words;
  for (let a = 0; a < words.length; a++) {
    if (words[a].inLine) continue;
    // A run of talk in no line: up to a pause, or a sentence's end and a breath (where someone else may come in).
    let b = a;
    while (b + 1 < words.length && !words[b + 1].inLine && words[b + 1].s - words[b].e < (words[b].stop ? 0.2 : 0.6)) b++;
    const [s, e] = [words[a].s, words[b].e];
    // Said on its own, not trailing off a line or leading into one (where it may be the actor on camera's).
    const apart = (a === 0 || s - words[a - 1].e >= 0.25) && (b === words.length - 1 || words[b + 1].s - e >= 0.25);
    a = b;
    if (!apart) continue;
    // Short words are measured over a little more around them, at least a frame's worth.
    const pad = Math.max(0, (0.16 - (e - s)) / 2);
    const sound = speechSound(audio, rate, s - pad, e + pad);
    if (!sound) continue;
    const whisper = sound.bright >= Math.max(...bright) + 3;
    // Its colour is the other actor's; or the two voices have about the same colour, and loudness alone decides.
    const theirs = colour < 1.5 || Math.abs(sound.bright - bright[1]) < Math.abs(sound.bright - bright[0]);
    if (!whisper && theirs && sound.level < mid - (loud >= 12 ? 3 : 2)) off.push([s, e]);
  }
  return off;
}

/**
 * Splits lines and takes into two sides at once. `levels[u][t]` is line u's
 * level in take t (null: not in that take). Each take is centred on its own
 * median, so a line is "+" where it's louder than that take's other lines.
 * With `speakers` given (±1 per line, from the script), only the takes are
 * worked out; otherwise the lines are too (power iteration on the matrix).
 * Returns ±1 per line (who says it) and a signed strength per take (who's on
 * camera, + meaning the "+" lines' actor).
 */
export function coCluster(levels: (number | null)[][], speakers?: number[]): { speaker: number[]; onCamera: number[] } {
  const lines = levels.length;
  const takes = lines ? levels[0].length : 0;
  const centred = levels.map((row) => row.slice());
  for (let t = 0; t < takes; t++) {
    const column = levels.map((row) => row[t]).filter((v): v is number => v !== null);
    if (!column.length) continue;
    const mid = median(column);
    for (let u = 0; u < lines; u++) if (centred[u][t] !== null) centred[u][t]! -= mid;
  }
  const at = (u: number, t: number) => centred[u][t] ?? 0;
  const project = (x: number[]) => Array.from({ length: takes }, (_, t) => x.reduce((sum, xu, u) => sum + xu * at(u, t), 0));
  const unit = (v: number[]) => {
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  if (speakers) return { speaker: speakers, onCamera: project(speakers) };
  // Start from the take with the most lines, then alternate.
  let best = 0;
  for (let t = 1; t < takes; t++) if (levels.filter((r) => r[t] !== null).length > levels.filter((r) => r[best] !== null).length) best = t;
  let x = unit(levels.map((_, u) => at(u, best)));
  let y: number[] = [];
  for (let k = 0; k < 60; k++) {
    y = unit(project(x));
    x = unit(levels.map((_, u) => y.reduce((sum, yt, t) => sum + yt * at(u, t), 0)));
  }
  return { speaker: x.map((v) => (v >= 0 ? 1 : -1)), onCamera: project(x.map((v) => (v >= 0 ? 1 : -1))) };
}

/**
 * Who's on camera per take (±1, null for a take with too few lines to tell),
 * from coCluster's strengths. A take whose evidence is weak takes its
 * neighbour's answer: takes of one setup are shot back to back.
 */
export function onCameraSides(strength: (number | null)[]): (1 | -1 | null)[] {
  const known = strength.filter((s): s is number => s !== null).map(Math.abs);
  const strong = known.length ? 0.25 * median(known) : 0;
  const sides = strength.map((s) => (s === null ? null : s >= 0 ? 1 : -1)) as (1 | -1 | null)[];
  return sides.map((side, t) => {
    if (side === null || Math.abs(strength[t]!) >= strong) return side;
    for (let d = 1; d < strength.length; d++) {
      for (const k of [t - d, t + d]) {
        const s = strength[k];
        if (s !== undefined && s !== null && Math.abs(s) >= strong) return s >= 0 ? 1 : -1;
      }
    }
    return side;
  });
}

export const SIGNATURE_WIDTH = 48;
export const SIGNATURE_HEIGHT = 27;

/** A take's look in miniature: the median of small grey frames at the given times. */
export async function frameSignature(ffmpeg: string, video: string, times: number[], signal?: AbortSignal): Promise<Float32Array | null> {
  const size = SIGNATURE_WIDTH * SIGNATURE_HEIGHT;
  const frames: Uint8Array[] = [];
  for (const time of times) {
    const raw = await ffmpegPipe(
      ffmpeg,
      ["-v", "error", "-nostdin", "-ss", time.toFixed(2), "-i", video, "-frames:v", "1", "-vf", `scale=${SIGNATURE_WIDTH}:${SIGNATURE_HEIGHT},format=gray`, "-f", "rawvideo", "-"],
      undefined,
      signal,
    ).catch(() => Buffer.alloc(0));
    if (raw.length === size) frames.push(new Uint8Array(raw));
  }
  if (!frames.length) return null;
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = median(frames.map((f) => f[i]));
  return out;
}

export function signatureDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Where a run of takes changes setup: the split that keeps each side's takes
 * most alike (every take compared with every other, so one odd moment, like an
 * actor walking into frame, can't move it). Kept only when the two sides
 * differ clearly more than the takes within them. One split at most: Reelarc
 * shoots each actor in two setups, medium then close.
 */
export function setupSplits(d: number[][], from = 0, to = d.length): number[] {
  const n = to - from;
  if (n < 2) return [];
  const avg = (pairs: [number, number][]) => (pairs.length ? pairs.reduce((s, [i, j]) => s + d[i][j], 0) / pairs.length : 0);
  const within = (a: number, b: number) => {
    const pairs: [number, number][] = [];
    for (let i = a; i < b; i++) for (let j = i + 1; j < b; j++) pairs.push([i, j]);
    return pairs;
  };
  let best: { k: number; inside: number; across: number } | null = null;
  for (let k = from + 1; k < to; k++) {
    const left = within(from, k);
    const right = within(k, to);
    const inside = (avg(left) * left.length + avg(right) * right.length) / Math.max(1, left.length + right.length);
    const pairs: [number, number][] = [];
    for (let i = from; i < k; i++) for (let j = k; j < to; j++) pairs.push([i, j]);
    const across = avg(pairs);
    if (!best || across - inside > best.across - best.inside) best = { k, inside, across };
  }
  const { k, inside, across } = best!;
  const clear = inside > 0 ? across >= 10 && across >= 1.5 * inside : across >= 20;
  if (!clear) return [];
  return [k - from];
}

/**
 * Medium or close, per take (in shooting order). Each actor's takes split into
 * setups where the picture changes most; an actor's first setup is the medium
 * shot, later ones the close-ups.
 */
export function framingsFor(takes: { who: string | null; signature: Float32Array | null }[]): (Framing | null)[] {
  const out: (Framing | null)[] = takes.map(() => null);
  const seen = new Map<string, number>(); // setups so far per actor
  // Takes nobody could place (false starts) don't break a run.
  const placed = takes.map((t, k) => (t.who ? k : -1)).filter((k) => k >= 0);
  let i = 0;
  while (i < placed.length) {
    const who = takes[placed[i]].who!;
    let j = i;
    while (j + 1 < placed.length && takes[placed[j + 1]].who === who) j += 1;
    const run = placed.slice(i, j + 1);
    const d = run.map((x) => run.map((y) => {
      const a = takes[x].signature;
      const b = takes[y].signature;
      return a && b ? signatureDistance(a, b) : 0;
    }));
    const cuts = setupSplits(d);
    let group = 0;
    run.forEach((t, k) => {
      if (cuts.includes(k)) group += 1;
      const setupNumber = (seen.get(who) ?? 0) + group;
      out[t] = setupNumber === 0 ? "medium" : "close";
    });
    seen.set(who, (seen.get(who) ?? 0) + group + 1);
    i = j + 1;
  }
  return out;
}
