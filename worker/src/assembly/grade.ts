// Loupe's Color mode (Guy, Oct 6): a note in plain words ("warmer, deeper
// shadows, keep skin natural") becomes a grade, the way a colourist would set
// Resolve's primaries: white balance, exposure, lift / gamma / gain per
// channel, contrast around a mid-grey pivot, saturation, a matte fade and a
// tint in the shadows and the highlights.
//
// Claude reads the note and looks at frames of the cut (as the shoot's LUT
// shows them), sets the numbers, then looks again at the frames as graded and
// adjusts once if they don't yet match the note. The grade is written out as a
// 3D LUT (.cube): the preview is rendered through that file, and the same file
// goes in the Premiere package, so what was approved in the preview is what
// the editor gets. It only moves colours: nothing in the picture is redrawn.

import { writeFile } from "node:fs/promises";
import { dataUri, type FalClient } from "../ai/fal.js";
import { ffmpegPipe } from "./audio.js";
import { frameOf } from "./establishing.js";
import { VISION_ENDPOINT, VISION_MODEL } from "./vision.js";

export type RGB = { r: number; g: number; b: number };
export type Tint = { hue: number; amount: number };

export type Grade = {
  /** Stops of light, -1.5 to 1.5. */
  exposure: number;
  /** Cool (-1) to warm (1). */
  temperature: number;
  /** Green (-1) to magenta (1). */
  tint: number;
  /** Shadows, -0.15 to 0.15 per channel (Resolve's Lift). */
  lift: RGB;
  /** Midtones, -0.3 to 0.3 per channel (Gamma). */
  gamma: RGB;
  /** Highlights, -0.3 to 0.3 per channel (Gain). */
  gain: RGB;
  /** 0.6 (flat) to 1.6 (punchy), around mid grey. */
  contrast: number;
  /** 0 (black and white) to 2. */
  saturation: number;
  /** Lifted, milky blacks: 0 to 0.15. */
  fade: number;
  /** A colour pushed into the shadows / the highlights: hue in degrees, amount 0 to 0.3. */
  shadows: Tint;
  highlights: Tint;
};

export const NEUTRAL: Grade = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  lift: { r: 0, g: 0, b: 0 },
  gamma: { r: 0, g: 0, b: 0 },
  gain: { r: 0, g: 0, b: 0 },
  contrast: 1,
  saturation: 1,
  fade: 0,
  shadows: { hue: 0, amount: 0 },
  highlights: { hue: 0, amount: 0 },
};

/** The grade a note made, for the shoot page and the READ ME. */
export type Look = { note: string; said: string; grade: Grade };

const PIVOT = 0.435; // Resolve's default contrast pivot
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const rgb = (v: unknown, lo: number, hi: number): RGB => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { r: num(o.r, lo, hi, 0), g: num(o.g, lo, hi, 0), b: num(o.b, lo, hi, 0) };
};
const tint = (v: unknown): Tint => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const hue = num(o.hue, -360, 720, 0);
  return { hue: ((hue % 360) + 360) % 360, amount: num(o.amount, 0, 0.3, 0) };
};

/** Any answer as a safe grade: every number kept in its range, anything missing left neutral. */
export function clampGrade(raw: unknown): Grade {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    exposure: num(o.exposure, -1.5, 1.5, 0),
    temperature: num(o.temperature, -1, 1, 0),
    tint: num(o.tint, -1, 1, 0),
    lift: rgb(o.lift, -0.15, 0.15),
    gamma: rgb(o.gamma, -0.3, 0.3),
    gain: rgb(o.gain, -0.3, 0.3),
    contrast: num(o.contrast, 0.6, 1.6, 1),
    saturation: num(o.saturation, 0, 2, 1),
    fade: num(o.fade, 0, 0.15, 0),
    shadows: tint(o.shadows),
    highlights: tint(o.highlights),
  };
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A fully saturated colour of `hue`, less its own brightness: the push a tint adds. */
function hueOffset(hue: number): [number, number, number] {
  const h = hue / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const y = luma(r, g, b);
  return [r - y, g - y, b - y];
}

/** Contrast that keeps black black and white white: a smooth S through the pivot, its slope there `c`. */
function contrastOf(x: number, c: number): number {
  if (c === 1) return x;
  return x < PIVOT ? PIVOT * Math.pow(x / PIVOT, c) : 1 - (1 - PIVOT) * Math.pow((1 - x) / (1 - PIVOT), c);
}

