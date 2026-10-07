// The first assembly's editing brain (Guy's idea, Oct 1 2026), ported from the
// pilot's assemble.py, which was tested on three real scenes. Given every take
// lined up against the script, it cuts the scene the way an assistant editor
// cuts single-camera coverage: a run of blocks, each a stretch of one take
// (picture and sound together, so lips stay in sync), picked with a
// shortest-path search where each line costs less from a take where it was
// said well, in the framing the plan wants, and every cut has a price.
//
// Editing rules (Guy's notes): J/L cuts between the actors, natural pauses
// kept, no jump cuts (two shots of the same actor never meet; a push-in hides
// under a reaction), and reaction shots kept scarce. Oct 5: never a slate (or
// a restart); every line heard from its speaker's own take, with the boom on
// them; and the edit serves the story, not the client: whoever speaks is seen,
// and the other actor is seen taking in the lines where the scene peaks.

import { sceneStart as sceneStartIndex } from "./derive.js";
import { alignTakeWords, buildUnits, isFound, matchingBlocks, median, norm, pyRound, takeWords, tokens, type Match, type ScriptLine, type Unit, type Word } from "./text.js";

export const FPS = 24000 / 1001;

export type Framing = "medium" | "close";
export type Setup = { who: string; framing: Framing };

/** A take as the engine needs it. `take` is a short label ("T003"), `path` where it sits in the shoot folder. */
export type TakeInput = { take: string; path: string; length: number | null; timecode: string | null; setup: Setup | null; words: Word[] };

export type Take = {
  take: string;
  path: string;
  length: number;
  timecode: string | null;
  setup: Setup | null;
  matches: Match[];
  /** What was said before the scene started and after it ended (slates, "action", the director's words). */
  before: string;
  after: string;
  sceneStart: number | null;
  sceneEnd: number | null;
  /** When "action" was called before the scene, and "cut" after it. */
  action: number | null;
  cut: number | null;
  /** The picture is clean from here on: the slate and the crew's calls are over (Guy, Oct 5: "Never show a slating"). */
  cleanFrom: number;
  /**
   * Talk between the lines that isn't in the script (a flubbed line and its
   * restart, a new slate, the director's notes), as [start, end] times:
   * nothing in the cut runs into it.
   */
  stray: [number, number][];
  /** Every word heard in the take (the lines' `j0`/`j1` count these): one of a line's words, and the end of a sentence. */
  words: { s: number; e: number; t: string; inLine: boolean; stop: boolean }[];
  /**
   * Talk picked up off mic that isn't one of the scene's lines: the other
   * actor's ad-libs, told apart by how they sound (offMicTalk, in coverage.ts).
   * Muted wherever a shot of this take runs over them.
   */
  offMic: [number, number][];
  /**
   * Moments not to use (Guy, Oct 5: what lazy editors use anyway): soft focus
   * or a bumped camera (picture.ts). Each costs a take the lines it falls in,
   * and a reaction never shows one.
   */
  flaws: { s: number; e: number; what: string; cost: number }[];
};

export type Score = { q: number; why: string[]; complete: number };
type Want = { mode: "on" | "listening"; who: string; framing: Framing };
/** `patch`: a quick interjection seen on the listener and heard from the speaker's own take. */
type Plan = { want: Want; duration: number; firm: boolean; push: boolean; patch: boolean };
export type Span = { in: number; out: number; recIn: number; recOut: number };
export type Alternate = { take: string; in: number; out: number };
export type Block = {
  take: string;
  first: number;
  last: number;
  audio: Span;
  picture: Span;
  onCamera: string;
  framing: Framing;
  cutAfter?: { kind: "straight" | "J" | "L"; seconds: number };
  alternates: Alternate[];
  /**
   * Lines said off camera in this take, heard from their speaker's own take
   * instead (Guy, Oct 5: "Always pull the CLEAN audio from the boom for any
   * actor saying their lines OFF camera").
   */
  patches: AudioEdit[];
  /**
   * Stretches of this block's sound (record time, whole frames) that stay
   * silent: the other actor heard off mic, saying a line the cut has from
   * their own take, or an ad-lib (Guy, Oct 5: "the audio of him saying
   * 'five minutes' ad-libbed doesn't have the mic on him"). The room tone
   * carries on under them.
   */
  mutes: [number, number][];
};
export type Piece = Span & { take: string; kind: "shot" | "reaction"; lines: [number, number]; alternates: Alternate[]; why?: string };
export type AudioEdit = Span & { take: string };

/**
 * What a director's notes to Loupe ask of the cut (Oct 6): a take for a line,
 * more or fewer reactions, tighter or looser cuts, and how each performance
 * plays from watching it (performance.ts).
 */
export type Steer = {
  picks?: { line: string; take: string }[];
  reactions?: "more" | "fewer";
  pace?: "tighter" | "looser";
  performance?: Record<string, { bonus: number; note: string }>;
};

const lineKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
/** The same line of the script, however its punctuation or spacing came out. */
export const sameLine = (a: string, b: string) => lineKey(a) === lineKey(b);

export type Cut = {
  title: string;
  client: string;
  partner: string;
  seconds: number;
  fps: number;
  units: Unit[];
  takes: Take[];
  scores: Record<string, Score>;
  blocks: Block[];
  video: Piece[];
  audio: AudioEdit[];
  /** Lines missing from most takes (cut on the day), left out. */
  dropped: string[];
  /** Where two shots of the same actor still meet (should be none). */
  jumps: number[];
};

const PRAISE = /\b(great|awesome|wow|love|perfect|beautiful|nice|good|like that|thats it|thats the one|amazing)\b/;
const AGAIN = /\b(again|one more|reset|back to one|go back|pick it up)\b/;
const MOVES = /\b(moves|steps|sits|stands|walks|reaches|places|slides|lifts|backing|hugs|enters|jumps up|tower)\b/i;
/** Someone coming in: a scene that opens on it shows it, rather than a first line heard over the exterior. */
const ENTERS =
  /\b(enters|arrives|bursts|barges|(walks|comes|strides|steps|rushes|runs|marches|struts|hurries|wanders|saunters|sweeps|breezes|slips|sneaks|charges|stumbles|strolls|races|dashes|storms) in(to)?)\b/i;

const r3 = (x: number) => pyRound(x, 3);
export const frames = (seconds: number) => pyRound(seconds * FPS);
const start = (m: Match) => (m as Extract<Match, { start: number }>).start;
const end = (m: Match) => (m as Extract<Match, { start: number }>).end;

/** Whisper sometimes loops on silence ("jump jump jump ..."): keeps one of each repeat. */
export function collapseLoops(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (out.length >= 1 && out.at(-1) === w) continue;
    if (out.length >= 2) {
      const ahead = words.slice(out.length, out.length + 2);
      if (ahead.length === 2 && out.at(-2) === ahead[0] && out.at(-1) === ahead[1]) continue;
    }
    out.push(w);
  }
  return out.join(" ");
}

const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");

