// Works out what the engine needs to know about a scene before it can cut:
// which script it is (one from the library, or the lines worked out from the
// takes), who each take is on and how close, and which part the client plays.
//
// The picture says who each take is on (vision.ts; the first take is taken as
// the lead's, who tends to be filmed first). The sound says whose voice is
// whose: a line is louder in the takes of the actor who says it, at least in
// one actor's takes (coverage.ts).

import path from "node:path";
import { ffmpegPipe } from "./audio.js";
import { coCluster, frameSignature, framingsFor, lineLevel, offMicTalk, onCameraSides } from "./coverage.js";
import { consensusSentences, scriptFrom, type Sentence } from "./derive.js";
import { alignTakes, coverageOf, type Framing, type Setup, type Take, type TakeInput } from "./engine.js";
import { buildUnits, isFound, mean, median, type ScriptLine, type Unit, type Word } from "./text.js";
import type { Seen } from "./vision.js";

export type SceneTake = {
  take: string;
  path: string;
  length: number | null;
  timecode: string | null;
  words: Word[];
  /** The take's sound, mono, at `rate`. */
  audio: Float32Array;
  /** A video file of the take, for its frames (the web preview is plenty). */
  video: string;
};

export type LibraryScript = { id: number; title: string; lines: ScriptLine[]; heading?: string | null };

export type Corrections = {
  scriptId?: number | null;
  client?: string | null;
  coverage?: Record<string, Setup | null> | null;
};

export type SceneFound = {
  script: { id: number | null; title: string; heading: string | null; lines: ScriptLine[]; fromTakes: boolean; match: number };
  roles: string[];
  client: string;
  units: Unit[];
  /** Every take lined up against the script, with its setup (after any corrections). */
  takes: Take[];
  /** What was worked out per take, before corrections (null: not usable, "insert": an insert shot). */
  found: Record<string, Setup | "insert" | null>;
  /** How it was worked out, for the log. */
  how: { coverage: "picture" | "sound" };
};

const asInput = (t: SceneTake): TakeInput => ({ take: t.take, path: t.path, length: t.length, timecode: t.timecode, setup: null, words: t.words });

/** How well a script fits the takes: the share of its sentences found, averaged over the better half of the takes. */
export function scriptMatch(lines: ScriptLine[], takes: SceneTake[]): number {
  const aligned = alignTakes(buildUnits(lines), takes.map(asInput));
  const shares = aligned.map(coverageOf).sort((a, b) => b - a);
  const better = shares.slice(0, Math.max(1, Math.ceil(shares.length / 2)));
  return better.length ? mean(better) : 0;
}

/** Each found line's level in each take, centred on the take's median line: levels[u][t]. */
function levelsOf(aligned: Take[], takes: SceneTake[], rate: number): (number | null)[][] {
  const lines = aligned[0]?.matches.length ?? 0;
  const raw = Array.from({ length: lines }, (_, u) =>
    aligned.map((a, t) => {
      const m = a.matches[u];
      return isFound(m, 0.6) ? lineLevel(takes[t].audio, rate, m.start, m.end) : null;
    }),
  );
  for (let t = 0; t < aligned.length; t++) {
    const column = raw.map((r) => r[t]).filter((v): v is number => v !== null);
    if (!column.length) continue;
    const mid = median(column);
    for (const row of raw) if (row[t] !== null) row[t]! -= mid;
  }
  return raw;
}

/** Per line: how much louder it is in A's takes than in B's (dB), null with no evidence. */
function contrast(levels: (number | null)[][], faces: ("A" | "B" | null)[]): (number | null)[] {
  return levels.map((row) => {
    const side = (f: "A" | "B") => row.filter((v, t) => v !== null && faces[t] === f) as number[];
    const a = side("A");
    const b = side("B");
    if (!a.length && !b.length) return null;
    return (a.length ? mean(a) : 0) - (b.length ? mean(b) : 0);
  });
}

