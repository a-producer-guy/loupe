// The first assembly's last steps (from the pilot's finish.py): the preview
// mix, the preview video, and the Premiere timeline with every layer on its
// own track:
//   V1 the cut · V2/V3 alternate takes (off)
//   A1 the client's dialogue · A2 the other actor's, cleaned · A3 alternate dialogue (off)
//   A4/A5 camera sound as shot (off) · A6 room tone · A7/A8 ambience · A9/A10 score, dipping
//   under every line (volume keyframes)
// Final Cut Pro 7 XML (File > Import in Premiere), 23.976 fps.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fft, ffmpegPipe, fromDb, hanning, loudness, readAudio, rmsDb, SR, scale, softCeiling, writeAudio } from "./audio.js";
import { handheldFilter, handheldKeys, shakeFor, SNAP_SCALE, type MotionKey, type Shake, type Zoom } from "./camera.js";
import { describeShots, FPS, frames as fr, type Cut, type Piece } from "./engine.js";
import { isFound } from "./text.js";

export const AMBIENCE_LUFS = -40;
export const MUSIC_LUFS = -29;
export const DUCK_DB = -9;
export const FINAL_LUFS = -16;
/** Where the timeline expects the shoot folder; if it's elsewhere Premiere asks for the first clip and finds the rest. */
export const MEDIA_ROOT = "/Users/Shared/Reelarc Footage";
const RATE = "<rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate>";

export type TakeMedia = { width: number; height: number; audioChannels: number; preview: string };

export type Layers = { start: number; musicLength: number; points: [number, number][]; musicGainDb: number; ambienceGainDb: number; introGainDb: number };

/**
 * The establishing shot in front of the cut (null: none): a video file, its
 * length, whether it has sound, and how many seconds of the scene's sound play
 * under it before the picture cuts in (the J-cut, overlapIntro).
 */
export type Intro = { file: string; seconds: number; hasAudio: boolean; overlap?: number } | null;

/**
 * A push-in on one shot of the cut (an index into cut.video), to `scale`
 * (1.08 = 108%): slowly over the whole shot, or, with `snap`, a quick zoom
 * starting that many seconds into the shot (a comedy's biggest laugh).
 */
export type PushIn = { piece: number; scale: number; snap?: number };

export const FADE_IN = 1.0;
export const FADE_OUT = 2.0;
/** The establishing shot's street sound, fuller than the room's ambience. */
export const INTRO_LUFS = -30;

/** The intro's length on the timeline, in whole frames. */
export const introSeconds = (intro: Intro) => (intro ? fr(intro.seconds) / FPS : 0);

/** Where the scene starts on the timeline, in frames: under the end of the establishing shot, by its overlap. */
export const sceneFrame = (intro: Intro) => (intro ? fr(intro.seconds) - fr(intro.overlap ?? 0) : 0);

/**
 * The establishing shot's J-cut (Guy, Oct 5: "Most of the time start the
 * first line immediately OVER the establishing shot. So it's a J cut, we hear
 * audio and then go into the rest"): the scene's sound starts while the
 * exterior is still on screen, and the picture cuts in a beat into the first
 * line, so that shot still runs a second and a half; a short first line that's
 * answered straight away is heard whole over the exterior, and the picture
 * cuts in on whoever answers. The exterior keeps 2.5 s to itself first. A
 * scene that opens on someone coming in cuts in straight, so it's seen.
 */
export function overlapIntro(cut: Cut, intro: Intro): { cut: Cut; intro: Intro } {
  if (!intro || !cut.video.length) return { cut, intro };
  const b = cut.blocks[0];
  const m = cut.takes.find((t) => t.take === b.take)!.matches[b.first];
  if (!isFound(m)) return { cut, intro };
  const said = b.audio.recIn + m.start - b.audio.in;
  const latest = introSeconds(intro) - 2.5 + said;
  let video = cut.video;
  let at = Math.min(said + Math.min(1.0, Math.max(0.5, 0.6 * (m.end - m.start))), latest);
  if (at > video[0].recOut - 1.5) {
    const next = video[1];
    if (next && m.end - m.start <= 1.8 && next.recIn <= Math.min(latest, said + 2.2) && next.recOut - next.recIn >= 1.5) [at, video] = [next.recIn, video.slice(1)];
    else at = video[0].recOut - 1.5;
  }
  if (said - b.audio.recIn > 1.2 || at < said + 0.3) return { cut, intro: { ...intro, overlap: 0 } };
  const overlap = fr(at) / FPS;
  const first = video[0];
  const shift = overlap - first.recIn;
  const trimmed: Piece = {
    ...first,
    in: Math.round((first.in + shift) * 1000) / 1000,
    recIn: Math.round(overlap * 1000) / 1000,
    alternates: first.alternates.map((x) => ({ ...x, in: Math.round((x.in + shift) * 1000) / 1000 })),
  };
  return { cut: { ...cut, video: [trimmed, ...video.slice(1)] }, intro: { ...intro, overlap } };
}

/**
 * Where the scene peaks (lines picked by the language model), a slow push-in
 * on the shot that's on screen as the line is said: over the whole shot, 5-12%
 * depending on its length. Never on a short shot or a reaction, and never on
 * two neighbouring shots. A comedy's biggest laugh (`laugh`) gets a quick zoom
 * instead, just as the line starts, on whoever is on screen.
 */