/** One colour (Rec.709, 0-1, as the shoot's LUT shows it) through the grade. */
export function applyGrade(g: Grade, input: [number, number, number]): [number, number, number] {
  // White balance and exposure, in light (not in the picture's gamma), so they behave like a camera's.
  let c = input.map((v) => Math.pow(clamp(v, 0, 1), 2.4)) as [number, number, number];
  const before = luma(...c);
  c = [c[0] * (1 + 0.15 * g.temperature), c[1] * (1 - 0.08 * g.tint), c[2] * (1 - 0.15 * g.temperature)];
  const after = luma(...c);
  const exposure = Math.pow(2, g.exposure) * (after > 0 ? before / after : 1);
  c = c.map((v) => Math.pow(clamp(v * exposure, 0, 1), 1 / 2.4)) as [number, number, number];

  // Lift / gamma / gain, channel by channel, the way Resolve's colour wheels work.
  const keys = ["r", "g", "b"] as const;
  c = c.map((v, i) => {
    const k = keys[i];
    const lifted = (1 + g.gain[k]) * (v + g.lift[k] * (1 - v));
    return Math.pow(clamp(lifted, 0, 1), 1 / (1 + g.gamma[k]));
  }) as [number, number, number];

  c = c.map((v) => contrastOf(v, g.contrast)) as [number, number, number];

  // A colour in the shadows and in the highlights (split toning), each weighted by how dark or bright the pixel is.
  const y = luma(...c);
  const sh = hueOffset(g.shadows.hue);
  const hi = hueOffset(g.highlights.hue);
  const ws = g.shadows.amount * (1 - y) * (1 - y);
  const wh = g.highlights.amount * y * y;
  c = c.map((v, i) => v + sh[i] * ws + hi[i] * wh) as [number, number, number];

  const y2 = luma(...c);
  c = c.map((v) => y2 + (v - y2) * g.saturation) as [number, number, number];
  return c.map((v) => clamp(g.fade + clamp(v, 0, 1) * (1 - g.fade), 0, 1)) as [number, number, number];
}

