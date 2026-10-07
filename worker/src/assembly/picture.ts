// What a take's picture does, frame by frame, read once from its preview at a
// low resolution (Guy, Oct 5, 2026: harden what lazy editors skip): how much
// moves, so a cut can land on a movement, which hides it; how sharp it is, to
// keep off soft focus; and how much the edges of the frame jump, which is a
// bumped camera (the room behind the actor moves too, not just the actor). A
// mic-thump check was tried and dropped: on real takes it heard plosives and
// men's low voices, and the dialogue's low-cut takes real thumps out anyway.

import { ffmpegPipe } from "./audio.js";
import { FPS, type Take } from "./engine.js";
import { isFound, median } from "./text.js";

/**
 * Per frame (at the cut's 23.976 fps): `motion` over the whole frame, `edges`
 * along its borders, `middle` inside them. Six times a second: `sharp`, and
 * `thumbs`, the frame as 16 by 9 blocks, which soft focus hardly changes, to
 * tell whether two takes show the same picture there.
 */
export type Picture = { motion: Float32Array; edges: Float32Array; middle: Float32Array; sharp: Float32Array; thumbs: Float32Array };
export const SHARP_RATE = 6;
export const THUMB = 16 * 9;

/** A moment of a take not to use: soft focus, a bumped camera, or the camera off its actor; its cost to the cut as a line's take. */
export type Flaw = { s: number; e: number; what: "soft focus" | "camera bump" | "camera off the actor"; cost: number };

const [W, H] = [96, 54];
const [SW, SH] = [192, 108];