export function pushIns(cut: Cut, peaks: number[], laugh: number | null = null): PushIn[] {
  const T = new Map(cut.takes.map((t) => [t.take, t]));
  // When each line starts, and the shot on screen a moment into it (the speaker's shot can come in just after
  // their line starts, on a J-cut).
  const lineAt = new Map<number, { at: number; piece: number }>();
  for (const b of cut.blocks) {
    for (let j = b.first; j <= b.last; j++) {
      const m = T.get(b.take)!.matches[j];
      if (!isFound(m)) continue;
      const at = b.audio.recIn + m.start - b.audio.in;
      const seen = at + Math.min(0.4, (m.end - m.start) / 2);
      lineAt.set(j, { at, piece: cut.video.findIndex((p) => p.recIn <= seen + 0.01 && seen < p.recOut) });
    }
  }
  const out: PushIn[] = [];
  const funny = laugh === null ? undefined : lineAt.get(laugh);
  if (funny) {
    const p = cut.video[funny.piece];
    const length = p ? p.recOut - p.recIn : 0;
    // Seen to start, and held a second after.
    if (p && length >= 1.4) out.push({ piece: funny.piece, scale: SNAP_SCALE, snap: Math.round(Math.min(length - 1, Math.max(0.25, funny.at - p.recIn - 0.1)) * 1000) / 1000 });
  }
  for (const j of peaks) {
    if (j === laugh) continue;
    const k = lineAt.get(j)?.piece ?? -1;
    const p = cut.video[k];
    if (!p || p.kind !== "shot" || p.recOut - p.recIn < 2.5) continue;
    if (out.some((x) => Math.abs(x.piece - k) <= 1)) continue;
    out.push({ piece: k, scale: Math.round((1 + Math.min(0.12, Math.max(0.05, 0.015 * (p.recOut - p.recIn)))) * 1000) / 1000 });
  }
  return out.sort((a, b) => a.piece - b.piece);
}

/** A shot's zoom, as the camera moves draw it. */
export function zoomFor(push: PushIn | undefined, seconds: number): Zoom {
  if (!push) return { kind: "none" };
  return push.snap === undefined ? { kind: "slow", to: push.scale, seconds } : { kind: "snap", to: push.scale, at: push.snap };
}

/** Each shot's own handheld move, the same every time the scene is made. */
export const shakeOf = (piece: number): Shake => shakeFor(7919 * (piece + 1));

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pathUrl = (p: string) => `file://localhost${p.split("/").map(encodeURIComponent).join("/")}`;

export function tcFrames(tc: string): number {
  const [h, m, s, f] = tc.split(/[:;]/).map(Number);
  return ((h * 60 + m) * 60 + s) * 24 + f;
}