/** Splits numbers into a high and a low group (1-D two-means); null if they don't really split. */
export function twoGroups(values: number[]): { threshold: number; gap: number } | null {
  const s = [...values].sort((a, b) => a - b);
  if (s.length < 2) return null;
  let best: { cost: number; k: number } | null = null;
  for (let k = 1; k < s.length; k++) {
    const lo = s.slice(0, k);
    const hi = s.slice(k);
    const ml = mean(lo);
    const mh = mean(hi);
    const cost = lo.reduce((c, v) => c + (v - ml) ** 2, 0) + hi.reduce((c, v) => c + (v - mh) ** 2, 0);
    if (!best || cost < best.cost) best = { cost, k };
  }
  const lo = s.slice(0, best!.k);
  const hi = s.slice(best!.k);
  return { threshold: (lo.at(-1)! + hi[0]) / 2, gap: mean(hi) - mean(lo) };
}

/**
 * Who says each line (1: A, -1: B, null: no evidence), from how much louder
 * it is in A's takes than in B's (`d`, dB; `fit` marks the lines heard often
 * enough to fit on), and how long after the line before it starts (`gap`, s).
 * The split falls midway between the two actors' typical lines. A line with
 * no clear evidence either way (an actor shouting off screen is as loud as the
 * calm one on camera) said without a breath after the line before (under
 * 0.2 s: a new speaker takes longer), where the two actors' lines meet,
 * carries on the line before (shoot 1053, Oct 5: the
 * husband's "I mean, I never drive fast enough to get pulled over" went to the
 * doctor). Between two lines of one actor it's a reply, and the levels decide.
 */
export function whoSays(d: (number | null)[], fit: boolean[], gap: (number | null)[]): (1 | -1 | null)[] {
  const fitted = d.filter((v, u): v is number => v !== null && fit[u]).map((v) => Math.max(-15, Math.min(15, v)));
  const split = twoGroups(fitted);
  if (!split) return d.map(() => null);
  const lo = fitted.filter((v) => v < split.threshold);
  const hi = fitted.filter((v) => v >= split.threshold);
  const mid = (mean(lo) + mean(hi)) / 2;
  const speaker = d.map((v) => (v === null ? null : v >= mid ? 1 : -1)) as (1 | -1 | null)[];
  const unclear = d.map((v) => v !== null && Math.abs(v - mid) < 0.15 * split.gap);
  for (let i = 1; i < speaker.length; i++) {
    if (!unclear[i] || speaker[i - 1] === null || gap[i] === null || gap[i]! >= 0.2) continue;
    const next = speaker.findIndex((s, k) => k > i && s !== null && !unclear[k]);
    if (next >= 0 && speaker[next] !== speaker[i - 1]) speaker[i] = speaker[i - 1];
  }
  return speaker;
}

/**
 * Five frames from across a take, side by side in one picture, for the vision
 * model: one frame can catch a handheld camera as it swings to the other actor
 * (shoot 1051's T055, on Frank, was taken for Jimmy's, Oct 5).
 */
async function stripOf(ffmpeg: string, video: string, times: number[], file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const inputs = times.flatMap((t) => ["-ss", Math.max(0, t).toFixed(2), "-i", video]);
    const scaled = times.map((_, i) => `[${i}:v]scale=288:-2,setsar=1[f${i}]`).join(";");
    const graph = `${scaled};${times.map((_, i) => `[f${i}]`).join("")}hstack=inputs=${times.length}[strip]`;
    await ffmpegPipe(ffmpeg, ["-v", "error", "-y", "-nostdin", ...inputs, "-filter_complex", graph, "-map", "[strip]", "-frames:v", "1", "-q:v", "4", file], undefined, signal);
    return true;
  } catch {
    return false;
  }
}