/** Every take lined up against the script's sentences. */
export function alignTakes(units: Unit[], inputs: TakeInput[]): Take[] {
  return inputs.map((input) => {
    const words = takeWords(input.words);
    const { matches, inLine: mapped } = alignTakeWords(units, words);
    // Where Whisper ends a sentence (its last token of a word that ends in . ? or !).
    const stops = input.words.flatMap((w) => tokens(w.w).map((_, k, all) => k === all.length - 1 && /[.?!]["')\]]*$/.test(w.w.trim())));
    const hits = matches.filter((m) => isFound(m)) as Extract<Match, { start: number }>[];
    const first = hits.length ? Math.min(...hits.map((m) => m.j0)) : null;
    const last = hits.length ? Math.max(...hits.map((m) => m.j1)) : null;
    const before = (first !== null ? words.slice(0, first) : words).map((w) => w.t).join(" ");
    const after = last !== null ? words.slice(last + 1).map((w) => w.t).join(" ") : "";
    const sceneStart = first !== null ? words[first].s : null;
    const sceneEnd = last !== null ? words[last].e : null;
    const s0 = sceneStart ?? 0;
    const e0 = sceneEnd ?? 0;
    const actions = input.words.filter((w) => bare(w.w) === "action" && w.s < s0).map((w) => w.s);
    const cuts = input.words.filter((w) => bare(w.w) === "cut" && w.s > e0).map((w) => w.s);
    // Half a second after the slate and the crew's last call ("Action."), or after "action" itself.
    const opened = sceneStartIndex(input.words);
    let cleanFrom = opened > 0 ? input.words[opened - 1].e + 0.5 : 0;
    if (actions.length) cleanFrom = Math.max(cleanFrom, Math.max(...actions) + 0.8);
    // Three or more words in a row between the lines that aren't in them.
    const inLine = new Array<boolean>(words.length).fill(false);
    for (const m of hits) for (let j = m.j0; j <= m.j1; j++) inLine[j] = true;
    const stray: [number, number][] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 3) stray.push([words[run[0]].s, words[run.at(-1)!].e]);
      run = [];
    };
    for (let j = first ?? 0; j <= (last ?? -1); j++) {
      if (inLine[j]) flush();
      else run.push(j);
    }
    flush();
    return {
      take: input.take,
      path: input.path,
      length: input.length || (input.words.at(-1)?.e ?? 0),
      timecode: input.timecode,
      setup: input.setup,
      matches,
      before: before.slice(-300),
      after: after.slice(0, 300),
      sceneStart,
      sceneEnd,
      action: actions.length ? Math.max(...actions) : null,
      cut: cuts.length ? Math.min(...cuts) : null,
      cleanFrom: r3(sceneStart !== null ? Math.min(cleanFrom, sceneStart) : cleanFrom),
      stray,
      words: words.map((w, j) => ({ s: w.s, e: w.e, t: w.t, inLine: mapped[j], stop: stops[j] ?? false })),
      offMic: [],
      flaws: [],
    };
  });
}

/** How much of the script a take holds (0-1): the share of its sentences found. */
export const coverageOf = (take: Take) => take.matches.filter((m) => isFound(m)).length / Math.max(1, take.matches.length);

/** Takes that ran most of the scene (not a false start like a 1-second clip). */
export const usableTakes = (takes: Take[]) => takes.filter((t) => t.setup && coverageOf(t) >= 0.3);

/** Leaves out lines missing from most takes (cut on the day, like "Whiskey?"). */
export function keepSaidLines(units: Unit[], takes: Take[]): { units: Unit[]; takes: Take[]; dropped: string[] } {
  const usable = usableTakes(takes);
  const keep: number[] = [];
  const dropped: number[] = [];
  units.forEach((_, i) => {
    const have = usable.filter((t) => isFound(t.matches[i])).length;
    (have >= 0.4 * usable.length ? keep : dropped).push(i);
  });
  const firstOfSpeech = new Map<number, number>();
  for (const i of keep) if (!firstOfSpeech.has(units[i].speech)) firstOfSpeech.set(units[i].speech, i);
  const startOf = (s: number) => units.findIndex((u) => u.speech === s);
  const kept = keep.map((i) => {
    const u = { ...units[i] };
    u.speechStart = firstOfSpeech.get(u.speech) === i;
    u.actionBefore = u.speechStart ? units[startOf(u.speech)].actionBefore : "";
    return u;
  });
  return {
    units: kept,
    takes: takes.map((t) => ({ ...t, matches: keep.map((i) => t.matches[i]) })),
    dropped: dropped.map((i) => `${units[i].who}: ${units[i].text}`),
  };
}

/**
 * How long each line usually waits after the one before it, over the takes
 * that have both in order (null: fewer than two do). A take that waits far
 * longer stopped there (a flubbed line, "pick it up from…", a new slate).
 */
function usualWaits(takes: Take[], n: number): (number | null)[] {
  return Array.from({ length: n }, (_, i) => {
    const waits = i === 0 ? [] : takes.flatMap((t) => (isFound(t.matches[i - 1]) && isFound(t.matches[i]) && start(t.matches[i]) >= end(t.matches[i - 1]) - 0.2 ? [start(t.matches[i]) - end(t.matches[i - 1])] : []));
    return waits.length >= 2 ? median(waits) : null;
  });
}

/** Whether nothing stray is said in a take between these times. */
const clear = (take: Take, from: number, to: number) => take.stray.every(([s, e]) => e <= from || s >= to);
/** A stretch of a take's picture with nothing wrong in it: no soft focus, no bumped camera. */
const clean = (take: Take, from: number, to: number) => clear(take, from, to) && take.flaws.every((f) => f.e <= from || f.s >= to);
/**
 * What a line costs in a take for what goes wrong while it's said: the take's
 * flaws (each kind once), and a stumble (a word said twice running, "I- I", or
 * words that aren't the line's, an "um" or an ad-lib) (Guy, Oct 5).
 */
function flawed(take: Take, m: Extract<Match, { start: number }>): number {
  const kinds = new Map<string, number>();
  for (const f of take.flaws) if (f.s < m.end && f.e > m.start) kinds.set(f.what, Math.max(kinds.get(f.what) ?? 0, f.cost));
  let [twice, extra] = [0, 0];
  for (let j = m.j0; j <= m.j1; j++) {
    const w = take.words[j];
    if (!w) continue;
    if (j > m.j0 && w.t === take.words[j - 1].t) twice += 1;
    else if (!w.inLine) extra += 1;
  }
  return [...kinds.values()].reduce((a, b) => a + b, 0) + Math.min(0.3, 0.15 * twice) + Math.min(0.2, 0.04 * extra);
}
/** Where the last stray talk before `t` ends (picture and sound pick up after it), and the next one after `t` starts. */
const strayBefore = (take: Take, t: number) => Math.max(-Infinity, ...take.stray.filter(([, e]) => e <= t).map(([, e]) => e));
const strayAfter = (take: Take, t: number) => Math.min(Infinity, ...take.stray.filter(([s]) => s >= t).map(([s]) => s));

/** Whether a take runs on naturally from one line to the next: forward, and with no stop between them. */
function runsOn(units: Unit[], take: Take, i: number, usual: number | null): boolean {
  const gap = start(take.matches[i]) - end(take.matches[i - 1]);
  if (gap < -0.2 || !clear(take, end(take.matches[i - 1]), start(take.matches[i]))) return false;
  return gap <= (usual !== null ? Math.max(usual + 2.5, 1.8 * usual) : units[i].actionBefore ? 12 : 6);
}

/** The take after this one: T004 after T003 for numbered takes, otherwise the next one shot. */
function nextTake(takes: Take[], take: string): Take | undefined {
  const numbered = /^T(\d{3})$/.exec(take);
  if (numbered) return takes.find((t) => t.take === `T${String(Number(numbered[1]) + 1).padStart(3, "0")}`);
  const at = takes.findIndex((t) => t.take === take);
  return takes[at + 1];
}

const setupKey = (s: Setup | null) => (s ? `${s.who}|${s.framing}` : "");

/** How good each take is as a whole: the director's reaction, where it falls in its setup, completeness. */
export function takeScores(takes: Take[]): Record<string, Score> {
  const bySetup = new Map<string, string[]>();
  for (const t of [...takes].sort((a, b) => (a.take < b.take ? -1 : a.take > b.take ? 1 : 0))) {
    if (!t.setup) continue;
    const list = bySetup.get(setupKey(t.setup)) ?? [];
    list.push(t.take);
    bySetup.set(setupKey(t.setup), list);
  }
  const scores: Record<string, Score> = {};
  for (const info of takes) {
    const after = collapseLoops(info.after);
    // What's said before the next take also reacts to this one; only its first words, before the next slate.
    const nxt = nextTake(takes, info.take);
    const beforeNext = nxt ? collapseLoops(nxt.before).slice(0, 60) : "";
    const complete = info.matches.filter((m) => m.score >= 0.6).length / info.matches.length;
    const siblings = (info.setup && bySetup.get(setupKey(info.setup))) || [info.take];
    let q = 0.25 * complete;
    const why: string[] = [];
    const praise = PRAISE.exec(after);
    if (praise) {
      q += 0.15;
      why.push(`the director said "${praise[0]}" after it`);
    }
    if (AGAIN.test(`${after} ${beforeNext}`)) q -= 0.05;
    if (info.take === siblings.at(-1) && siblings.length > 1) {
      q += 0.06;
      why.push("the last take before moving on");
    }
    if (info.take === siblings[0] && siblings.length > 1) q -= 0.04;
    if (complete < 0.5) q -= 0.5;
    scores[info.take] = { q: r3(q), why, complete: pyRound(complete, 2) };
  }
  return scores;
}

/**
 * What the picture should show for each line: whoever says it, and how close
 * (Guy, Oct 5: "The goal is for the BEST edit, not just featuring the client
 * the most. Serve the story"). Each actor's first two speeches are wide enough
 * to place them, then closer as the scene goes in; a move in the stage
 * directions wants the wider shot. A quick interjection of a word or two
 * ("What?") in the middle of the other actor's lines stays on them, heard from the speaker's
 * own take, unless it's one of the scene's key lines (`keyLines`). Who else is
 * seen listening is up to the reactions (addReactions), picture only, so
 * every line keeps its own sound.
 */
function plan(units: Unit[], takes: Take[], keyLines: Set<number>): Plan[] {
  const durations = units.map((_, i) => {
    const sure = takes.filter((t) => t.matches[i].score >= 0.6);
    const ds = (sure.length ? sure : takes.filter((t) => isFound(t.matches[i]))).map((t) => end(t.matches[i]) - start(t.matches[i]));
    return ds.length ? median(ds) : 1.0;
  });
  // Decided per speech, so the picture doesn't change mid-speech by accident.
  const speeches: [number, number][] = [];
  units.forEach((u, i) => {
    if (u.speechStart || !speeches.length) speeches.push([i, i]);
    else speeches[speeches.length - 1][1] = i;
  });
  const wants: Plan[] = new Array(units.length);
  const spoken = new Map<string, number>();
  const framed = new Map<string, Framing>();
  const length = ([f, l]: [number, number]) => durations.slice(f, l + 1).reduce((a, b) => a + b, 0);
  speeches.forEach(([f, l], k) => {
    const u = units[f];
    const [before, after] = [speeches[k - 1], speeches[k + 1]];
    const listener = before && units[before[0]].who;
    // A word or two in the middle of the other actor's lines (not a quick exchange, where each reply is seen).
    const interjection =
      f === l && after && listener && listener !== u.who && units[after[0]].who === listener && u.text.split(/\s+/).length <= 2 && durations[f] <= 0.9 && length(before) >= 2 && length(after) >= 2;
    if (interjection && !u.actionBefore && !keyLines.has(f)) {
      wants[f] = { want: { mode: "listening", who: listener, framing: framed.get(listener) ?? "medium" }, duration: durations[f], firm: false, push: false, patch: true };
      return;
    }
    const moved = Boolean(u.actionBefore && MOVES.test(u.actionBefore));
    const count = (spoken.get(u.who) ?? 0) + 1;
    spoken.set(u.who, count);
    const want: Want = { mode: "on", who: u.who, framing: count <= 2 || moved ? "medium" : "close" };
    // A long speech right after a move: see the move, then push in after the first sentence.
    const pushIn = moved && l - f >= 2;
    for (let i = f; i <= l; i++) {
      wants[i] = { want: pushIn && i > f ? { ...want, framing: "close" } : want, duration: durations[i], firm: moved, push: pushIn && i === f + 1, patch: false };
    }
    framed.set(u.who, wants[l].want.framing);
  });
  return wants;
}

/** A line heard from another take than the picture's: where it goes in the picture's take, and where it comes from. */
type Patch = { take: string; xIn: number; yIn: number; length: number };

/**
 * Where a quick interjection said off camera in take `x` can be heard from
 * its speaker's own take instead: laid where it was said in `x`, long enough
 * to cover it there, with none of anyone else's words under it, from the
 * speaker's take whose line fits the moment best. Null when none fits.
 */
function patchFor(units: Unit[], takes: Take[], scores: Record<string, Score>, x: Take, i: number): Patch | null {
  const mx = x.matches[i];
  if (!isFound(mx) || mx.score < 0.6) return null;
  const around = (t: Take): [number, number] => [
    i > 0 && isFound(t.matches[i - 1]) ? end(t.matches[i - 1]) : 0,
    i + 1 < t.matches.length && isFound(t.matches[i + 1]) ? start(t.matches[i + 1]) : t.length,
  ];
  const [xPrev, xNext] = around(x);
  const xIn = Math.max(mx.start - 0.08, xPrev + 0.02);
  if (xIn > mx.start - 0.02) return null; // said over the other actor's line
  let best: [number, Patch] | null = null;
  for (const y of takes) {
    const my = y.matches[i];
    if (y.setup?.who !== units[i].who || !isFound(my) || my.score < 0.6) continue;
    const length = mx.start - xIn + Math.max(my.end - my.start, mx.end - mx.start) + 0.1;
    const yIn = my.start - (mx.start - xIn);
    const [yPrev, yNext] = around(y);
    if (xIn + length > xNext - 0.03 || yIn < Math.max(0, yPrev + 0.02) || yIn + length > Math.min(yNext - 0.03, y.length - 0.05)) continue;
    if (!clear(x, xIn, xIn + length) || !clear(y, yIn, yIn + length)) continue;
    const fit = Math.abs(my.end - my.start - (mx.end - mx.start)) - 0.3 * scores[y.take].q;
    if (!best || fit < best[0]) best = [fit, { take: y.take, xIn, yIn, length }];
  }
  return best?.[1] ?? null;
}

/**
 * What a take costs for one line. A line's sound comes from a take its speaker
 * is on camera in, with the boom on them, whenever there is one (Guy, Oct 5:
 * "Always pull the CLEAN audio from the boom for any actor saying their lines
 * OFF camera"): the other actor's takes only carry a line their own takes
 * don't have, or a quick interjection that can be heard from the speaker's
 * own take (`patched`).
 */
function unitCost(units: Unit[], take: Take, score: Score, i: number, p: Plan, speakerHasIt: boolean, patched: boolean): number {
  const m = take.matches[i];
  if (!take.setup || !isFound(m)) return Infinity;
  const { who: onCam, framing } = take.setup;
  const speaker = units[i].who;
  if (onCam !== speaker && speakerHasIt && !(p.patch && patched)) return Infinity;
  let cost = 0;
  if (onCam !== p.want.who) cost += 1.2;
  if (framing !== p.want.framing) cost += p.firm ? 1.6 : 0.35; // a move in the stage directions needs the wider shot
  const d = m.end - m.start;
  const outlier = p.duration > 0.6 && (d > 1.7 * p.duration || d < 0.55 * p.duration) ? 0.12 : 0;
  if (onCam === speaker) cost -= 1.2 * m.score + score.q + 0.1 * (m.conf ?? 0) - outlier;
  else cost -= 0.6 * m.score + 0.4 * score.q;
  return cost + flawed(take, m);
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function chooseBlocks(
  units: Unit[],
  takes: Take[],
  scores: Record<string, Score>,
  wants: Plan[],
  waits: (number | null)[],
  patches: Map<string, Patch | null>,
  picks: Map<number, string> = new Map(),
): { take: string; first: number; last: number }[] {
  const T = new Map(takes.map((t) => [t.take, t]));
  const names = takes.filter((t) => t.setup).map((t) => t.take).sort(byName);
  const n = units.length;
  const speakerHasIt = units.map((u, i) => takes.some((t) => t.setup?.who === u.who && isFound(t.matches[i])));
  // A take picked for a line (a note to Loupe, Oct 6) costs every other take a lot there, but never makes the line impossible.
  const cost = (t: string, i: number) =>
    unitCost(units, T.get(t)!, scores[t], i, wants[i], speakerHasIt[i], Boolean(patches.get(`${t}|${i}`))) + (picks.has(i) && picks.get(i) !== t ? 4 : 0);
  const best: Map<string, [number, string | null]>[] = Array.from({ length: n }, () => new Map());
  for (const t of names) {
    const c = cost(t, 0);
    if (c < Infinity) best[0].set(t, [c, null]);
  }
  for (let i = 1; i < n; i++) {
    const speakerChange = units[i].who !== units[i - 1].who;
    const midSpeech = !units[i].speechStart;
    const change = speakerChange || wants[i].push ? 0.12 : midSpeech ? 0.65 : 0.35;
    // If the rules leave no way through this line, allow the jump cut rather than fail (at a high price).
    for (const strict of [true, false]) {
      for (const t of names) {
        const take = T.get(t)!;
        const c = cost(t, i);
        if (c === Infinity) continue;
        let bestOption: [number, string] | null = null;
        const consider = (cost: number, p: string) => {
          if (!bestOption || cost < bestOption[0] || (cost === bestOption[0] && p < bestOption[1])) bestOption = [cost, p];
        };
        for (const [p, [pc]] of best[i - 1]) {
          const prev = T.get(p)!;
          if (p === t) {
            // Staying in the take only works if it runs on to this line without stopping (never through a
            // flubbed line and its restart, or a new slate).
            if (strict ? runsOn(units, take, i, waits[i]) : start(take.matches[i]) >= end(take.matches[i - 1]) - 0.2) consider(pc, p);
          } else if (prev.setup!.who === take.setup!.who) {
            // Two shots of the same actor back to back is a jump cut (Guy: "NO jump cuts"). Only allowed inside
            // that actor's own lines, where a reaction of the other actor will cover the cut.
            const actor = take.setup!.who;
            if (units[i - 1].who === actor && units[i].who === actor) consider(pc + change + 0.45, p);
            else if (!strict) consider(pc + change + 3, p);
          } else consider(pc + change, p);
        }
        if (bestOption) best[i].set(t, [bestOption[0] + c, bestOption[1]]);
      }
      if (best[i].size) break;
    }
    if (!best[i].size) throw new Error(`No take carries the line "${units[i].text}" on from the line before it.`);
  }
  let t = [...best[n - 1]].reduce((a, b) => (b[1][0] < a[1][0] ? b : a))[0];
  const path = [t];
  for (let i = n - 1; i > 0; i--) {
    t = best[i].get(t)![1]!;
    path.push(t);
  }
  path.reverse();
  const blocks: { take: string; first: number; last: number }[] = [];
  path.forEach((take, i) => {
    const lastBlock = blocks.at(-1);
    if (lastBlock && lastBlock.take === take) lastBlock.last = i;
    else blocks.push({ take, first: i, last: i });
  });
  return blocks;
}

const interrupted = (a: string, b: string) => a.trimEnd().endsWith("-") || b.trimStart().startsWith("-");

/** Who a stage direction is about: the first of the actors it names (null: neither, as in "Beat. His eyes widen."). */
function subject(action: string, actors: string[]): string | null {
  const at = actors.map((a) => [new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(action)?.index ?? Infinity, a] as const);
  const [first] = at.sort((a, b) => a[0] - b[0]);
  return first && first[0] < Infinity ? first[1] : null;
}

/** Who moves in a stage direction ("BEN walks to the window."), or null. */
const mover = (action: string, actors: string[]) => (MOVES.test(action) ? subject(action, actors) : null);

type TimelineOptions = {
  /** An establishing shot comes first: straight into the first line, unless the scene opens on a move. */
  tightHead: boolean;
  waits: (number | null)[];
  /** The lines where the scene peaks: the cut to the other actor comes as soon as the line is said. */
  beats: Set<number>;
  patches: Map<string, Patch | null>;
  actors: string[];
  /** The pauses at the cuts, as performed (1), tighter (under 1) or looser (over 1): a note to Loupe (Oct 6). */
  pace?: number;
};

function buildTimeline(units: Unit[], T: Map<string, Take>, chosen: { take: string; first: number; last: number }[], o: TimelineOptions): { blocks: Block[]; seconds: number } {
  let rec = 0;
  const blocks = chosen.map((b) => ({ ...b, patches: [], mutes: [] }) as unknown as Block);
  // Where the other actor's last line before line i ends in this take, and their next line after line k starts.
  const othersEnd = (info: Take, i: number) =>
    Math.max(-Infinity, ...info.matches.slice(0, i).flatMap((m, j) => (isFound(m) && units[j].who !== info.setup!.who && m.end <= start(info.matches[i]) ? [m.end] : [])));
  const othersStart = (info: Take, k: number) =>
    Math.min(Infinity, ...info.matches.flatMap((m, j) => (j > k && isFound(m) && units[j].who !== info.setup!.who && m.start >= end(info.matches[k]) ? [m.start] : [])));
  // The take's next word after a moment and its last one before, whoever says it (the actor's next line said out of
  // the script's order, an ad-lib, the other actor off mic): once a line's sentence is over, its shot's tail runs
  // into none, so nothing is heard twice or comes in off mic (shoot 1053, Oct 5: the doctor's "Maybe five" heard
  // twice, the husband's off-mic "Okay." after the doctor's "Yes.").
  type Spoken = { s: number; e: number };
  const firstAfter = (words: Spoken[], t: number) => words.find((w) => w.s >= t - 0.02 && w.e > t + 0.01)?.s ?? Infinity;
  const lastBefore = (words: Spoken[], t: number) => words.findLast((w) => w.e <= t + 0.02 && w.s < t - 0.01)?.e ?? -Infinity;
  const wordAfter = (info: Take, t: number) => firstAfter(info.words, t);
  // What the other actor says in each take, heard off mic: their lines, the ones said out of the script's order,
  // and ad-libs that sounded off mic.
  const theirs = new Map<string, [number, number][]>();
  const offMicIn = (info: Take) => {
    if (!theirs.has(info.take))
      theirs.set(info.take, [
        ...info.matches.flatMap((m, j) => (isFound(m) && units[j].who !== info.setup!.who ? [[m.start, m.end] as [number, number]] : [])),
        ...outOfOrder(info, units),
        ...info.offMic,
      ]);
    return theirs.get(info.take)!;
  };
  // The words the actor on camera may be saying: a shot's picture never runs on while they're talking and not heard.
  const ownWords = new Map<string, Spoken[]>();
  const own = (info: Take) => {
    if (!ownWords.has(info.take)) ownWords.set(info.take, ownWordsOf(info, units));
    return ownWords.get(info.take)!;
  };
  const ownAfter = (info: Take, t: number) => firstAfter(own(info), t);
  const ownBefore = (info: Take, t: number) => lastBefore(own(info), t);
  const within = (spans: [number, number][], w: Spoken) => spans.some(([a, z]) => w.s >= a - 0.02 && w.e <= z + 0.02);
  const outside = (info: Take, w: Take["words"][number]) => w.inLine || within(info.stray, w) || within(offMicIn(info), w);
  // The end of the other actor's last talk before a moment in a take, heard off mic (their lines, said in or out of
  // the script's order, and ad-libs that sounded off mic).
  const theirsBefore = (info: Take, t: number) => Math.max(-Infinity, ...offMicIn(info).flatMap(([, z]) => (z <= t + 0.02 ? [z] : [])));
  // Where it ends: its last word, and the actor's own that finish its sentence ("We know we're stabilizing him."),
  // never what follows once it's over, which may be something else begun ("We're trying. Have the baby.").
  const tailOf = (info: Take, m: Match) => {
    const found = m as Extract<Match, { start: number }>;
    let [edge, last] = [found.end, info.words[found.j1]];
    for (let n = found.j1 + 1; n < info.words.length; n++) {
      const w = info.words[n];
      if (last.stop || outside(info, w) || w.s - edge > 0.25) break;
      [edge, last] = [w.e, w];
    }
    return edge;
  };
  // A pause as this take has it, unless it runs far longer than the takes usually wait there (a stop and restart).
  const capped = (pause: number, i: number) => (o.waits[i] !== null ? Math.min(pause, o.waits[i]! + 1.0) : pause) * (o.pace ?? 1);
  blocks.forEach((b, bi) => {
    const info = T.get(b.take)!;
    const i = b.first;
    const k = b.last;
    const mi = info.matches[i];
    const mk = info.matches[k];
    const from = start(mi);
    const last = bi === blocks.length - 1;
    // A line ends with its sentence; on the scene's last shot the picture holds on after it (anyone else's words in
    // the hold are kept silent, below).
    const to = last ? end(mk) : tailOf(info, mk);
    let srcIn: number;
    if (bi === 0) {
      const opensOnMove = ENTERS.test(units[i].actionBefore ?? "");
      let head = Math.max(from - (opensOnMove ? 4.0 : 2.0), info.cleanFrom);
      if (info.action !== null) head = Math.max(head, info.action + 0.9);
      // After an establishing shot, straight into the first line (Guy, Oct 1), heard over it (overlapIntro, in
      // finish.ts); a scene that opens on a move shows it first.
      if (o.tightHead && !opensOnMove) head = from - 0.5;
      srcIn = Math.max(0, Math.min(head, from - 0.4));
      srcIn = Math.max(srcIn, Math.min(theirsBefore(info, from) + 0.05, from - 0.06));
    } else {
      const pk = units[blocks[bi - 1].last];
      if (interrupted(pk.text, units[i].text)) srcIn = from - 0.06;
      else {
        const before = info.matches[i - 1];
        const pause = capped(isFound(before) && before.end < from ? from - before.end : 0.8, i);
        // A beat or a move: this shot plays all of it, as performed. Otherwise half the pause each side of the cut.
        srcIn = units[i].actionBefore ? from - Math.min(Math.max(pause - 0.3, 0.3), 8.0) : from - Math.min(Math.max(pause * 0.5, 0.12), 3.0);
      }
      // Never the slate (or a restart's): not before the take is clean, unless that would cut into the line. And
      // not over the end of the other actor's talk (off mic here): their own take has their lines.
      srcIn = Math.max(srcIn, Math.min(Math.max(info.cleanFrom, strayBefore(info, from) + 0.5, othersEnd(info, i) + 0.05, theirsBefore(info, from) + 0.05), from - 0.06));
    }
    let srcOut: number;
    if (last) {
      let tail = to + 2.2;
      if (info.cut !== null) tail = Math.min(tail, info.cut - 0.3);
      srcOut = Math.min(Math.max(tail, to + 0.5), info.length - 0.05);
    } else {
      const nxt = units[k + 1];
      if (interrupted(units[k].text, nxt.text)) srcOut = to + 0.02;
      else {
        const next = info.matches[k + 1];
        const pause = capped(isFound(next) && next.start > to ? next.start - to : 0.8, k + 1);
        // Before a beat the next shot carries the pause; otherwise this side keeps half of it.
        srcOut = to + (nxt.actionBefore ? Math.min(pause * 0.5, 0.3) : Math.min(Math.max(pause * 0.5, 0.15), 3.0));
      }
    }
    // And never into talk that isn't the scene, or into the other actor's next line; before the last shot, into
    // nobody's next word once the sentence is over (shoot 1053: the husband's off-mic "Okay." after "Yes.").
    srcOut = Math.max(Math.min(srcOut, strayAfter(info, to) - 0.15, othersStart(info, k) - 0.05, last ? Infinity : wordAfter(info, to) - 0.05), to + 0.02);
    // A stretch of a take is heard once: a shot from a take used before starts where that use ended, or ends
    // where it began (lines said back to back, out of the script's order).
    for (const u of blocks.slice(0, bi)) {
      if (u.take !== b.take) continue;
      if (u.audio.in <= srcIn && srcIn < u.audio.out && u.audio.out <= from + 0.05) srcIn = u.audio.out;
      if (srcIn < u.audio.in && u.audio.in < srcOut && u.audio.in >= to - 0.05) srcOut = u.audio.in;
    }
    b.audio = { in: r3(srcIn), out: r3(srcOut), recIn: r3(rec), recOut: 0 };
    rec += srcOut - srcIn;
    b.audio.recOut = r3(rec);
    b.onCamera = info.setup!.who;
    b.framing = info.setup!.framing;
    // Interjections said off camera here, heard from their speaker's own take: laid in on whole frames of
    // this block, so its own sound picks up again exactly in sync.
    for (let j = i; j <= k; j++) {
      const patch = units[j].who !== b.onCamera ? o.patches.get(`${b.take}|${j}`) : null;
      if (!patch) continue;
      const from = Math.max(patch.xIn, srcIn);
      const to = Math.min(patch.xIn + patch.length, srcOut);
      const f0 = Math.ceil((from - srcIn) * FPS);
      const f1 = Math.floor((to - srcIn) * FPS);
      if (f1 - f0 < 3) continue;
      const shift = srcIn + f0 / FPS - patch.xIn;
      b.patches.push({ take: patch.take, in: r3(patch.yIn + shift), out: r3(patch.yIn + shift + (f1 - f0) / FPS), recIn: r3(b.audio.recIn + f0 / FPS), recOut: r3(b.audio.recIn + f1 / FPS) });
    }
    // The other actor heard off mic inside this shot's sound, saying a line the cut has from their own take (said
    // here out of the script's order) or an ad-lib that sounded off mic: kept silent, on whole frames inside it so
    // the shot's own sound picks up again exactly in sync, and the room tone carries on under it. A little either
    // side of the talk, for words that ring on, but only into silence, never into the word next to it (shoot 1030:
    // "It was wrong", said straight after the other actor's line, lost its "It").
    const padded = ([a, z]: [number, number]): [number, number] => [
      Math.max(a - 0.03, ...info.words.filter((w) => w.e <= a + 0.01 && w.s < a - 0.01).map((w) => w.e + 0.005)),
      Math.min(z + 0.05, ...info.words.filter((w) => w.s >= z - 0.01 && w.e > z + 0.01).map((w) => w.s - 0.005)),
    ];
    const silent: [number, number][] = [
      ...info.matches.flatMap((m, j) => ((j < i || j > k) && isFound(m) && units[j].who !== b.onCamera ? [padded([m.start, m.end])] : [])),
      ...[...outOfOrder(info, units), ...info.offMic].map(padded),
    ].sort((x, y) => x[0] - y[0]);
    for (const [s, e] of silent) {
      const [lo, hi] = [Math.max(s, srcIn), Math.min(e, srcOut)];
      if (hi - lo < 0.05) continue;
      const [f0, f1] = [Math.ceil((lo - srcIn) * FPS - 0.001), Math.floor((hi - srcIn) * FPS + 0.001)];
      if (f1 <= f0) continue;
      const r0 = r3(b.audio.recIn + f0 / FPS);
      const r1 = r3(Math.min(b.audio.recIn + f1 / FPS, b.audio.recOut));
      if (b.patches.some((p) => p.recIn < r1 && r0 < p.recOut)) continue;
      const prev = b.mutes.at(-1);
      if (prev && r0 <= prev[1]) prev[1] = Math.max(prev[1], r1);
      else b.mutes.push([r0, r1]);
    }
  });
  // Split edits: where the cut switches between the actors, picture and sound part by a few frames.
  for (let bi = 0; bi < blocks.length - 1; bi++) {
    const x = blocks[bi];
    const y = blocks[bi + 1];
    const lastLine = units[x.last];
    const firstLine = units[y.first];
    let offset = 0;
    let kind: "straight" | "J" | "L" = "straight";
    const moved = firstLine.actionBefore ? mover(firstLine.actionBefore, o.actors) : null;
    if (x.onCamera !== y.onCamera && !interrupted(lastLine.text, firstLine.text)) {
      if (o.beats.has(x.last) && x.onCamera === lastLine.who) {
        // Where the scene peaks: the other actor takes the line in, from just after it's said.
        const said = x.audio.recIn + end(T.get(x.take)!.matches[x.last]) - x.audio.in;
        offset = -Math.min(3.0, Math.max(10 / FPS, x.audio.recOut - (said + 0.15)));
        kind = "L";
      } else if (moved && moved === x.onCamera && moved !== firstLine.who) {
        // The stage directions have the actor on screen move before the other one speaks: stay to see it.
        const speaks = y.audio.recIn + start(T.get(y.take)!.matches[y.first]) - y.audio.in;
        offset = Math.min(3.0, speaks + 0.5 - x.audio.recOut);
        kind = "J";
      } else if (/[?!]$/.test(lastLine.text.trimEnd()) || y.onCamera !== firstLine.who) {
        offset = -10 / FPS; // see the listener react before the line has finished
        kind = "L";
      } else if (x.onCamera !== lastLine.who || firstLine.text.length > 18) {
        offset = 9 / FPS; // hear the next line start, then see who says it
        kind = "J";
      }
    }
    // Keep the split inside what each take actually has, clear of its slate and of anything said that isn't the scene.
    const [tx, ty] = [T.get(x.take)!, T.get(y.take)!];
    // And never showing an actor say what isn't heard: the incoming shot not before its actor's last word, the
    // outgoing one not after its actor's next.
    offset =
      offset < 0
        ? Math.min(0, Math.max(offset, -(y.audio.in - Math.max(0.05, ty.cleanFrom, strayBefore(ty, y.audio.in) + 0.5, ownBefore(ty, y.audio.in) + 0.05))))
        : Math.max(0, Math.min(offset, tx.length - x.audio.out - 0.05, strayAfter(tx, x.audio.out) - 0.1 - x.audio.out, ownAfter(tx, x.audio.out) - 0.05 - x.audio.out));
    if (Math.abs(offset) < 1 / FPS) [offset, kind] = [0, "straight"];
    x.cutAfter = { kind, seconds: r3(offset) };
  }
  blocks.forEach((b, bi) => {
    const lead = bi > 0 ? blocks[bi - 1].cutAfter!.seconds : 0;
    const trail = b.cutAfter?.seconds ?? 0;
    b.picture = { in: r3(b.audio.in + lead), out: r3(b.audio.out + trail), recIn: r3(b.audio.recIn + lead), recOut: r3(b.audio.recOut + trail) };
  });
  return { blocks, seconds: rec };
}

/** The words a take's actor on camera may be saying: not the other actor's lines (said in or out of order), nor talk heard off mic. */
export function ownWordsOf(take: Take, units: Unit[]): { s: number; e: number }[] {
  const off: [number, number][] = [
    ...take.matches.flatMap((m, j) => (isFound(m) && units[j].who !== take.setup?.who ? [[m.start, m.end] as [number, number]] : [])),
    ...outOfOrder(take, units),
    ...take.offMic,
  ];
  return take.words.filter((w) => !off.some(([a, z]) => w.s >= a - 0.02 && w.e <= z + 0.02));
}

/**
 * Each cut between two shots nudged, by up to three frames, onto a movement in
 * the outgoing shot (a turn of the head, a reach, a step), and some in the
 * incoming one: it carries the eye across and hides the cut (Guy, Oct 5: "Read
 * 'Blink of an Eye'", where Murch cuts as a thought turns, on the move). Only
 * for a clear gain, never so that a shot shows its actor saying what isn't
 * heard, never leaving a shot under three quarters of a second; the scene's
 * first and last frames stay. `motion`: each take's, frame by frame (picture.ts).
 */
export function onMovement(cut: Cut, motion: Map<string, Float32Array>): { cut: Cut; moved: number } {
  const T = new Map(cut.takes.map((t) => [t.take, t]));
  const video = cut.video.map((p) => ({ ...p, alternates: p.alternates.map((a) => ({ ...a })) }));
  const own = new Map<string, { s: number; e: number }[]>();
  const talking = (take: string, from: number, to: number) => {
    if (!own.has(take)) own.set(take, ownWordsOf(T.get(take)!, cut.units));
    return own.get(take)!.some((w) => w.s < to && w.e > from);
  };
  const usual = new Map<string, number>();
  // How much moves over a few frames from `from` (source time), against what the take usually has.
  const moves = (take: string, from: number, frames: number) => {
    const m = motion.get(take);
    if (!m || !m.length) return 0;
    if (!usual.has(take)) usual.set(take, Math.max(0.05, median([...m].filter((v) => v > 0))));
    let [sum, n] = [0, 0];
    for (let k = 0, f = Math.round(from * FPS); k < frames; k++, f++) if (f >= 0 && f < m.length) [sum, n] = [sum + m[f], n + 1];
    return n ? sum / n / usual.get(take)! : 0;
  };
  let moved = 0;
  for (let k = 0; k + 1 < video.length; k++) {
    const [p, q] = [video[k], video[k + 1]];
    const at = frames(p.recOut);
    const score = (d: number) => {
      const t = (at + d) / FPS;
      return moves(p.take, p.in + t - p.recIn - 3 / FPS, 3) + 0.5 * moves(q.take, q.in + t - q.recIn, 3) - 0.15 * Math.abs(d);
    };
    const still = score(0);
    let [best, top] = [0, still + 0.5];
    for (const d of [-3, -2, -1, 1, 2, 3]) {
      const t = (at + d) / FPS;
      if (frames(t) - frames(p.recIn) < 18 || frames(q.recOut) - frames(t) < 18) continue;
      if (d > 0 && talking(p.take, p.out, p.in + t - p.recIn)) continue;
      if (d < 0 && talking(q.take, q.in + t - q.recIn, q.in)) continue;
      const sc = score(d);
      if (sc > top) [best, top] = [d, sc];
    }
    if (!best) continue;
    const t = (at + best) / FPS;
    const [dp, dq] = [t - p.recOut, t - q.recIn];
    p.out = r3(p.out + dp);
    p.alternates = p.alternates.map((a) => ({ ...a, out: r3(a.out + dp) })).filter((a) => a.out <= T.get(a.take)!.length - 0.05);
    q.in = r3(q.in + dq);
    q.alternates = q.alternates.map((a) => ({ ...a, in: r3(a.in + dq) })).filter((a) => a.in >= Math.max(0, T.get(a.take)!.cleanFrom));
    p.recOut = q.recIn = r3(t);
    moved += 1;
  }
  return { cut: { ...cut, video }, moved };
}

/**
 * The other actor's lines said in a take out of the script's order, between the
 * lines found or inside one of them (shoot 1053, Oct 5: the husband's "Five
 * minutes?" in the middle of the doctor's next line): runs of words in no line
 * that say most of one of theirs. Two words at least, so one-word lines ("What?")
 * never take the actor on camera's own words.
 */
export function outOfOrder(take: Take, units: Unit[]): [number, number][] {
  const who = take.setup?.who;
  if (!who) return [];
  const theirs = units.filter((u) => u.who !== who).map((u) => tokens(u.text).map(norm)).filter((t) => t.length >= 2);
  const out: [number, number][] = [];
  for (let a = 0; a < take.words.length; a++) {
    if (take.words[a].inLine) continue;
    let b = a;
    while (b + 1 < take.words.length && !take.words[b + 1].inLine && take.words[b + 1].s - take.words[b].e < 0.6) b++;
    const run = take.words.slice(a, b + 1).map((w) => w.t);
    const says = theirs.some((line) => {
      const common = matchingBlocks(line, run).reduce((n, [, , size]) => n + size, 0);
      return common >= Math.ceil(0.8 * line.length) && common >= 0.6 * run.length;
    });
    if (says) out.push([take.words[a].s, take.words[b].e]);
    a = b;
  }
  return out;
}

/** The next-best takes of the same setup covering the same lines, lined up on the block's first line. */
function alternates(T: Map<string, Take>, scores: Record<string, Score>, blocks: Block[]) {
  for (const b of blocks) {
    const setup = T.get(b.take)!.setup!;
    const ranked: [number, string][] = [];
    for (const info of T.values()) {
      if (info.take === b.take || !info.setup || info.setup.who !== setup.who || info.setup.framing !== setup.framing) continue;
      const ms = info.matches.slice(b.first, b.last + 1);
      if (Math.min(...ms.map((m) => m.score)) < 0.6) continue;
      ranked.push([ms.reduce((s, m) => s + m.score, 0) / ms.length + scores[info.take].q, info.take]);
    }
    ranked.sort((x, y) => y[0] - x[0] || byName(y[1], x[1]));
    b.alternates = [];
    const anchor = start(T.get(b.take)!.matches[b.first]);
    for (const [, t] of ranked.slice(0, 2)) {
      const shift = start(T.get(t)!.matches[b.first]) - anchor;
      const pin = b.picture.in + shift;
      const pout = b.picture.out + shift;
      if (pin < Math.max(0, T.get(t)!.cleanFrom) || pout > T.get(t)!.length || !clear(T.get(t)!, pin, pout)) continue;
      b.alternates.push({ take: t, in: r3(pin), out: r3(pout) });
    }
  }
}

const videoTrack = (blocks: Block[]): Piece[] =>
  blocks.map((b) => ({ take: b.take, ...b.picture, kind: "shot", lines: [b.first, b.last], alternates: b.alternates.map((x) => ({ ...x })) }));

/** Lays a picture-only shot over [rin, rout]; what it covers is trimmed, staying in sync either side. */
export function cutInto(video: Piece[], rin: number, rout: number, piece: Piece): Piece[] {
  const out: Piece[] = [];
  for (const p of video) {
    if (p.recOut <= rin || p.recIn >= rout) {
      out.push(p);
      continue;
    }
    if (p.recIn < rin) {
      out.push({ ...p, recOut: r3(rin), out: r3(p.in + rin - p.recIn), alternates: p.alternates.map((x) => ({ ...x, out: r3(x.in + rin - p.recIn) })) });
    }
    if (p.recOut > rout) {
      const shift = rout - p.recIn;
      out.push({ ...p, recIn: r3(rout), in: r3(p.in + shift), alternates: p.alternates.map((x) => ({ ...x, in: r3(x.in + shift) })) });
    }
  }
  out.push(piece);
  return out.map((p, i) => [p, i] as const).sort((a, b) => a[0].recIn - b[0].recIn || a[1] - b[1]).map(([p]) => p);
}

type Spans = Map<number, [number, number]>;

/** When each line is said in the cut, and when each actor is speaking. */
function onTimeline(units: Unit[], T: Map<string, Take>, blocks: Block[]): { rt: Spans; speaking: Map<string, [number, number][]> } {
  const rt: Spans = new Map();
  const speaking = new Map<string, [number, number][]>();
  for (const b of blocks) {
    const info = T.get(b.take)!;
    for (let j = b.first; j <= b.last; j++) {
      const m = info.matches[j];
      rt.set(j, [b.audio.recIn + start(m) - b.audio.in, b.audio.recIn + end(m) - b.audio.in]);
    }
    info.matches.forEach((m, j) => {
      if (!isFound(m) || m.end <= b.audio.in || m.start >= b.audio.out) return;
      const s = b.audio.recIn + Math.max(m.start, b.audio.in) - b.audio.in;
      const e = b.audio.recIn + Math.min(m.end, b.audio.out) - b.audio.in;
      const list = speaking.get(units[j].who) ?? [];
      list.push([s, e]);
      speaking.set(units[j].who, list);
    });
  }
  // Python dicts keep insertion order; lines are visited in order, so sort the keys to match.
  return { rt: new Map([...rt].sort((a, b) => a[0] - b[0])), speaking };
}

/** The other actor listening at this moment: their take at the line being said then, picture only. */
function reactionPiece(T: Map<string, Take>, scores: Record<string, Score>, who: string, rin: number, rout: number, rt: Spans, why: string): Piece | null {
  const keys = [...rt.keys()];
  const near = keys
    .map((j, order) => ({ j, order, key: [rt.get(j)![0] - 1.0 <= rin && rin <= rt.get(j)![1] + 1.5 ? 0 : 1, Math.abs(rt.get(j)![0] - rin)] }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.order - b.order)
    .slice(0, 3)
    .map((x) => x.j);
  type Option = [boolean, number, number, string, number, number];
  let bestOption: Option | null = null;
  const greater = (a: Option, b: Option) => {
    for (let k = 0; k < a.length; k++) {
      const x = typeof a[k] === "boolean" ? Number(a[k]) : a[k];
      const y = typeof b[k] === "boolean" ? Number(b[k]) : b[k];
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  };
  for (const info of T.values()) {
    if (!info.setup || info.setup.who !== who) continue;
    for (const j of near) {
      const m = info.matches[j];
      if (!isFound(m)) continue;
      const src = m.start + (rin - rt.get(j)![0]);
      if (src < Math.max(0.2, info.cleanFrom) || src + (rout - rin) > info.length - 0.1 || !clean(info, src - 0.1, src + rout - rin + 0.1)) continue;
      const option: Option = [info.setup.framing === "close", scores[info.take].q, -near.indexOf(j), info.take, src, j];
      if (!bestOption || greater(option, bestOption)) bestOption = option;
      break;
    }
  }
  if (!bestOption) return null;
  const [, , , t, src, j] = bestOption;
  return { take: t, in: r3(src), out: r3(src + rout - rin), recIn: r3(rin), recOut: r3(rout), kind: "reaction", lines: [j, j], why, alternates: [] };
}

/** Nobody's lips move under someone else's sound: a reaction never covers the reacting actor's own lines. */
const isFree = (speaking: Map<string, [number, number][]>, who: string, rin: number, rout: number) =>
  (speaking.get(who) ?? []).every(([s, e]) => e <= rin || s >= rout);

/**
 * Who is seen listening, and when (Guy, Oct 5: "Serve the story"): picture
 * only, over the speaker's own sound, for either actor alike. Where the scene
 * peaks (`beats`, from the scene read) and the speaker carries on, or the
 * scene ends on it, the other actor taking the line in; a scene that opens on
 * the listener's move, them making it; a stage direction between two of one
 * actor's speeches, the other actor's reaction to it.
 */
function addReactions(
  units: Unit[],
  T: Map<string, Take>,
  scores: Record<string, Score>,
  blocks: Block[],
  video: Piece[],
  actors: [string, string],
  beats: Set<number>,
  reactions?: "more" | "fewer",
) {
  const { rt, speaking } = onTimeline(units, T, blocks);
  const person = (p: Piece) => T.get(p.take)!.setup!.who;
  const other = (x: string) => (x === actors[0] ? actors[1] : actors[0]);
  const sceneEnd = video.at(-1)!.recOut;
  const starts = units.map((u, i) => (u.speechStart ? i : -1)).filter((i) => i >= 0);
  const add = (who: string, rin: number, rout: number, why: string) => {
    rin = Math.max(rin, video[0].recIn);
    rout = Math.min(rout, sceneEnd);
    if (rout - rin < 0.8 || video.some((q) => q.kind === "reaction" && Math.abs(q.recIn - rin) < 4)) return;
    // Never a flash of the shot it cuts into, on either side (shoot 1039's last shot, Oct 5): run to the cut instead.
    const before = video.find((p) => p.recIn < rin && rin < p.recOut);
    const after = video.find((p) => p.recIn < rout && rout < p.recOut);
    const spans: [number, number][] = [[before && rin - before.recIn < 0.6 ? before.recIn : rin, after && after.recOut - rout < 0.6 ? after.recOut : rout], [rin, rout]];
    for (const [a, b] of spans) {
      const piece = isFree(speaking, who, a, b) ? reactionPiece(T, scores, who, a, b, rt, why) : null;
      if (piece) {
        video = cutInto(video, a, b, piece);
        return;
      }
    }
  };

  // 1. Where the scene peaks and the speaker carries on, or the scene ends on it: the other actor taking it in.
  //    (When the other actor answers, the cut to them comes as soon as the line is said: buildTimeline.)
  for (const j of [...beats].sort((a, b) => a - b)) {
    if (!rt.has(j)) continue;
    const speaker = units[j].who;
    const said = rt.get(j)![1];
    const next = rt.get(j + 1);
    if (next && units[j + 1].who !== speaker) continue;
    add(other(speaker), said - 0.2, next ? Math.min(Math.max(next[0] + 0.6, said + 1.4), said + 2.8) : said + 2.0, `How ${other(speaker)} takes "${units[j].text.slice(0, 40)}"`);
  }

  // 2. A scene that opens on the listener coming in ("Eddie bursts in."): see them do it.
  const opening = units[0].actionBefore;
  if (opening && ENTERS.test(opening) && subject(opening, actors) === other(units[0].who) && rt.has(0)) add(other(units[0].who), 0, rt.get(0)![0] + 0.5, opening);

  // 3. A stage direction between two of one actor's speeches is a beat for the other actor ("His eyes widen",
  //    "She gives a tiny nod"): cut away to their reaction. Unless it's the speaker who moves: their shot shows it.
  for (let s = 0; reactions !== "fewer" && s < starts.length - 1; s++) {
    const f = starts[s];
    const nxt = starts[s + 1];
    const action = units[nxt].actionBefore;
    if (units[f].who !== units[nxt].who || !action || mover(action, actors) === units[f].who || !rt.has(nxt - 1) || !rt.has(nxt)) continue;
    const rin = rt.get(nxt - 1)![1] - 0.4;
    const rout = Math.min(Math.max(rt.get(nxt)![0] + 0.5, rin + 1.6), rin + 5.0);
    add(other(units[f].who), rin, rout, action);
  }

  // 4. No jump cuts: wherever two shots of the same actor meet (a push-in during their own lines),
  //    a short reaction of the other actor covers the cut.
  let k = 0;
  while (k < video.length - 1) {
    const x = video[k];
    const y = video[k + 1];
    if (person(x) !== person(y)) {
      k += 1;
      continue;
    }
    const listener = other(person(x));
    const b = x.recOut;
    const rin = Math.max(b - 0.5, x.recIn + 0.6);
    const rout = Math.min(b + 1.3, y.recOut - 0.6);
    const piece = rout - rin >= 0.8 ? reactionPiece(T, scores, listener, rin, rout, rt, `Covers a cut between two shots of ${person(x)}`) : null;
    if (!piece || !isFree(speaking, listener, rin, rout)) {
      k += 1; // reported as a jump below
      continue;
    }
    video = cutInto(video, rin, rout, piece);
    k = 0;
  }

  // 5. Now and then a reaction (Guy: "scarce reaction shots sometimes"): one inside any shot of an actor
  //    talking for over 16 s, after a question or a sharp line if there is one, never two within 15 s.
  //    Asked for more (a note to Loupe): over 8 s, 8 s apart; for fewer, none of these or the beats in 3.
  const [longShot, apart] = reactions === "more" ? [8.0, 8] : [16.0, 15];
  for (const p of reactions === "fewer" ? [] : [...video]) {
    if (p.kind !== "shot" || p.recOut - p.recIn < longShot) continue;
    const talker = person(p);
    const mid = (p.recIn + p.recOut) / 2;
    const options: [boolean, number, number][] = [];
    for (const j of [...rt.keys()].sort((a, b) => a - b)) {
      if (!rt.has(j + 1) || units[j].who !== talker || units[j + 1].who !== talker) continue;
      const lineEnd = rt.get(j)![1];
      const nextStart = rt.get(j + 1)![0];
      if (p.recIn + 4 < lineEnd && nextStart < p.recOut - 4) options.push([!/[?!]$/.test(units[j].text.trimEnd()), Math.abs(lineEnd - mid), j]);
    }
    if (!options.length) continue;
    options.sort((a, b) => Number(a[0]) - Number(b[0]) || a[1] - b[1] || a[2] - b[2]);
    const j = options[0][2];
    const rin = rt.get(j)![1] - 0.4;
    const rout = Math.min(Math.max(rt.get(j + 1)![0] + 1.2, rin + 1.6), rin + 3.0);
    if (video.some((q) => q.kind === "reaction" && Math.abs(q.recIn - rin) < apart)) continue;
    const listener = other(talker);
    const piece = reactionPiece(T, scores, listener, rin, rout, rt, `A reaction now and then, during ${talker}'s lines`);
    if (piece && isFree(speaking, listener, rin, rout)) video = cutInto(video, rin, rout, piece);
  }

  // 6. No flashes: a shot under a second between two reactions of the same actor folds into one longer
  //    reaction (as long as that actor isn't speaking through it).
  k = 1;
  while (k < video.length - 1) {
    const [left, mid, right] = [video[k - 1], video[k], video[k + 1]];
    if (
      mid.recOut - mid.recIn < 1.0 &&
      left.kind === "reaction" &&
      right.kind === "reaction" &&
      person(left) === person(right) &&
      isFree(speaking, person(left), left.recIn, right.recOut) &&
      left.in + right.recOut - left.recIn <= T.get(left.take)!.length - 0.1
    ) {
      left.out = r3(left.in + right.recOut - left.recIn);
      left.recOut = right.recOut;
      left.why = (right.why ?? "").length > (left.why ?? "").length ? right.why : left.why;
      video.splice(k, 2);
      continue;
    }
    k += 1;
  }

  const jumps: number[] = [];
  for (let i = 0; i < video.length - 1; i++) if (person(video[i]) === person(video[i + 1])) jumps.push(pyRound(video[i].recOut, 1));
  return { video, jumps };
}

export type AssembleInput = { title: string; client: string; script: ScriptLine[]; takes: TakeInput[] };

/** The whole first cut: from the script and the takes to blocks, picture and sound edits. */
export function assemble(input: AssembleInput): Cut {
  const roles = [...new Set(input.script.flatMap((l) => (l.kind === "speech" ? [l.who] : [])))];
  const allUnits = buildUnits(input.script);
  const aligned = alignTakes(allUnits, input.takes);
  return assembleAligned(input.title, input.client, roles, allUnits, aligned);
}

/** A block's sound: its own take, with any lines heard from their speaker's own take laid in. */
function soundOf(b: Block): AudioEdit[] {
  const out: AudioEdit[] = [];
  let at = b.audio.recIn;
  const own = (from: number, to: number) => {
    if (to - from > 0.001) out.push({ take: b.take, in: r3(b.audio.in + from - b.audio.recIn), out: r3(b.audio.in + to - b.audio.recIn), recIn: r3(from), recOut: r3(to) });
  };
  // Its own sound, around the interjections heard from their speaker's take and the stretches kept silent.
  const holes = [...b.patches.map((p) => ({ from: p.recIn, to: p.recOut, edit: p as AudioEdit | null })), ...b.mutes.map(([from, to]) => ({ from, to, edit: null }))];
  for (const h of holes.sort((x, y) => x.from - y.from)) {
    own(at, h.from);
    if (h.edit) out.push(h.edit);
    at = Math.max(at, h.to);
  }
  own(at, b.audio.recOut);
  return out;
}

/**
 * The client (Loupe's "lead": whose scene it is) gets their own dialogue track; the edit serves the scene, not them (Guy,
 * Oct 5: "The goal is for the BEST edit… Serve the Story"). From the scene
 * read: `beats`, the lines where the scene peaks, which the other actor is
 * seen taking in, and `laugh`, its biggest laugh; both indexes into the lines
 * the cut keeps (keepSaidLines).
 */
export function assembleAligned(
  title: string,
  client: string,
  roles: string[],
  allUnits: Unit[],
  aligned: Take[],
  options: { tightHead?: boolean; beats?: number[]; laugh?: number | null; steer?: Steer } = {},
): Cut {
  const { units, takes, dropped } = keepSaidLines(allUnits, aligned);
  const steer = options.steer ?? {};
  if (!units.length) throw new Error("None of the script's lines were found in enough takes.");
  const laugh = options.laugh ?? null;
  const beats = new Set((options.beats ?? []).filter((j) => j >= 0 && j < units.length && j !== laugh));
  const onCamera = new Set(takes.flatMap((t) => (t.setup ? [t.setup.who] : [])));
  const partner = [...onCamera].find((r) => r !== client) ?? roles.find((r) => r !== client) ?? "PARTNER";
  const T = new Map(takes.map((t) => [t.take, t]));
  const scores = takeScores(takes);
  // How each performance plays, from watching it (performance.ts): a little more or less in the take's favour.
  for (const [take, p] of Object.entries(steer.performance ?? {})) {
    const score = scores[take];
    if (!score) continue;
    score.q = r3(score.q + Math.min(0.15, Math.max(-0.15, p.bonus)));
    if (p.note) score.why.push(p.note);
  }
  const picks = new Map<number, string>();
  for (const pick of steer.picks ?? []) {
    const i = units.findIndex((u) => sameLine(u.text, pick.line));
    if (i >= 0 && T.has(pick.take)) picks.set(i, pick.take);
  }
  const wants = plan(units, takes, new Set([...beats, ...(laugh !== null ? [laugh] : [])]));
  const patches = new Map<string, Patch | null>();
  wants.forEach((w, i) => {
    if (!w.patch) return;
    for (const t of takes) if (t.setup && t.setup.who !== units[i].who) patches.set(`${t.take}|${i}`, patchFor(units, takes, scores, t, i));
  });
  const waits = usualWaits(takes, units.length);
  const chosen = chooseBlocks(units, takes, scores, wants, waits, patches, picks);
  const pace = steer.pace === "tighter" ? 0.6 : steer.pace === "looser" ? 1.4 : 1;
  const { blocks, seconds } = buildTimeline(units, T, chosen, { tightHead: Boolean(options.tightHead), waits, beats, patches, actors: [client, partner], pace });
  alternates(T, scores, blocks);
  const { video, jumps } = addReactions(units, T, scores, blocks, videoTrack(blocks), [client, partner], beats, steer.reactions);
  const audio = blocks.flatMap(soundOf);
  return { title, client, partner, seconds: pyRound(seconds, 2), fps: FPS, units, takes, scores, blocks, video, audio, dropped, jumps };
}

export type Shot = {
  n: number;
  at: number;
  seconds: number;
  take: string;
  who: string;
  framing: Framing;
  kind: "shot" | "reaction" | "establishing";
  /** A push-in where the scene peaks: the scale it ends at (1.08 = 108%). */
  pushIn?: number;
  /** The push-in is a quick zoom on the scene's biggest laugh (a comedy). */
  snap?: boolean;
  /** The line the shot opens on (or, for a reaction, the line heard under it). */
  line: string;
  speaker: string;
  listening: boolean;
  why: string;
  alternates: string[];
  cut: "straight" | "J" | "L" | null;
};

/** The cut shot by shot, in plain words: what the shoot page lists and the timeline's markers say. */
export function describeShots(cut: Cut): Shot[] {
  const T = new Map(cut.takes.map((t) => [t.take, t]));
  const lineAt: [number, number, number][] = [];
  for (const b of cut.blocks) {
    for (let j = b.first; j <= b.last; j++) {
      const m = T.get(b.take)!.matches[j];
      lineAt.push([b.audio.recIn + start(m) - b.audio.in, b.audio.recIn + end(m) - b.audio.in, j]);
    }
  }
  return cut.video.map((p, i) => {
    const info = T.get(p.take)!;
    const { who, framing } = info.setup!;
    let f = p.lines[0];
    const l = p.lines[1];
    // The line being said as the shot comes in (a shot can come in during one, after a J-cut), or the next one.
    if (p.kind === "shot") f = lineAt.find(([, e, j]) => e > p.recIn + 0.3 && j >= p.lines[0])?.[2] ?? f;
    const base = { n: i + 1, at: p.recIn, seconds: pyRound(p.recOut - p.recIn, 2), take: p.take, who, framing, alternates: p.alternates.map((a) => a.take) };
    if (p.kind === "reaction") {
      return { ...base, kind: "reaction", line: cut.units[f].text, speaker: cut.units[f].who, listening: true, why: p.why ?? "A reaction", cut: null };
    }
    const block = cut.blocks.find((b) => b.take === p.take && b.first === p.lines[0]);
    const listening = cut.units.slice(f, l + 1).every((u) => u.who !== who);
    const why = cut.scores[p.take].why.join("; ") || "the best read of these lines";
    return { ...base, kind: "shot", line: cut.units[f].text, speaker: cut.units[f].who, listening, why: why[0].toUpperCase() + why.slice(1), cut: block?.cutAfter?.kind ?? null };
  });
}