/** When someone is speaking in the cut, from each sound edit's words (joined when under `join` seconds apart). */
export function speechOnTimeline(cut: Cut, join = 0.8): [number, number][] {
  const T = new Map(cut.takes.map((t) => [t.take, t]));
  const spans: [number, number][] = [];
  for (const p of cut.audio) {
    for (const m of T.get(p.take)!.matches) {
      if (!isFound(m) || m.end <= p.in || m.start >= p.out) continue;
      spans.push([p.recIn + Math.max(m.start, p.in) - p.in, p.recIn + Math.min(m.end, p.out) - p.in]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = merged.at(-1);
    if (last && s - last[1] < join) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * How the score moves (Guy, Oct 5: "Smooth more the music dips and starts"):
 * it comes in from silence over its first SCORE_IN seconds, eases down from a
 * second before each stretch of dialogue, stays down through pauses shorter
 * than DIP_JOIN, and eases back up over about two seconds after it. Every move
 * is an S-curve (slow, faster, slow), so nothing pumps.
 */
export const SCORE_IN = 3.0;
export const DIP_JOIN = 2.5;
const DIP_DOWN: [number, number] = [-1.0, -0.1];
const DIP_UP: [number, number] = [0.4, 2.2];
const SILENT_DB = -40;

/** Slow, faster, slow, from 0 to 1. */
const ease = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

/** The score's level at `t` (seconds into it, dB) under these stretches of dialogue (already in score time). */
function scoreLevel(spans: [number, number][], t: number): number {
  let dip = 0;
  for (const [s, e] of spans) {
    const down = ease((t - (s + DIP_DOWN[0])) / (DIP_DOWN[1] - DIP_DOWN[0]));
    const up = ease((t - (e + DIP_UP[0])) / (DIP_UP[1] - DIP_UP[0]));
    dip = Math.min(dip, DUCK_DB * down * (1 - up));
  }
  return SILENT_DB * (1 - ease(t / SCORE_IN)) + dip;
}

/** Volume keyframes (seconds into the score, dB), close enough together to draw each curve. */
export function duckPoints(spans: [number, number][], length: number, start: number): [number, number][] {
  const inScore = spans.map(([s, e]) => [s - start, e - start] as [number, number]).filter(([s, e]) => e > -DIP_UP[1] && s < length - DIP_DOWN[0]);
  const at = new Set<number>([0, length]);
  const curve = (from: number, to: number) => {
    for (let k = 0; k <= 6; k++) at.add(from + ((to - from) * k) / 6);
  };
  curve(0, SCORE_IN);
  for (const [s, e] of inScore) {
    curve(s + DIP_DOWN[0], s + DIP_DOWN[1]);
    curve(e + DIP_UP[0], e + DIP_UP[1]);
  }
  const points: [number, number][] = [];
  for (const t of [...at].filter((t) => t >= 0 && t <= length).sort((a, b) => a - b)) {
    if (points.length && t - points.at(-1)![0] < 0.02) continue;
    points.push([Math.round(t * 1000) / 1000, Math.round(scoreLevel(inScore, t) * 100) / 100 || 0]);
  }
  return points;
}

/** The keyframes drawn sample by sample, in straight lines of dB between them (as Premiere draws them). */
function envelope(points: [number, number][], n: number): Float32Array {
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (k < points.length - 2 && points[k + 1][0] < t) k++;
    const [t0, v0] = points[k];
    const [t1, v1] = points[Math.min(k + 1, points.length - 1)];
    out[i] = fromDb(t <= t0 ? v0 : t >= t1 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0));
  }
  return out;
}

const fade = (c: Float32Array, from: number, to: number, up: boolean) => {
  for (let i = from; i < to; i++) c[i] *= up ? (i - from) / Math.max(1, to - from) : 1 - (i - from) / Math.max(1, to - from);
};

/** A join's level in a take, dB: the 30 ms around `t` seconds. */
const levelAt = (x: Float32Array, t: number) => rmsDb(x.subarray(Math.max(0, Math.round((t - 0.015) * SR)), Math.max(0, Math.round((t + 0.015) * SR))));
/** Quiet enough to crossfade through: well under the dialogue (-20 LUFS) on both sides of a join. */
const QUIET_DB = -45;

/**
 * Every join in the dialogue moved, by up to two frames, to its quietest moment
 * on both sides, so no cut lands on a breath, a lip smack or the tail of a word
 * (Guy, Oct 5: what lazy editors skip). Only within the silence between words
 * in both takes, so no edit gains or loses one (shoot 1053: a join slid onto
 * the other actor's off-mic "The"). Whole frames, every edit kept in sync and
 * at least two frames long.
 */
export async function quietJoins(ffmpeg: string, cut: Cut, dialogue: Map<string, string>, signal?: AbortSignal): Promise<Cut> {
  const audio = cut.audio.map((a) => ({ ...a }));
  const T = new Map(cut.takes.map((t) => [t.take, t]));
  // The silence around a moment of a take, from its last word's end to its next word's start; none inside a word.
  const silence = (take: string, at: number): [number, number] | null => {
    const words = T.get(take)?.words ?? [];
    if (words.some((w) => w.s < at - 0.01 && w.e > at + 0.01)) return null;
    const before = Math.max(-Infinity, ...words.filter((w) => w.e <= at + 0.01).map((w) => w.e));
    const after = Math.min(Infinity, ...words.filter((w) => w.s >= at - 0.01).map((w) => w.s));
    return [before + 0.02, after - 0.02];
  };
  const cache = new Map<string, Float32Array>();
  const sound = async (take: string) => {
    if (!cache.has(take)) cache.set(take, (await readAudio(ffmpeg, dialogue.get(take)!, 1, SR, signal))[0]);
    return cache.get(take)!;
  };
  for (let i = 0; i + 1 < audio.length; i++) {
    const [a, b] = [audio[i], audio[i + 1]];
    if (Math.abs(a.recOut - b.recIn) > 0.002 || !dialogue.has(a.take) || !dialogue.has(b.take)) continue; // a silent stretch between them
    const [xa, xb] = [await sound(a.take), await sound(b.take)];
    const [sa, sb] = [silence(a.take, a.out), silence(b.take, b.in)];
    if (!sa || !sb) continue;
    const at = fr(a.recOut);
    let [best, cost] = [0, Infinity];
    for (let d = -2; d <= 2; d++) {
      const t = (at + d) / FPS;
      if (fr(t) - fr(a.recIn) < 2 || fr(b.recOut) - fr(t) < 2) continue;
      const [ta, tb] = [a.in + t - a.recIn, b.in + t - b.recIn];
      if (d && (ta < sa[0] || ta > sa[1] || tb < sb[0] || tb > sb[1])) continue;
      // The louder side decides; a move has to earn its keep (half a dB a frame).
      const c = Math.max(levelAt(xa, a.in + t - a.recIn), levelAt(xb, b.in + t - b.recIn)) + Math.abs(d) * 0.5;
      if (c < cost) [best, cost] = [d, c];
    }
    if (!best) continue;
    const t = (at + best) / FPS;
    a.out = Math.round((a.in + t - a.recIn) * 1000) / 1000;
    b.in = Math.round((b.in + t - b.recIn) * 1000) / 1000;
    a.recOut = b.recIn = Math.round(t * 1000) / 1000;
  }
  return { ...cut, audio };
}

/**
 * Where a score really ends, in seconds: the last moment it's still within 25 dB
 * of its usual level. The music service often finishes a piece well before the
 * length asked for, and leaves the rest near silent.
 */
export function audibleEnd(music: Float32Array[], rate = SR): number {
  const win = Math.round(rate / 10);
  const levels: number[] = [];
  for (let at = 0; at + win <= music[0].length; at += win) levels.push(Math.max(...music.map((c) => rmsDb(c.subarray(at, at + win)))));
  const heard = levels.filter((l) => l > -70).sort((a, b) => a - b);
  if (!heard.length) return 0;
  const usual = heard[Math.floor(heard.length / 2)];
  const last = levels.findLastIndex((l) => l >= usual - 25);
  return ((last + 1) * win) / rate;
}

/**
 * When a score's last chord hits, in seconds: its last strong attack, after
 * which it only rings away. Null when it just fades out, with no chord to land.
 */
export function finalHit(music: Float32Array[], rate = SR): number | null {
  const n = 2048;
  const hop = 1024;
  const mono = new Float32Array(music[0].length);
  for (const c of music) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / music.length;
  const window = hanning(n);
  const flux: number[] = [];
  const level: number[] = [];
  let last: Float64Array | null = null;
  for (let at = 0; at + n <= mono.length; at += hop) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let power = 0;
    for (let k = 0; k < n; k++) {
      re[k] = mono[at + k] * window[k];
      power += mono[at + k] * mono[at + k];
    }
    fft(re, im);
    const mag = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) mag[k] = Math.log1p(10 * Math.hypot(re[k], im[k]));
    let rise = 0;
    if (last) for (let k = 0; k < n / 2; k++) rise += Math.max(0, mag[k] - last[k]);
    last = mag;
    flux.push(rise);
    level.push(10 * Math.log10(power / n + 1e-12));
  }
  if (flux.length < 50) return null;
  // Only up to where the piece really ends: what's after it is near silence.
  const ends = Math.min(flux.length, Math.ceil((audibleEnd(music, rate) * rate) / hop) + 1);
  flux.length = ends;
  level.length = ends;
  // Attacks: the frames whose rise stands out from their neighbours'; strong ones, a third of the piece's hardest at least.
  const peaks = flux.flatMap((v, i) => (i > 0 && i + 1 < flux.length && v >= flux[i - 1] && v > flux[i + 1] ? [i] : []));
  const strong = Math.max(...peaks.map((i) => flux[i]));
  const seconds = (i: number) => (i * hop + n / 2) / rate;
  for (let k = peaks.length - 1; k >= 0; k--) {
    const i = peaks[k];
    if (flux[i] < 0.35 * strong) continue;
    // The last of the strong ones: nothing after it attacks half as hard, it's near the end, and it rings away.
    const after = peaks.slice(k + 1).some((j) => flux[j] >= 0.5 * flux[i]);
    const tail = level.slice(-Math.round(0.5 * rate / hop));
    const loud = Math.max(...level.slice(i, i + Math.round(0.3 * rate / hop)));
    const fades = tail.reduce((a, b) => a + b, 0) / tail.length <= loud - 10;
    if (after || seconds(i) < seconds(flux.length - 1) - 14 || !fades) return null;
    return seconds(i);
  }
  return null;
}