export async function workOutScene(opts: {
  ffmpeg: string;
  takes: SceneTake[];
  rate: number;
  library: LibraryScript[];
  workDir: string;
  /** The vision model, if there is one (null answer: the sound decides). */
  look?: (stills: { label: string; file: string }[]) => Promise<Record<string, Seen> | null>;
  corrections?: Corrections;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<SceneFound> {
  const { takes, rate, library, corrections = {}, signal, log = () => {} } = opts;

  // 1. The script: the one asked for, else the library's best fit, else the lines said in the takes.
  let script: SceneFound["script"] | null = null;
  const asked = corrections.scriptId ? library.find((s) => s.id === corrections.scriptId) : undefined;
  if (asked) script = { id: asked.id, title: asked.title, heading: asked.heading ?? null, lines: asked.lines, fromTakes: false, match: scriptMatch(asked.lines, takes) };
  else {
    const fits = library.map((s) => ({ s, match: scriptMatch(s.lines, takes) })).sort((a, b) => b.match - a.match);
    if (fits[0] && fits[0].match >= 0.4) {
      script = { id: fits[0].s.id, title: fits[0].s.title, heading: fits[0].s.heading ?? null, lines: fits[0].s.lines, fromTakes: false, match: fits[0].match };
      log(`Script: ${fits[0].s.title} (${Math.round(fits[0].match * 100)}% of its lines found).`);
    }
  }
  let sentences: Sentence[] = [];
  if (!script) {
    sentences = consensusSentences(takes.map((t) => t.words)).sentences;
    if (sentences.length < 2) throw new Error("Couldn't make out the scene's lines in the takes.");
  }
  const firstUnits: Unit[] = script
    ? buildUnits(script.lines)
    : sentences.map((s, i) => ({ who: "?", text: s.text, speechStart: true, actionBefore: "", speech: i }));
  const firstAligned = alignTakes(firstUnits, takes.map(asInput));
  const usable = firstAligned.map((a) => coverageOf(a) >= 0.3);

  // 2. Who each take is on, from the picture.
  let seen: Record<string, Seen> | null = null;
  if (opts.look) {
    const stills: { label: string; file: string }[] = [];
    for (const [t, a] of firstAligned.entries()) {
      const [from, to] = a.sceneStart !== null && a.sceneEnd !== null ? [a.sceneStart, a.sceneEnd] : [0, takes[t].length ?? 10];
      const times = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => from + (to - from) * f);
      const file = path.join(opts.workDir, `still-${a.take}.jpg`);
      if (await stripOf(opts.ffmpeg, takes[t].video, times, file, signal)) stills.push({ label: a.take, file });
    }
    try {
      seen = await opts.look(stills);
    } catch (error) {
      if (signal?.aborted) throw error;
      log(`The vision model couldn't log the coverage (${(error as Error).message}); going by the sound.`);
    }
  }
  const faces: ("A" | "B" | null)[] = firstAligned.map((a, t) => {
    const who = seen?.[a.take]?.who;
    return usable[t] && (who === "A" || who === "B") ? who : null;
  });
  const inserts = new Set(firstAligned.filter((a) => seen?.[a.take]?.who === "insert").map((a) => a.take));
  const byPicture = Boolean(seen) && faces.includes("A") && faces.includes("B");

  // 3. Without a script, who says each sentence: lines louder in one actor's takes are that actor's.
  if (!script) {
    const levels = levelsOf(firstAligned, takes, rate);
    let speaker: (1 | -1 | null)[];
    if (byPicture) {
      // Fitted on lines heard in at least two takes of each actor (a word heard once is noise), capped at
      // ±15 dB (a shout), then applied to every line.
      const d = contrast(levels, faces);
      const heard = levels.map((row) => (["A", "B"] as const).every((f) => row.filter((v, t) => v !== null && faces[t] === f).length >= 2));
      const gaps = firstAligned[0].matches.map((_, i) => {
        if (i === 0) return null;
        const g = firstAligned.flatMap((a) => {
          const [m, before] = [a.matches[i], a.matches[i - 1]];
          return isFound(m) && isFound(before) && m.start >= before.end - 0.3 ? [m.start - before.end] : [];
        });
        return g.length ? median(g) : null;
      });
      speaker = whoSays(d, heard, gaps);
    } else {
      speaker = coCluster(levels).speaker as (1 | -1)[];
    }
    // A short line nobody could measure ("What?") answers the line before it.
    speaker = speaker.map((s, i, all) => s ?? (i > 0 && all[i - 1] ? (-all[i - 1]! as 1 | -1) : 1));
    for (let i = 1; i < speaker.length; i++) if (speaker[i] === null) speaker[i] = (-(speaker[i - 1] ?? 1)) as 1 | -1;
    // The client is A, the subject of the first take; by sound alone, whoever is on camera first.
    let clientSide: 1 | -1 = 1;
    if (!byPicture) {
      const { onCamera } = coCluster(levels, speaker as number[]);
      clientSide = onCameraSides(onCamera.map((s, t) => (usable[t] ? s : null))).find((s) => s !== null) ?? 1;
    }
    const lines = scriptFrom(sentences, speaker as number[], clientSide);
    script = { id: null, title: "", heading: null, lines, fromTakes: true, match: 0 };
    script.match = scriptMatch(lines, takes);
    log(`No script matched: ${sentences.length} sentences in ${lines.length} speeches worked out from the takes.`);
  }

  // 4. Which part each actor plays, and so who each take is on.
  const units = buildUnits(script.lines);
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u.who, (counts.get(u.who) ?? 0) + 1);
  const roles = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([r]) => r);
  if (roles.length < 2) throw new Error("The scene needs two speaking parts for a first assembly.");
  const [a, b] = roles;
  const aligned = alignTakes(units, takes.map(asInput));
  const levels = levelsOf(aligned, takes, rate);
  let who: (string | null)[];
  if (byPicture) {
    const d = contrast(levels, faces);
    const avg = (role: string) => {
      const values = d.filter((v, u) => v !== null && units[u].who === role) as number[];
      return values.length ? mean(values) : 0;
    };
    // A's lines are the ones louder in A's takes.
    const [roleA, roleB] = avg(a) >= avg(b) ? [a, b] : [b, a];
    who = faces.map((f) => (f === "A" ? roleA : f === "B" ? roleB : null));
  } else {
    const { onCamera } = coCluster(
      levels,
      units.map((u) => (u.who === a ? 1 : u.who === b ? -1 : 0)),
    );
    const sides = onCameraSides(onCamera.map((s, t) => (usable[t] && !inserts.has(aligned[t].take) ? s : null)));
    who = sides.map((s) => (s === null ? null : s === 1 ? a : b));
  }

  // 5. How close: within each actor's run of takes, the medium shot comes first, then the close-up. (The vision
  //    model is sure of who a take is on, not of which takes share a setup, so the frames decide that.)
  const signatures = await Promise.all(
    aligned.map(async (x, t) => {
      if (!who[t] || x.sceneStart === null || x.sceneEnd === null) return null;
      const span = x.sceneEnd - x.sceneStart;
      return frameSignature(opts.ffmpeg, takes[t].video, [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => x.sceneStart! + span * f), signal);
    }),
  );
  const framings = framingsFor(who.map((w, t) => ({ who: w, signature: signatures[t] })));
  const found: Record<string, Setup | "insert" | null> = {};
  aligned.forEach((x, t) => (found[x.take] = inserts.has(x.take) ? "insert" : who[t] ? { who: who[t]!, framing: framings[t] ?? ("medium" as Framing) } : null));

  // 6. The lead (the engine's "client"): the first take's actor, unless "Whose scene is it?" says otherwise.
  const firstOn = who.find((w) => w !== null) ?? a;
  const client = corrections.client && roles.includes(corrections.client) ? corrections.client : firstOn;
  const fixed = corrections.coverage ?? {};
  for (const x of aligned) {
    const f = found[x.take];
    x.setup = x.take in fixed ? fixed[x.take] : f && f !== "insert" ? f : null;
  }
  log(`Coverage (${byPicture ? "picture" : "sound"}): ${aligned.map((x) => `${x.take} ${x.setup ? `${x.setup.who} ${x.setup.framing}` : found[x.take] === "insert" ? "insert" : "-"}`).join(", ")}. Client plays ${client}.`);

  // 7. Talk that isn't a line and was picked up off mic (the other actor's ad-libs): kept out of the cut's sound.
  aligned.forEach((x, t) => (x.offMic = offMicTalk(x, units, takes[t].audio, rate)));
  const marked = aligned.filter((x) => x.offMic.length);
  if (marked.length) log(`Off mic, not in the lines: ${marked.map((x) => `${x.take} ${x.offMic.length}`).join(", ")}.`);
  return { script, roles, client, units, takes: aligned, found, how: { coverage: byPicture ? "picture" : "sound" } };
}