/** The grade as a 3D LUT (.cube, 33 points a side, red fastest), as Premiere and Resolve read it. */
export function cubeOf(g: Grade, title: string, size = 33): string {
  const out = [`TITLE "${title.replace(/["\n\r]/g, "").slice(0, 80)}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let b = 0; b < size; b++)
    for (let gr = 0; gr < size; gr++)
      for (let r = 0; r < size; r++) {
        const [x, y, z] = applyGrade(g, [r / (size - 1), gr / (size - 1), b / (size - 1)]);
        out.push(`${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
      }
  return `${out.join("\n")}\n`;
}

export const isNeutral = (g: Grade) => JSON.stringify(clampGrade(g)) === JSON.stringify(NEUTRAL);

/** A JPEG through a LUT (or two: the shoot's look first, then the grade), at the size it was. */
export async function throughLuts(ffmpeg: string, jpeg: Buffer, luts: string[], signal?: AbortSignal): Promise<Buffer> {
  const safe = luts.filter((l) => /^[\w./ -]+$/.test(l));
  if (!safe.length) return jpeg;
  return ffmpegPipe(
    ffmpeg,
    ["-v", "error", "-nostdin", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-", "-vf", safe.map((l) => `lut3d=file='${l}'`).join(","), "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "-"],
    jpeg,
    signal,
  );
}

const SCHEMA = [
  "The grade's numbers (leave anything the note doesn't call for at its neutral value):",
  '- "exposure": stops, -1.5 to 1.5 (neutral 0).',
  '- "temperature": -1 cool/blue to 1 warm/orange (neutral 0). 0.3 is a clear but natural shift.',
  '- "tint": -1 green to 1 magenta (neutral 0).',
  '- "lift": shadows, {"r","g","b"} each -0.15 to 0.15 (neutral 0). Negative crushes, positive lifts; unequal values colour the shadows.',
  '- "gamma": midtones, {"r","g","b"} each -0.3 to 0.3 (neutral 0). Positive brightens the mids.',
  '- "gain": highlights, {"r","g","b"} each -0.3 to 0.3 (neutral 0).',
  '- "contrast": 0.6 flat to 1.6 punchy (neutral 1), around mid grey; blacks stay black and whites stay white.',
  '- "saturation": 0 black and white to 2 (neutral 1).',
  '- "fade": 0 to 0.15 (neutral 0): milky, lifted blacks, a matte film look.',
  '- "shadows" and "highlights": {"hue": degrees (0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 200 teal, 240 blue, 300 magenta), "amount": 0 to 0.3} (neutral amount 0): split toning, like teal shadows and orange highlights.',
].join("\n");

export function gradePrompt(note: string): string {
  return [
    "These are frames from across a short dialogue scene, as its first assembly plays it (the shoot's camera LUT already applied).",
    `The director's note on the colour: "${note}"`,
    "Grade it the way a careful colourist would in DaVinci Resolve: do what the note asks, keep skin tones believable unless the note says otherwise, keep detail in the shadows and highlights, and don't overdo it. Small numbers go a long way.",
    "",
    SCHEMA,
    "",
    'Answer with JSON only: {"grade": {...the numbers...}, "said": one short sentence, in plain words a director would use, saying what you did (like "Warmer, with deeper shadows; skin kept natural.")}',
  ].join("\n");
}

export function checkPrompt(note: string, grade: Grade): string {
  return [
    `The director's note on the colour: "${note}"`,
    "The images come in pairs, frame by frame: first as it was, then with this grade:",
    JSON.stringify(grade),
    "Look at the graded frames. If they do what the note asks without spoiling skin or losing detail, answer with the same grade. If not (too much, too little, the wrong direction, skin gone strange), answer with the grade corrected.",
    "",
    SCHEMA,
    "",
    'Answer with JSON only: {"grade": {...the numbers...}, "said": one short sentence, in plain words, saying what the grade does}',
  ].join("\n");
}

export function parseGradeAnswer(output: string): { grade: Grade; said: string } | null {
  try {
    const parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as { grade?: unknown; said?: unknown };
    if (!parsed.grade || typeof parsed.grade !== "object") return null;
    const said = typeof parsed.said === "string" ? parsed.said.trim().slice(0, 200) : "";
    return { grade: clampGrade(parsed.grade), said };
  } catch {
    return null;
  }
}

async function ask(fal: FalClient, prompt: string, images: Buffer[], signal?: AbortSignal) {
  const answer = await fal.run<{ output?: string }>(
    VISION_ENDPOINT,
    {
      model: VISION_MODEL,
      system_prompt: "You are a senior film colourist. You set grades with numbers and answer with JSON only.",
      prompt,
      image_urls: images.map((f) => dataUri(f, "image/jpeg")),
      // Claude Sonnet 5.5 on fal only answers with its reasoning on (fal answers 400 otherwise).
      reasoning: true,
      max_tokens: 4000,
    },
    { signal },
  );
  return parseGradeAnswer(answer.output ?? "");
}

/**
 * The grade for a note: Claude sets it from `frames` (JPEGs of the cut, as
 * the shoot's LUT shows them), looks at the frames graded, and corrects it
 * once if needed. Writes the .cube to `cube` and returns the look; throws if
 * no grade could be read from the answers.
 */
export async function gradeFor(opts: {
  fal: FalClient;
  ffmpeg: string;
  note: string;
  frames: Buffer[];
  cube: string;
  title: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<Look> {
  const first = await ask(opts.fal, gradePrompt(opts.note), opts.frames, opts.signal);
  if (!first) throw new Error("Claude's grade couldn't be read.");
  await writeFile(opts.cube, cubeOf(first.grade, opts.title));
  let look: Look = { note: opts.note, said: first.said, grade: first.grade };
  try {
    const graded = await Promise.all(opts.frames.map((f) => throughLuts(opts.ffmpeg, f, [opts.cube], opts.signal)));
    const pairs = opts.frames.flatMap((f, i) => [f, graded[i]]);
    const second = await ask(opts.fal, checkPrompt(opts.note, first.grade), pairs, opts.signal);
    if (second && JSON.stringify(second.grade) !== JSON.stringify(first.grade)) {
      await writeFile(opts.cube, cubeOf(second.grade, opts.title));
      look = { note: opts.note, said: second.said || first.said, grade: second.grade };
      opts.log?.("Grade: corrected after looking at it.");
    }
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    opts.log?.(`Grade: kept the first one, no second look (${(error as Error).message}).`);
  }
  return look;
}

/**
 * Frames to grade from: up to four shots spread across the cut (each a
 * different take where it can be), from the takes' previews, through the
 * shoot's LUT when the previews don't carry it yet.
 */
export async function framesOfCut(opts: {
  ffmpeg: string;
  shots: { take: string; in: number; out: number; kind: string }[];
  previews: Map<string, string>;
  shootLut: string | null;
  signal?: AbortSignal;
}): Promise<Buffer[]> {
  const shots = opts.shots.filter((p) => p.kind === "shot" && opts.previews.has(p.take));
  const picked: typeof shots = [];
  for (const k of [0.15, 0.4, 0.65, 0.9]) {
    const at = Math.min(shots.length - 1, Math.floor(k * shots.length));
    const p = shots.find((s, i) => i >= at && !picked.includes(s) && !picked.some((q) => q.take === s.take)) ?? shots[at];
    if (p && !picked.includes(p)) picked.push(p);
  }
  return Promise.all(
    picked.map(async (p) => {
      const frame = await frameOf(opts.ffmpeg, opts.previews.get(p.take)!, (p.in + p.out) / 2, opts.signal);
      return opts.shootLut ? throughLuts(opts.ffmpeg, frame, [opts.shootLut], opts.signal) : frame;
    }),
  );
}