/**
 * Mixes the layers, the scene's under the end of the establishing shot if
 * there is one (its J-cut). Writes the package's Audio/ files and the preview
 * mix (faded in from and out to silence), and returns what the timeline needs
 * to set the same levels.
 */
export async function mix(opts: {
  ffmpeg: string;
  cut: Cut;
  dialogue: Map<string, string>;
  roomTone: string;
  ambience: string;
  music: string;
  intro: Intro;
  audioDir: string;
  mixFile: string;
  signal?: AbortSignal;
}): Promise<{ layers: Layers; seconds: number }> {
  const { ffmpeg, cut, signal } = opts;
  // Where the scene's sound starts, and where its picture cuts in.
  const off = Math.round((sceneFrame(opts.intro) / FPS) * SR);
  const pic = Math.round(introSeconds(opts.intro) * SR);
  const nCut = Math.round((fr(cut.seconds) / FPS) * SR);
  const n = off + nCut;
  const at = (seconds: number) => Math.round((fr(seconds) / FPS) * SR);

  // Dialogue, edit by edit from the cleaned takes (a few ms of fade at each join; the scene's first sound eases in).
  // Where a join is quiet on both sides, the two takes crossfade over two frames instead, evenly (equal power), so the
  // room's own sound passes from one to the other without a step.
  const dialogue = new Float32Array(n);
  const cache = new Map<string, Float32Array>();
  for (const p of cut.audio) if (!cache.has(p.take)) cache.set(p.take, (await readAudio(ffmpeg, opts.dialogue.get(p.take)!, 1, SR, signal))[0]);
  const frame = Math.round(SR / FPS);
  const quiet = cut.audio.map((p, k) => {
    const q = cut.audio[k + 1];
    if (!q || Math.abs(p.recOut - q.recIn) > 0.002) return false;
    return Math.max(levelAt(cache.get(p.take)!, p.out), levelAt(cache.get(q.take)!, q.in)) <= QUIET_DB;
  });
  for (const [k, p] of cut.audio.entries()) {
    const src = cache.get(p.take)!;
    const [pre, post] = [k > 0 && quiet[k - 1] ? frame : 0, quiet[k] ? frame : 0];
    const a = at(p.in) - pre;
    const length = Math.round(((fr(p.recOut) - fr(p.recIn)) / FPS) * SR) + pre + post;
    const piece = new Float32Array(length);
    piece.set(src.subarray(Math.max(0, a), Math.max(0, Math.min(src.length, a + length))), Math.max(0, -a));
    const f = Math.min(Math.floor(0.01 * SR), Math.floor(piece.length / 2));
    if (pre) for (let i = 0; i < 2 * pre; i++) piece[i] *= Math.sin((Math.PI / 2) * (i / (2 * pre)));
    else fade(piece, 0, k === 0 ? Math.min(Math.floor(0.25 * SR), Math.floor(piece.length / 2)) : f, true);
    if (post) for (let i = 0; i < 2 * post; i++) piece[length - 2 * post + i] *= Math.cos((Math.PI / 2) * (i / (2 * post)));
    else fade(piece, piece.length - f, piece.length, false);
    const where = off + at(p.recIn) - pre;
    for (let i = 0; i < piece.length && where + i < n; i++) if (where + i >= 0) dialogue[where + i] += piece[i];
  }
  const used = new Set(cut.audio.map((p) => p.take));
  for (const p of cut.video) for (const alt of p.alternates.slice(0, 1)) used.add(alt.take);
  await mkdir(opts.audioDir, { recursive: true });
  for (const take of used) if (opts.dialogue.has(take)) await copyFile(opts.dialogue.get(take)!, path.join(opts.audioDir, `${take}_dialogue.wav`));

  const tone = new Float32Array(n);
  tone.set((await readAudio(ffmpeg, opts.roomTone, 1, SR, signal))[0].subarray(0, nCut), off);
  fade(tone, off, Math.min(n, off + Math.floor(0.3 * SR)), true);
  await copyFile(opts.roomTone, path.join(opts.audioDir, "room_tone.wav"));

  // The establishing shot's own street sound, handing over to the room: as the first line comes in under it
  // (the J-cut), or over its last moments.
  const cross = Math.floor(0.75 * SR);
  const handover = Math.max(0, Math.min(off, pic - cross));
  let intro: Float32Array[] = [new Float32Array(n), new Float32Array(n)];
  let introGainDb = 0;
  if (opts.intro?.hasAudio && pic > 0) {
    const sound = await readAudio(ffmpeg, opts.intro.file, 2, SR, signal).catch(() => null);
    if (sound && sound[0].length) {
      intro = sound.map((c) => {
        const out = new Float32Array(n);
        out.set(c.subarray(0, Math.min(pic, n)));
        fade(out, handover, pic, false);
        return out;
      });
      introGainDb = INTRO_LUFS - loudness(intro.map((c) => c.subarray(0, handover >= SR ? handover : pic)));
    }
  }

  // The room's ambience: the seamless loop from the start of the scene to the end, set well under the dialogue.
  const loop = await readAudio(ffmpeg, opts.ambience, 2, SR, signal);
  const from = pic > 0 ? handover : 0;
  const amb = loop.map((c) => {
    const out = new Float32Array(n);
    for (let i = from; i < n; i++) out[i] = c[(i - from) % c.length];
    fade(out, from, Math.min(pic > 0 ? pic : from + Math.floor(1.5 * SR), n), true);
    fade(out, Math.max(from, n - Math.floor(1.5 * SR)), n, false);
    return out;
  });
  const ambienceGainDb = AMBIENCE_LUFS - loudness(amb.map((c) => c.subarray(from)));
  await writeAudio(ffmpeg, path.join(opts.audioDir, "ambience.wav"), amb, SR, "pcm_s24le", signal);

  // Score: from the first frame (over the establishing shot), its ending on the scene's last beat; it comes in
  // slowly and dips under the dialogue (duckPoints).
  let music = await readAudio(ffmpeg, opts.music, 2, SR, signal);
  const speech = speechOnTimeline(cut, DIP_JOIN).map(([s0, e0]) => [s0 + off / SR, e0 + off / SR] as [number, number]);
  // Its last chord lands just after the scene's last line and rings over the final shot; with no clear last chord, the
  // piece's real ending (not its file's, often seconds of near silence later) meets the scene's (Guy, Oct 5: a lazy
  // edit lets the score end wherever it ends). One too short for that starts with the scene, and ends early.
  const hit = finalHit(music);
  const end = audibleEnd(music);
  const lands = hit !== null && speech.length ? Math.min(speech.at(-1)![1] + 0.4, n / SR - 2.0) - hit : n / SR - 0.5 - end;
  let start = lands <= 1.0 ? lands : 0;
  if (start < 0) {
    music = music.map((c) => c.slice(Math.round(-start * SR))); // start a little into the piece
    start = 0;
  }
  const room = n - Math.round(start * SR);
  if (music[0].length > room) music = music.map((c) => c.slice(0, room));
  const musicLength = music[0].length / SR;
  await writeAudio(ffmpeg, path.join(opts.audioDir, "music.wav"), music, SR, "pcm_s24le", signal);
  const musicGainDb = MUSIC_LUFS - loudness(music);
  const points = duckPoints(speech, musicLength, start);

  // The preview mix, faded in from silence and out to it.
  const env = envelope(points, music[0].length);
  const out = [0, 1].map((c) => {
    const ch = new Float32Array(n);
    const ag = fromDb(ambienceGainDb);
    const ig = fromDb(introGainDb);
    const mg = fromDb(musicGainDb);
    const mAt = Math.round(start * SR);
    for (let i = 0; i < n; i++) ch[i] = dialogue[i] + tone[i] + amb[c][i] * ag + intro[c][i] * ig;
    for (let i = 0; i < music[c].length && mAt + i < n; i++) if (mAt + i >= 0) ch[mAt + i] += music[c][i] * mg * env[i];
    return ch;
  });
  scale(out, fromDb(FINAL_LUFS - loudness(out)));
  for (const c of out) {
    fade(c, 0, Math.min(n, Math.floor(0.5 * SR)), true);
    fade(c, Math.max(0, n - Math.floor(FADE_OUT * SR)), n, false);
  }
  softCeiling(out, 0.89, true);
  await writeAudio(ffmpeg, opts.mixFile, out, SR, "pcm_s24le", signal);
  return { layers: { start, musicLength, points, musicGainDb, ambienceGainDb, introGainDb }, seconds: n / SR };
}

