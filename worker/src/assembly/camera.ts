// The first assembly's camera moves for comedies (Guy, Oct 2: "for comedy can
// we make a handheld move automatically?"): every shot drifts, bobs and rolls a
// little, like a camera on an operator's shoulder, with the slow push-ins
// riding on top and a quick zoom on the scene's biggest laugh. A move is worked
// out once, as a few slow, layered waves per shot, and drawn twice: by FFmpeg
// for the preview, and as Basic Motion keyframes for Premiere. Dramas and
// thrillers keep the steady camera (finish.ts).

import { FPS } from "./engine.js";
import { seeded } from "./audio.js";

/** Pushed in a little, so the frame can drift and roll without an edge showing. */
export const HANDHELD_ZOOM = 1.05;
/** The quick zoom on the biggest laugh: to 115%, in 7 frames, settling at the end. */
export const SNAP_SCALE = 1.15;
export const SNAP_FRAMES = 7;

/** One wave: its size, how many times a second it goes round, and where it starts. */
type Wave = [amplitude: number, hertz: number, phase: number];

/** A shot's handheld move: sideways and up-down (fractions of the frame's width and height) and roll (degrees). */
export type Shake = { x: Wave[]; y: Wave[]; roll: Wave[] };

/** How the zoom changes over a shot: none, a slow push-in to `to` by its end, or a quick one starting `at` seconds in. */
export type Zoom = { kind: "none" } | { kind: "slow"; to: number; seconds: number } | { kind: "snap"; to: number; at: number };

/**
 * A handheld move: slow sway (about every 6-10 seconds), a breathing bob
 * (every 2-3 seconds) and a little hand tremor (about once a second), each a
 * different size and speed per shot so no two shots move alike. At most about
 * 1% sideways, 0.9% up-down and 0.35° of roll: inside what HANDHELD_ZOOM hides.
 */
export function shakeFor(seed: number): Shake {
  const random = seeded(seed);
  const between = (low: number, high: number) => low + (high - low) * random();
  const waves = (size: number, bands: [share: number, low: number, high: number][]): Wave[] =>
    bands.map(([share, low, high]) => [size * share, between(low, high), between(0, 2 * Math.PI)]);
  return {
    x: waves(0.01, [[0.55, 0.1, 0.18], [0.3, 0.3, 0.45], [0.15, 0.9, 1.4]]),
    y: waves(0.009, [[0.55, 0.12, 0.2], [0.3, 0.35, 0.5], [0.15, 1.0, 1.5]]),
    roll: waves(0.35, [[0.65, 0.08, 0.15], [0.35, 0.25, 0.4]]),
  };
}

const wave = (waves: Wave[], t: number) => waves.reduce((sum, [a, f, p]) => sum + a * Math.sin(2 * Math.PI * f * t + p), 0);
/** Eased so a quick zoom snaps out and settles. */
const settle = (u: number) => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3;

export function zoomAt(zoom: Zoom, t: number): number {
  if (zoom.kind === "slow") return 1 + (zoom.to - 1) * Math.min(1, Math.max(0, t / zoom.seconds));
  if (zoom.kind === "snap") return 1 + (zoom.to - 1) * settle(((t - zoom.at) * FPS) / SNAP_FRAMES);
  return 1;
}

/** Where the camera is `t` seconds into a handheld shot: drift (fractions of the frame), roll (degrees), scale. */
export function cameraAt(shake: Shake, zoom: Zoom, t: number): { x: number; y: number; roll: number; scale: number } {
  return { x: wave(shake.x, t), y: wave(shake.y, t), roll: wave(shake.roll, t), scale: HANDHELD_ZOOM * zoomAt(zoom, t) };
}

// ─── The preview: FFmpeg's perspective filter, recomputed every frame ─────────

