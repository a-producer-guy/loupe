// Words, sentences and lining a take up against the script: the first step of
// the first assembly (Guy's idea, Oct 1 2026). Ported from the pilot's
// align.py, which was tested on three real scenes; the matching is Python's
// difflib.SequenceMatcher, ported exactly, so the cuts come out the same.

/** One line of a script: a stage direction, or a speech. */
export type ScriptLine = { kind: "action"; text: string } | { kind: "speech"; who: string; text: string };

/** A word as transcribed: text (with its punctuation), start and end in seconds, confidence 0-1. */
export type Word = { w: string; s: number; e: number; p: number };

/** A sentence of dialogue: the unit the cut is made of. */
export type Unit = { who: string; text: string; speechStart: boolean; actionBefore: string; speech: number };

/** Where one sentence was said in one take: how much of it (0-1), when, and how sure Whisper was. */
export type Match = { score: number; start: number; end: number; said: string; conf: number; j0: number; j1: number } | { score: 0 };

export const isFound = (m: Match, at = 0.5): m is Extract<Match, { start: number }> => m.score >= at && "start" in m;

/**
 * Python's round(): rounds the number exactly as stored (0.995 is really
 * 0.99499…, so it rounds down), and a true half goes to the even neighbour.
 * toFixed rounds the exact stored value too, but sends halves up.
 */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 40));
  const tail = exact.slice(exact.indexOf(".") + 1 + digits);
  if (/^50*$/.test(tail)) {
    const lower = Math.floor(Math.abs(x) * 10 ** digits);
    return (Math.sign(x) * (lower % 2 === 0 ? lower : lower + 1)) / 10 ** digits;
  }
  return Number(x.toFixed(digits));
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new Error("median of nothing");
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

export function tokens(text: string): string[] {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/(\d)\/(\d)/g, "$1 $2");
  return t.split(/[^a-z0-9']+/).filter((x) => x && x !== "'");
}

export const norm = (token: string) => token.replace(/'/g, "");

/** A speech split into sentences; an ellipsis mid-sentence ("Did he...ask") doesn't split it. */
export function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.?!])\s+(?=["“A-Z])/)
    .map((p) => p.trim())
    .filter((p) => tokens(p).length > 0);
}

export function buildUnits(script: ScriptLine[]): Unit[] {
  const units: Unit[] = [];
  let actionsBefore: string[] = [];
  let speech = -1;
  for (const line of script) {
    if (line.kind === "action") {
      actionsBefore.push(line.text);
      continue;
    }
    speech += 1;
    sentences(line.text).forEach((sentence, k) => {
      units.push({ who: line.who, text: sentence, speechStart: k === 0, actionBefore: k === 0 ? actionsBefore.join(" ") : "", speech });
    });
    actionsBefore = [];
  }
  return units;
}

export type TakeWord = { t: string; s: number; e: number; p: number };

/** A take's words as tokens, each with its time. */
export function takeWords(words: Word[]): TakeWord[] {
  const out: TakeWord[] = [];
  for (const w of words) for (const t of tokens(w.w)) out.push({ t: norm(t), s: w.s, e: w.e, p: w.p });
  return out;
}

// ─── difflib.SequenceMatcher(None, a, b, autojunk=False) ─────────────────────

type Block = [number, number, number];

function longestMatch(a: string[], b2j: Map<string, number[]>, alo: number, ahi: number, blo: number, bhi: number): Block {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = next;
  }
  return [besti, bestj, bestsize];
}

/** The runs of tokens a and b have in common, in order (difflib's get_matching_blocks, without the end sentinel). */
export function matchingBlocks(a: string[], b: string[]): Block[] {
  const b2j = new Map<string, number[]>();
  b.forEach((x, j) => {
    const list = b2j.get(x);
    if (list) list.push(j);
    else b2j.set(x, [j]);
  });
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const found: Block[] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longestMatch(a, b2j, alo, ahi, blo, bhi);
    if (k) {
      found.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const merged: Block[] = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of found) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) merged.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) merged.push([i1, j1, k1]);
  return merged;
}

/** For every token of a, the token of b it lines up with (if any). */
export function mapping(a: string[], b: string[]): Map<number, number> {
  const mapped = new Map<number, number>();
  for (const [i, j, n] of matchingBlocks(a, b)) for (let k = 0; k < n; k++) mapped.set(i + k, j + k);
  return mapped;
}

/** For each sentence of the script: how much of it the take has, and when. */
export const alignTake = (units: Unit[], words: TakeWord[]): Match[] => alignTakeWords(units, words).matches;

/** The same, and which of the take's words are in a sentence (not those said between a sentence's words). */
export function alignTakeWords(units: Unit[], words: TakeWord[]): { matches: Match[]; inLine: boolean[] } {
  const scriptToks: string[] = [];
  const owner: number[] = [];
  units.forEach((u, i) => {
    for (const t of tokens(u.text)) {
      scriptToks.push(norm(t));
      owner.push(i);
    }
  });
  const mapped = mapping(
    scriptToks,
    words.map((w) => w.t),
  );
  const byUnit: number[][] = units.map(() => []);
  owner.forEach((i, k) => byUnit[i].push(k));
  const inLine = words.map(() => false);
  const matches = units.map((_, i): Match => {
    const idx = byUnit[i];
    let js = idx.filter((k) => mapped.has(k)).map((k) => mapped.get(k)!);
    if (js.length) {
      // Drop stray matches of common words far from where the sentence really is.
      const mid = median(js);
      js = js.filter((j) => Math.abs(j - mid) <= Math.max(4, 2 * idx.length));
    }
    if (!js.length) return { score: 0 };
    for (const j of js) inLine[j] = true;
    const score = js.length / idx.length;
    const j0 = Math.min(...js);
    const j1 = Math.max(...js);
    const span = words.slice(j0, j1 + 1);
    return {
      score: pyRound(score, 2),
      start: words[j0].s,
      end: words[j1].e,
      said: span.map((w) => w.t).join(" "),
      conf: pyRound(mean(span.map((w) => w.p)), 2),
      j0,
      j1,
    };
  });
  return { matches, inLine };
}

/** How much of b's tokens, in order, a holds (0-1): the after-the-fact check of a finished cut by ear. */
export function heardInOrder(expected: string[], heard: string[]): { matched: number; total: number } {
  const matched = matchingBlocks(expected, heard).reduce((sum, [, , n]) => sum + n, 0);
  return { matched, total: expected.length };
}