/**
 * How the preview is encoded. The frame rate and H.264 level are said
 * outright: left to work them out, Railway's FFmpeg labelled a preview that
 * opens on the establishing shot level 6.2, and iPhones refuse to play
 * anything above 5.2 (Guy, Oct 2: "it's not showing the cut on mobile").
 */
export const PREVIEW_VIDEO = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "24000/1001", "-profile:v", "high", "-level:v", "4.0"];

/**
 * The preview: the establishing shot (the scene's sound already under its
 * end), then the cut from the takes' web previews (with the look, if the previews don't have it yet, and the slow
 * push-ins), 720p, faded in from black and out to it, with the mix.
 */
export async function renderPreview(opts: {
  ffmpeg: string;
  cut: Cut;
  media: Map<string, TakeMedia>;
  mixFile: string;
  lut: string | null;
  /** Loupe's grade (grade.ts), after the shoot's look: the same .cube the Premiere package carries. */
  grade?: string | null;
  intro: Intro;
  pushIns: PushIn[];
  /** A comedy: every shot moves like a handheld camera. */
  handheld?: boolean;
  out: string;
  signal?: AbortSignal;
}) {
  const { cut } = opts;
  const index = new Map<string, number>();
  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];
  if (opts.intro) {
    inputs.push("-i", opts.intro.file);
    parts.push(
      `[0:v]fps=24000/1001,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,trim=end_frame=${fr(opts.intro.seconds)},setpts=PTS-STARTPTS[vi]`,
    );
    labels.push("[vi]");
  }
  for (const p of cut.video) {
    if (index.has(p.take)) continue;
    index.set(p.take, inputs.length / 2);
    inputs.push("-i", opts.media.get(p.take)!.preview);
  }
  const look = [opts.lut, opts.grade]
    .filter((l): l is string => Boolean(l) && /^[\w./ -]+$/.test(l!))
    .map((l) => `,lut3d=file='${l}'`)
    .join("");
  cut.video.forEach((p, k) => {
    const from = fr(p.in);
    const count = fr(p.recOut) - fr(p.recIn);
    const push = opts.pushIns.find((x) => x.piece === k);
    // Handheld: the move and any zoom in one smooth step. Steady: a slow push-in, scaled up a little more every
    // frame (at twice the size, so it glides), cropped to the frame.
    const zoom = opts.handheld
      ? `,${handheldFilter(shakeOf(k), zoomFor(push, count / FPS), 1280, 720)}`
      : push
        ? `,scale=2560:1440,scale=w='trunc(2560*(1+${(push.scale - 1).toFixed(4)}*t/${(count / FPS).toFixed(3)})/2)*2':h=-2:eval=frame,crop=2560:1440,scale=1280:720`
        : "";
    parts.push(`[${index.get(p.take)}:v]trim=start_frame=${from}:end_frame=${from + count},setpts=PTS-STARTPTS,scale=1280:720,setsar=1${look}${zoom}[v${k}]`);
    labels.push(`[v${k}]`);
  });
  const total = (sceneFrame(opts.intro) + fr(cut.seconds)) / FPS;
  const graph =
    `${parts.join(";")};${labels.join("")}concat=n=${labels.length}:v=1:a=0[vcat];` +
    `[vcat]fade=t=in:st=0:d=${FADE_IN},fade=t=out:st=${Math.max(0, total - FADE_OUT).toFixed(3)}:d=${FADE_OUT}[vout]`;
  await ffmpegPipe(
    opts.ffmpeg,
    ["-v", "error", "-y", "-nostdin", ...inputs, "-i", opts.mixFile, "-filter_complex", graph, "-map", "[vout]", "-map", `${inputs.length / 2}:a`,
      ...PREVIEW_VIDEO, "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", opts.out],
    undefined,
    opts.signal,
  );
}