const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
/** Seconds into the shot, from the frame count (perspective knows frames, not time). */
const T = `(in*${n(1 / FPS)})`;
const waveExpr = (waves: Wave[]) => waves.map(([a, f, p]) => `${n(a)}*sin(${n(2 * Math.PI * f)}*${T}+${n(p)})`).join("+");

function zoomExpr(zoom: Zoom): string {
  if (zoom.kind === "slow") return `(1+${n(zoom.to - 1)}*min(${T}/${n(zoom.seconds)},1))`;
  if (zoom.kind === "snap") return `(1+${n(zoom.to - 1)}*(1-pow(1-clip((${T}-${n(zoom.at)})*${n(FPS / SNAP_FRAMES)},0,1),3)))`;
  return "1";
}

/**
 * The handheld move as one FFmpeg filter: the corners of the part of the
 * picture the camera sees (smaller by the zoom, shifted by the drift, turned
 * by the roll) are pulled out to the frame's corners, smoothly, every frame.
 */
export function handheldFilter(shake: Shake, zoom: Zoom, width: number, height: number): string {
  const z = `(${n(HANDHELD_ZOOM)}*${zoomExpr(zoom)})`;
  const cx = `(${n(width / 2)}+${n(width)}*(${waveExpr(shake.x)}))`;
  const cy = `(${n(height / 2)}+${n(height)}*(${waveExpr(shake.y)}))`;
  const a = `((${waveExpr(shake.roll)})*${n(Math.PI / 180)})`;
  const hw = `(${n(width / 2)}/${z})`;
  const hh = `(${n(height / 2)}/${z})`;
  // A corner's offset from the centre (sx, sy are -1 or 1), turned by the roll.
  const corner = (sx: number, sy: number) => [
    `${cx}+${sx}*${hw}*cos(${a})-${sy}*${hh}*sin(${a})`,
    `${cy}+${sx}*${hw}*sin(${a})+${sy}*${hh}*cos(${a})`,
  ];
  const [x0, y0] = corner(-1, -1);
  const [x1, y1] = corner(1, -1);
  const [x2, y2] = corner(-1, 1);
  const [x3, y3] = corner(1, 1);
  const q = (e: string) => `'${e}'`;
  return `perspective=x0=${q(x0)}:y0=${q(y0)}:x1=${q(x1)}:y1=${q(y1)}:x2=${q(x2)}:y2=${q(y2)}:x3=${q(x3)}:y3=${q(y3)}:interpolation=cubic:eval=frame`;
}

// ─── Premiere: Basic Motion keyframes ─────────────────────────────────────────

/** Keyframes every few frames are plenty for moves this slow; Premiere draws the frames between. */
export const KEY_EVERY = 3;

export type MotionKey = { frame: number; scale: number; rotation: number; x: number; y: number };

/**
 * The move as Premiere keyframes over a clip `frames` long: Scale (percent),
 * Rotation (degrees) and Center (fractions of the frame from its middle). The
 * picture moves the opposite way to the camera, so the signs flip.
 */
export function handheldKeys(shake: Shake, zoom: Zoom, frames: number): MotionKey[] {
  const keys: MotionKey[] = [];
  const at = new Set<number>();
  for (let f = 0; f < frames; f += KEY_EVERY) at.add(f);
  at.add(Math.max(0, frames - 1));
  if (zoom.kind === "snap") {
    // The quick zoom's own frames, so Premiere's version snaps as sharply as the preview's.
    const start = Math.round(zoom.at * FPS);
    for (let f = start; f <= start + SNAP_FRAMES; f++) if (f >= 0 && f < frames) at.add(f);
  }
  for (const frame of [...at].sort((p, q) => p - q)) {
    const c = cameraAt(shake, zoom, frame / FPS);
    keys.push({
      frame,
      scale: Math.round(c.scale * 1000) / 10,
      rotation: Math.round(-c.roll * 1000) / 1000,
      x: Math.round(-c.x * c.scale * 100000) / 100000,
      y: Math.round(-c.y * c.scale * 100000) / 100000,
    });
  }
  return keys;
}