export async function pictureOf(ffmpeg: string, video: string, signal?: AbortSignal): Promise<Picture> {
  const small = await ffmpegPipe(ffmpeg, ["-v", "error", "-nostdin", "-i", video, "-an", "-vf", `fps=24000/1001,scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"], undefined, signal);
  const frames = Math.floor(small.length / (W * H));
  const motion = new Float32Array(frames);
  const edges = new Float32Array(frames);
  const middle = new Float32Array(frames);
  const [bx, by] = [Math.round(W * 0.12), Math.round(H * 0.12)];
  for (let f = 1; f < frames; f++) {
    const [a, b] = [f * W * H, (f - 1) * W * H];
    let [all, edge, count] = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.abs(small[a + y * W + x] - small[b + y * W + x]);
        all += d;
        if (x < bx || x >= W - bx || y < by || y >= H - by) {
          edge += d;
          count += 1;
        }
      }
    }
    motion[f] = all / (W * H);
    edges[f] = edge / count;
    middle[f] = (all - edge) / (W * H - count);
  }
  // Sharpness: how much the image's fine detail varies (the Laplacian's spread), six times a second.
  const big = await ffmpegPipe(ffmpeg, ["-v", "error", "-nostdin", "-i", video, "-an", "-vf", `fps=${SHARP_RATE},scale=${SW}:${SH}:flags=area,format=gray`, "-f", "rawvideo", "-"], undefined, signal);
  const shots = Math.floor(big.length / (SW * SH));
  const sharp = new Float32Array(shots);
  const thumbs = new Float32Array(shots * THUMB);
  const block = SW / 16;
  for (let f = 0; f < shots; f++) {
    const o = f * SW * SH;
    let [sum, squares, n] = [0, 0, 0];
    for (let y = 1; y < SH - 1; y++) {
      for (let x = 1; x < SW - 1; x++) {
        const i = o + y * SW + x;
        const lap = 4 * big[i] - big[i - 1] - big[i + 1] - big[i - SW] - big[i + SW];
        sum += lap;
        squares += lap * lap;
        n += 1;
      }
    }
    sharp[f] = squares / n - (sum / n) ** 2;
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) thumbs[f * THUMB + Math.floor(y / block) * 16 + Math.floor(x / block)] += big[o + y * SW + x] / (block * block);
  }
  return { motion, edges, middle, sharp, thumbs };
}

/**
 * Where a take's picture lets a line down, against the other takes of the same
 * setup saying the same line. Soft focus: far less sharp than another take
 * that shows the same picture there (in a handheld scene like shoot 1051 the
 * camera swings between the actors and onto props, so the same line is often
 * a different picture), at the same brightness, and not just because the actor
 * moves more (motion blur). A bumped camera: a jolt of a few frames, still
 * before and after, that moves the whole frame (an actor crossing its edge
 * moves only the edge), where the others are still; a move the operator makes
 * every take (1051: a whip pan on the entrance) isn't one. The camera off its
 * actor: a handheld close-up that has swung to the other actor or the room
 * (1051: T055 showed Jimmy, then the wall, through Frank's "Not anymore." and
 * "And?"), told by the picture there looking nothing like the take's usual
 * one where the setup's other takes still look like theirs. Close-ups only,
 * and only with a `handheld` camera: in a wider shot the actor can move about
 * the frame, and a steady camera that leaves its picture has gone with its
 * actor (1039: the client standing up from the desk, followed into a medium
 * shot in one take); only a handheld one swings off them to the other actor or
 * the room. A handheld reframe on the actor is sometimes taken for one too; it
 * only costs the line a little, and the setup's other take still shows them.
 */
export function lineFlaws(takes: Take[], pictures: Map<string, Picture>, { handheld = false }: { handheld?: boolean } = {}): Map<string, Flaw[]> {
  const out = new Map(takes.map((t) => [t.take, [] as Flaw[]]));
  const setups = new Map<string, Take[]>();
  for (const t of takes) {
    if (!t.setup || !pictures.has(t.take)) continue;
    const key = `${t.setup.who}|${t.setup.framing}`;
    setups.set(key, [...(setups.get(key) ?? []), t]);
  }
  const lines = takes[0]?.matches.length ?? 0;
  // Each take's usual picture: block by block, the middle of its pictures across the scene.
  const usual = new Map<string, Float32Array>();
  for (const t of takes) {
    const p = pictures.get(t.take);
    if (!p || t.sceneStart === null || t.sceneEnd === null) continue;
    const [a, b] = [Math.max(0, Math.floor(t.sceneStart * SHARP_RATE)), Math.min(p.sharp.length - 1, Math.ceil(t.sceneEnd * SHARP_RATE))];
    if (b - a < 6) continue;
    usual.set(t.take, Float32Array.from({ length: THUMB }, (_, k) => median(Array.from({ length: b - a + 1 }, (_, i) => p.thumbs[(a + i) * THUMB + k]))));
  }
  for (const group of setups.values()) {
    if (group.length < 2) continue;
    for (let j = 0; j < lines; j++) {
      const said = group.flatMap((t) => {
        const m = t.matches[j];
        if (!isFound(m, 0.6) || m.end - m.start < 0.3) return [];
        const p = pictures.get(t.take)!;
        const [f0, f1] = [Math.floor(m.start * FPS), Math.min(p.edges.length, Math.ceil(m.end * FPS))];
        // The middle half of the line: its sharpness, and its picture at the start, middle and end of that.
        const [a, b] = [m.start + (m.end - m.start) / 4, m.end - (m.end - m.start) / 4];
        const samples = [a, (a + b) / 2, b].map((x) => Math.min(p.sharp.length - 1, Math.round(x * SHARP_RATE)));
        if (samples[0] < 0 || f1 - f0 < 4) return [];
        const sharp = median([...p.sharp.subarray(samples[0], samples[2] + 1)]);
        const motion = median([...p.motion.subarray(f0, f1)]);
        const own = usual.get(t.take);
        const like = own ? Math.min(...samples.map((i) => likeness(p.thumbs.subarray(i * THUMB, (i + 1) * THUMB), own))) : null;
        return [{ t, m, p, samples, sharp, motion, like, jolt: joltIn(p, f0, f1), busy: top(p.edges.subarray(f0, f1)) }];
      });
      for (const x of said) {
        const others = said.filter((y) => y !== x);
        const alike = others.filter((y) => x.samples.every((i, k) => samePicture(x.p, i, y.p, y.samples[k])));
        if (alike.length && x.sharp < 0.45 * median(alike.map((y) => y.sharp)) && x.motion <= 1.5 * median(alike.map((y) => y.motion)) + 0.5)
          out.get(x.t.take)!.push({ s: x.m.start, e: x.m.end, what: "soft focus", cost: 0.5 });
        const busy = others.length ? median(others.map((y) => y.busy)) : Infinity;
        if (x.jolt > Math.max(3 * busy, busy + 6)) out.get(x.t.take)!.push({ s: x.m.start, e: x.m.end, what: "camera bump", cost: 0.4 });
        const theirs = others.flatMap((y) => (y.like !== null ? [y.like] : []));
        if (handheld && x.t.setup!.framing === "close" && x.like !== null && theirs.length && x.like < 0.2 && median(theirs) >= 0.5)
          out.get(x.t.take)!.push({ s: x.m.start, e: x.m.end, what: "camera off the actor", cost: 0.5 });
      }
    }
  }
  return out;
}

/** How alike two pictures' 16 by 9 blocks are in shape: their correlation, 1 the same, 0 nothing alike. */
function likeness(x: Float32Array, y: Float32Array): number {
  const n = x.length;
  let [mx, my] = [0, 0];
  for (let k = 0; k < n; k++) [mx, my] = [mx + x[k] / n, my + y[k] / n];
  let [xy, xx, yy] = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    xy += (x[k] - mx) * (y[k] - my);
    xx += (x[k] - mx) ** 2;
    yy += (y[k] - my) ** 2;
  }
  return xy / Math.sqrt(xx * yy || 1);
}

/** Whether two moments show the same picture: their 16 by 9 blocks match in shape and brightness. */
function samePicture(p: Picture, i: number, q: Picture, k: number): boolean {
  const [x, y] = [p.thumbs.subarray(i * THUMB, (i + 1) * THUMB), q.thumbs.subarray(k * THUMB, (k + 1) * THUMB)];
  if (x.length < THUMB || y.length < THUMB) return false;
  const spread = (v: Float32Array, m: number) => Math.sqrt(v.reduce((s, z) => s + (z - m) ** 2, 0) / v.length);
  const [mx, my] = [x.reduce((s, z) => s + z, 0) / THUMB, y.reduce((s, z) => s + z, 0) / THUMB];
  const [sx, sy] = [spread(x, mx), spread(y, my)];
  return likeness(x, y) >= 0.85 && Math.abs(mx - my) <= 0.15 * Math.max(mx, my, 1) && Math.min(sx, sy) >= 0.75 * Math.max(sx, sy);
}

/** The edges' busiest frames between two frames (the 95th percentile). */
function top(edges: Float32Array): number {
  const s = [...edges].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)] ?? 0;
}

/** The biggest jolt between two frames: up to 6 frames, still around it, the middle of the frame moving with the edges. */
function joltIn(p: Picture, f0: number, f1: number): number {
  let biggest = 0;
  for (let f = Math.max(1, f0); f < f1; f++) {
    const peak = p.edges[f];
    if (peak <= biggest || peak < p.edges[f - 1] || peak < (p.edges[f + 1] ?? 0)) continue;
    let [a, b] = [f, f];
    while (a > 1 && p.edges[a - 1] > peak / 2) a--;
    while (b + 1 < p.edges.length && p.edges[b + 1] > peak / 2) b++;
    if (b - a + 1 > 6) continue;
    const around = [...p.edges.subarray(Math.max(1, a - 8), a), ...p.edges.subarray(b + 1, b + 9)];
    if (around.length < 8 || median(around) > 0.35 * peak) continue;
    if (p.middle[f] < 0.5 * peak) continue;
    biggest = peak;
  }
  return biggest;
}