// ─── The Premiere timeline ───────────────────────────────────────────────────

class Ids {
  n = 0;
  files = new Set<string>();
  clip() {
    this.n += 1;
    return `clipitem-${this.n}`;
  }
}

function fileXml(ids: Ids, id: string, name: string, url: string, length: number, tc: string | null, video: { width: number; height: number } | null, channels: number): string {
  if (ids.files.has(id)) return `<file id="${id}"/>`;
  ids.files.add(id);
  let media = video ? `<video><samplecharacteristics>${RATE}<width>${video.width}</width><height>${video.height}</height></samplecharacteristics></video>` : "";
  media += `<audio><samplecharacteristics><depth>${video ? 16 : 24}</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio>`;
  const timecode = tc ? `<timecode>${RATE}<string>${tc}</string><frame>${tcFrames(tc)}</frame><displayformat>NDF</displayformat></timecode>` : "";
  return `<file id="${id}"><name>${escape(name)}</name><pathurl>${url}</pathurl>${RATE}<duration>${length}</duration>${timecode}<media>${media}</media></file>`;
}

function levels(gainDb: number, keys: [number, number][] = []): string {
  const lin = (d: number) => fromDb(d).toFixed(6);
  const kf = keys.map(([t, v]) => `<keyframe><when>${fr(t)}</when><value>${lin(gainDb + v)}</value></keyframe>`).join("");
  return (
    "<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory>" +
    '<effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter authoringApp="PremierePro"><parameterid>level</parameterid>' +
    `<name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${lin(gainDb)}</value>${kf}</parameter></effect></filter>`
  );
}

function item(ids: Ids, name: string, file: string, length: number, start: number, end: number, sin: number, opts: { enabled?: boolean; track?: number; filter?: string } = {}): string {
  const src = opts.track ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${opts.track}</trackindex></sourcetrack>` : "";
  return (
    `<clipitem id="${ids.clip()}"><name>${escape(name)}</name><enabled>${opts.enabled === false ? "FALSE" : "TRUE"}</enabled><duration>${length}</duration>${RATE}` +
    `<start>${start}</start><end>${end}</end><in>${sin}</in><out>${sin + end - start}</out>${file}${src}${opts.filter ?? ""}</clipitem>`
  );
}

/** A slow push-in for Premiere: Basic Motion's scale, 100% at the clip's first frame to `scale` at its last. */
function motion(scale: number, from: number, to: number): string {
  const param = (id: string, name: string, value: string) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${value}</parameter>`;
  return (
    "<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>" +
    param(
      "scale",
      "Scale",
      `<valuemin>0</valuemin><valuemax>1000</valuemax><value>100</value><keyframe><when>${from}</when><value>100</value></keyframe><keyframe><when>${to}</when><value>${(scale * 100).toFixed(1)}</value></keyframe>`,
    ) +
    param("rotation", "Rotation", "<valuemin>-8640</valuemin><valuemax>8640</valuemax><value>0</value>") +
    param("center", "Center", "<value><horiz>0</horiz><vert>0</vert></value>") +
    param("centerOffset", "Anchor Point", "<value><horiz>0</horiz><vert>0</vert></value>") +
    "</effect></filter>"
  );
}

/**
 * A handheld clip for Premiere: Basic Motion keyframes for Scale, Rotation and
 * Center every few frames, from the clip's first source frame `from`.
 */
function handheldMotion(keys: MotionKey[], from: number): string {
  const param = (id: string, name: string, value: string) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${value}</parameter>`;
  const at = (k: MotionKey) => `<when>${from + k.frame}</when>`;
  const first = keys[0];
  return (
    "<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>" +
    param("scale", "Scale", `<valuemin>0</valuemin><valuemax>1000</valuemax><value>${first.scale}</value>${keys.map((k) => `<keyframe>${at(k)}<value>${k.scale}</value></keyframe>`).join("")}`) +
    param("rotation", "Rotation", `<valuemin>-8640</valuemin><valuemax>8640</valuemax><value>${first.rotation}</value>${keys.map((k) => `<keyframe>${at(k)}<value>${k.rotation}</value></keyframe>`).join("")}`) +
    param(
      "center",
      "Center",
      `<value><horiz>${first.x}</horiz><vert>${first.y}</vert></value>${keys.map((k) => `<keyframe>${at(k)}<value><horiz>${k.x}</horiz><vert>${k.y}</vert></value></keyframe>`).join("")}`,
    ) +
    param("centerOffset", "Anchor Point", "<value><horiz>0</horiz><vert>0</vert></value>") +
    "</effect></filter>"
  );
}

/** A fade from black at the start of the track, or to black at its end. */
function fadeXml(start: number, end: number, alignment: "start-black" | "end-black"): string {
  return (
    `<transitionitem>${RATE}<start>${start}</start><end>${end}</end><alignment>${alignment}</alignment>` +
    "<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype>" +
    "<mediatype>video</mediatype><wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse></effect></transitionitem>"
  );
}

export function timelineXml(opts: {
  cut: Cut;
  title: string;
  prefix: string;
  media: Map<string, TakeMedia>;
  layers: Layers;
  seconds: number;
  place: string;
  lutNote: string;
  intro?: Intro;
  pushIns?: PushIn[];
  handheld?: boolean;
}): string {
  const { cut, layers } = opts;
  const intro = opts.intro ?? null;
  const pushes = opts.pushIns ?? [];
  const snaps = pushes.filter((x) => x.snap !== undefined).length;
  const ids = new Ids();
  const T = new Map(cut.takes.map((t) => [t.take, t]));
  const base = `${MEDIA_ROOT}/${opts.prefix}`;
  const fileName = (take: string) => path.posix.basename(T.get(take)!.path);
  const cam = (take: string) => {
    const t = T.get(take)!;
    const m = opts.media.get(take);
    return fileXml(ids, `file-${take}`, fileName(take), pathUrl(`${base}/${t.path}`), fr(t.length), t.timecode, { width: m?.width ?? 1920, height: m?.height ?? 1080 }, Math.max(1, m?.audioChannels ?? 2));
  };
  const dia = (take: string) => fileXml(ids, `file-${take}-dialogue`, `${take}_dialogue.wav`, pathUrl(`${base}/First Assembly/Audio/${take}_dialogue.wav`), fr(T.get(take)!.length), T.get(take)!.timecode, null, 1);
  const len = (take: string) => fr(T.get(take)!.length);
  const total = fr(opts.seconds);
  // The establishing shot runs E frames; the scene starts O frames in, its sound under the shot's end (the J-cut).
  const E = intro ? fr(intro.seconds) : 0;
  const O = sceneFrame(intro);
  const span = (p: { recIn: number; recOut: number }, srcIn: number) => [O + fr(p.recIn), O + fr(p.recOut), fr(srcIn)] as const;
  const alt = (p: Cut["video"][number], k: number) => p.alternates[k];

  const establishing = () =>
    fileXml(ids, "file-establishing", "Establishing (AI).mp4", pathUrl(`${base}/First Assembly/Establishing (AI).mp4`), E, null, { width: 1280, height: 720 }, 2);
  const v1 = [fadeXml(0, fr(FADE_IN), "start-black")];
  if (intro) v1.push(item(ids, "ESTABLISHING (AI)", establishing(), E, 0, E, 0));
  cut.video.forEach((p, k) => {
    const [start, end, sin] = span(p, p.in);
    const push = pushes.find((x) => x.piece === k);
    // Keyframe times are in the clip's source frames, like its in and out points.
    const filter = opts.handheld
      ? handheldMotion(handheldKeys(shakeOf(k), zoomFor(push, (end - start) / FPS), end - start), sin)
      : push
        ? motion(push.scale, sin, sin + (end - start))
        : undefined;
    v1.push(item(ids, fileName(p.take), cam(p.take), len(p.take), start, end, sin, { filter }));
  });
  v1.push(fadeXml(total - fr(FADE_OUT), total, "end-black"));
  const v2 = cut.video.filter((p) => alt(p, 0)).map((p) => item(ids, fileName(alt(p, 0).take), cam(alt(p, 0).take), len(alt(p, 0).take), ...span(p, alt(p, 0).in), { enabled: false }));
  const v3 = cut.video.filter((p) => alt(p, 1)).map((p) => item(ids, fileName(alt(p, 1).take), cam(alt(p, 1).take), len(alt(p, 1).take), ...span(p, alt(p, 1).in), { enabled: false }));
  // Each actor's dialogue on a track of their own (Guy, Oct 5: what lazy editors leave for the mixer to split), as heard:
  // every line from a take its speaker is on camera in.
  const speaker = (take: string) => (T.get(take)?.setup?.who === cut.partner ? cut.partner : cut.client);
  const dialogueOf = (who: string) =>
    cut.audio.filter((p) => speaker(p.take) === who).map((p) => item(ids, `DIALOGUE ${who} ${p.take}`, dia(p.take), len(p.take), ...span(p, p.in), { track: 1 }));
  const a1 = dialogueOf(cut.client);
  const a2 = dialogueOf(cut.partner);
  const a3 = cut.video.filter((p) => alt(p, 0)).map((p) => item(ids, `ALT DIALOGUE ${alt(p, 0).take}`, dia(alt(p, 0).take), len(alt(p, 0).take), ...span(p, alt(p, 0).in), { enabled: false, track: 1 }));
  const camera = (channel: number) => cut.audio.map((p) => item(ids, `CAMERA SOUND ${p.take}`, cam(p.take), len(p.take), ...span(p, p.in), { enabled: false, track: channel }));
  const a4 = camera(1);
  const a5 = camera(2);
  const sceneLength = total - O;
  const toneFile = fileXml(ids, "file-room-tone", "room_tone.wav", pathUrl(`${base}/First Assembly/Audio/room_tone.wav`), sceneLength + fr(1.0), null, null, 1);
  const a6 = [item(ids, "ROOM TONE (from the takes)", toneFile, sceneLength + fr(1.0), O, total, 0, { track: 1 })];
  const amb = () => fileXml(ids, "file-ambience", "ambience.wav", pathUrl(`${base}/First Assembly/Audio/ambience.wav`), total, null, null, 2);
  const ambName = `AMBIENCE (${opts.place}, AI)`;
  const a7 = [item(ids, ambName, amb(), total, 0, total, 0, { track: 1, filter: levels(layers.ambienceGainDb) })];
  const a8 = [item(ids, ambName, amb(), total, 0, total, 0, { track: 2, filter: levels(layers.ambienceGainDb) })];
  const mStart = fr(layers.start);
  const mLen = fr(layers.musicLength);
  const mus = () => fileXml(ids, "file-music", "music.wav", pathUrl(`${base}/First Assembly/Audio/music.wav`), mLen, null, null, 2);
  const a9 = [item(ids, "SCORE (AI, dips under dialogue)", mus(), mLen, mStart, mStart + mLen, 0, { track: 1, filter: levels(layers.musicGainDb, layers.points) })];
  const a10 = [item(ids, "SCORE (AI, dips under dialogue)", mus(), mLen, mStart, mStart + mLen, 0, { track: 2, filter: levels(layers.musicGainDb, layers.points) })];
  // The street sound hands over to the room as the scene's first line comes in under it.
  const handover: [number, number][] = O < E ? [[O / FPS, 0], [E / FPS, -40]] : [[Math.max(0, E / FPS - 0.75), 0], [E / FPS, -40]];
  const exterior = (channel: number) =>
    intro?.hasAudio ? [item(ids, "EXTERIOR SOUND (AI)", establishing(), E, 0, E, 0, { track: channel, filter: levels(layers.introGainDb, handover) })] : [];
  const a11 = exterior(1);
  const a12 = exterior(2);

  const layerNote =
    `${intro ? `V1 opens on an AI establishing shot (Seedance)${O < E ? ", the first line already heard under its end," : ""} then the cut · ` : "V1 the cut · "}V2/V3 alternate takes (off). A1 ${cut.client}'s dialogue · A2 ${cut.partner}'s dialogue (both cleaned) · A3 alternate dialogue (off) · A4/A5 camera sound as shot (off) · A6 room tone · A7/A8 ambience (AI) · A9/A10 score (AI) with dips under every line` +
    `${intro?.hasAudio ? " · A11/A12 the establishing shot's street sound (AI)" : ""}. Fades from black and to black.` +
    (opts.handheld ? " A handheld camera on every shot (Basic Motion keyframes: Scale, Rotation, Center; to steady a shot, delete its keyframes and set Scale to 100)." : "") +
    (pushes.length - snaps ? ` Slow push-ins (Scale keyframes) on ${pushes.length - snaps} moment${pushes.length - snaps === 1 ? "" : "s"} where the scene peaks.` : "") +
    (snaps ? " A quick zoom on the biggest laugh." : "") +
    ` ${opts.lutNote}`;
  const markers = [`<marker><name>LAYERS</name><comment>${escape(layerNote)}</comment><in>0</in><out>-1</out></marker>`];
  describeShots(cut).forEach((shot, k) => {
    const push = pushes.find((x) => x.piece === k);
    const note =
      shot.kind === "reaction"
        ? `Reaction (${shot.who}): ${shot.why}`
        : `${shot.take} ${shot.framing} on ${shot.who}: ${shot.why}.${push ? (push.snap !== undefined ? " A quick zoom on the biggest laugh." : ` Slow push-in to ${Math.round(push.scale * 100)}%: the scene peaks here.`) : ""} Alternates above, switched off: ${shot.alternates.join(", ") || "none"}`;
    const tag = push ? (push.snap !== undefined ? " quick zoom" : " push-in") : "";
    markers.push(`<marker><name>${escape(`${shot.take} ${shot.kind === "reaction" ? "reaction" : shot.framing}${tag}`)}</name><comment>${escape(note)}</comment><in>${O + fr(shot.at)}</in><out>-1</out></marker>`);
  });

  const track = (items: string[], stereo?: 0 | 1, video = false) => {
    if (video) return `<track>${items.join("")}</track>`;
    const attrs = stereo !== undefined ? ` currentExplodedTrackIndex="${stereo}" totalExplodedTrackCount="2" premiereTrackType="Stereo"` : ' premiereTrackType="Mono"';
    const out = stereo !== undefined ? `<outputchannelindex>${stereo + 1}</outputchannelindex>` : "";
    return `<track${attrs}>${items.join("")}${out}</track>`;
  };
  const first = opts.media.get(cut.video[0].take);
  const audio = [track(a1), track(a2), track(a3), track(a4, 0), track(a5, 1), track(a6), track(a7, 0), track(a8, 1), track(a9, 0), track(a10, 1)];
  if (a11.length) audio.push(track(a11, 0), track(a12, 1));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">' +
    `<sequence id="sequence-1"><name>${escape(`${opts.title} - First Assembly`)}</name><duration>${total}</duration>${RATE}` +
    `<timecode>${RATE}<string>01:00:00:00</string><frame>86400</frame><displayformat>NDF</displayformat></timecode>${markers.join("")}` +
    `<media><video><format><samplecharacteristics>${RATE}<width>${first?.width ?? 1920}</width><height>${first?.height ?? 1080}</height><pixelaspectratio>square</pixelaspectratio>` +
    `<fielddominance>none</fielddominance></samplecharacteristics></format>${track(v1, undefined, true)}${track(v2, undefined, true)}${track(v3, undefined, true)}</video>` +
    '<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics></format>' +
    `${audio.join("")}</audio></media></sequence></xmeml>\n`
  );
}

export function readMe(opts: { title: string; prefix: string; fromTakes: boolean; lutNote: string; handheld?: boolean }): string {
  return `${opts.title} - First Assembly
Made automatically by Reelarc Footage from the takes${opts.fromTakes ? " (no script was added, so the lines were worked out from the takes)" : " and the script"}.

TO OPEN IN PREMIERE
1. Download the shoot "For Premiere" from Reelarc Footage. This folder comes with it, inside the shoot's
   folder (${opts.prefix}).
2. In Premiere: File > Import, and pick "${opts.title} - First Assembly.xml".
   If Premiere asks where a clip is, point it at the first one: it finds the rest by itself.
3. Attach proxies as usual (see the For Premiere steps in the Download window).

THE TIMELINE
V1  the cut                         V2/V3  alternate takes, switched off (switch one on to swap)
A1     the client's dialogue        A2      the other actor's dialogue (both cleaned)
A3     alternate dialogue, off      A4/A5   camera sound as shot, off
A6     room tone from the takes     A7/A8   ambience (AI)
A9/A10 score (AI), dipping under every line
A marker on every shot says why that take was picked.${
    opts.handheld
      ? `
The scene plays as a comedy, so every shot has a handheld move: Basic Motion keyframes (Scale,
Rotation, Center) under Effect Controls. To steady a shot, delete its keyframes and set Scale to 100.`
      : ""
  }

THE LOOK
${opts.lutNote}

NOTES
- The dialogue comes from the proxies' camera sound; the camera originals are on A4/A5 for the final mix.
- The ambience and score were made with ElevenLabs (through fal). Check the licence covers the client's
  use before publishing.
`;
}

export async function writePackage(dir: string, files: { name: string; text: string }[]) {
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(path.join(dir, f.name), f.text);
}
