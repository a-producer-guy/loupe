// A scene's lines when nobody has added its script: every take is a full run
// of the scene, so the words most takes share are the dialogue. The take that
// agrees most with the others gives the wording and the sentences; who says
// each one comes from the sound (see coverage.ts): the same lines are loud in
// the takes where their actor is on camera.

import { matchingBlocks, mapping, norm, tokens, type ScriptLine, type Word } from "./text.js";

type Token = { t: string; word: number };

function tokensOf(words: Word[]): Token[] {
  const out: Token[] = [];
  words.forEach((w, word) => {
    for (const t of tokens(w.w)) out.push({ t: norm(t), word });
  });
  return out;
}

export type Sentence = { text: string; words: Word[] };

/**
 * The scene's sentences as said in its most typical take. `minShare` is the
 * share of the other takes a word must turn up in to count as the scene's.
 */
export function consensusSentences(all: Word[][], minShare = 0.4): { sentences: Sentence[]; reference: number } {
  // Each take from where its scene starts: the slate and crew calls before it aren't the scene's, even when every take
  // has them (shoot 1030's "This is one four. Stand by. Camera set." became its first lines, Oct 5).
  const takes = all.map((w) => w.slice(sceneStart(w)));
  const toks = takes.map(tokensOf);
  const plain = toks.map((list) => list.map((x) => x.t));
  // The reference: the take sharing the most words, in order, with all the others.
  const shared = plain.map((a, i) => plain.reduce((sum, b, j) => (i === j ? sum : sum + matchingBlocks(a, b).reduce((n, [, , k]) => n + k, 0)), 0));
  const reference = shared.indexOf(Math.max(...shared));
  const ref = toks[reference];
  const others = plain.filter((_, j) => j !== reference);
  if (!ref.length || !others.length) return { sentences: [], reference };

  // How many other takes have each of the reference's words (lined up in order).
  const support = new Array(ref.length).fill(0);
  for (const other of others) for (const i of mapping(plain[reference], other).keys()) support[i] += 1;
  const need = Math.max(1, minShare * others.length);
  // Smoothed over a few words either side; every stretch that holds up is the scene. (Not just the longest: a
  // take stopped and restarted midway splits the scene in two, and the longest half alone lost shoot 1052 its
  // opening, Oct 5.) The talk between stretches, said in that take alone, isn't.
  const half = 6;
  const smooth = support.map((_, i) => {
    const window = support.slice(Math.max(0, i - half), i + half + 1);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
  const runs: [number, number][] = [];
  for (let i = 0; i < ref.length; ) {
    if (smooth[i] < need) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < ref.length && smooth[j + 1] >= need) j += 1;
    // Trimmed to words that really are in most takes; a few stray words that happen to match aren't a stretch.
    let [from, to] = [i, j];
    while (from < to && support[from] < need) from += 1;
    while (to > from && support[to] < need) to -= 1;
    if (to - from + 1 >= 4 && support[from] >= need) runs.push([from, to]);
    i = j + 1;
  }
  if (!runs.length) return { sentences: [], reference };

  const words = takes[reference];
  const ends = (w: number) => /[.?!]["”']?$/.test(words[w].w.trim());
  const crewWord = (w: Word) => tokens(w.w).every((t) => CREW.has(norm(t)) || /^\d+$/.test(t));
  const supportOf = new Map<number, number>();
  ref.forEach((t, i) => supportOf.set(t.word, Math.max(supportOf.get(t.word) ?? 0, support[i])));
  const spans = runs.map(([from, to], k) => {
    let first = ref[from].word;
    const last = ref[to].word;
    // A stretch that only half matches at its start (an opening reworded on set) starts where its sentence does,
    // not partway in (shoot 1039 opened on "the wrong syringe?"). After a restart, only over words other takes share.
    const floor = k === 0 ? 0 : ref[runs[k - 1][1]].word + 1;
    let back = 0;
    while (
      first > floor &&
      !ends(first - 1) &&
      words[first].s - words[first - 1].e < 0.9 &&
      !CREW.has(norm(words[first - 1].w)) &&
      (k === 0 || ((supportOf.get(first - 1) ?? 0) >= 1 && back < 10))
    ) {
      first -= 1;
      back += 1;
    }
    // And ends where its sentence does: a line worded differently from take to take ("He just had to answer me")
    // isn't cut off partway, as long as other takes share its words.
    let end = last;
    let on = 0;
    const ceiling = k + 1 < runs.length ? ref[runs[k + 1][0]].word - 1 : words.length - 1;
    while (end < ceiling && !ends(end) && words[end + 1].s - words[end].e < 0.9 && (supportOf.get(end + 1) ?? 0) >= 1 && !crewWord(words[end + 1]) && on < 12) {
      end += 1;
      on += 1;
    }
    // Kept only when it got to a natural end: a full stop, a pause, or the next stretch.
    const natural = ends(end) || end === ceiling || (end + 1 < words.length && words[end + 1].s - words[end].e >= 0.9);
    return [first, natural ? end : last] as [number, number];
  });
  // The slate and "action" before the first stretch, "cut" and what follows at the end: the crew's words, even when
  // every take has them.
  while (spans[0][0] < spans[0][1] && crewWord(words[spans[0][0]])) spans[0][0] += 1;
  let cutAt = Infinity;
  for (const [first, last] of spans) {
    for (let w = first + 1; w <= last && cutAt === Infinity; w++) {
      if (ends(w - 1) && tokens(words[w].w).some((t) => t === "cut" || t === "cutting")) cutAt = w;
    }
  }
  const kept = spans.filter(([first]) => first < cutAt).map(([first, last]) => [first, Math.min(last, cutAt - 1)] as [number, number]);
  const lastSpan = kept.at(-1)!;
  // What's said just before "cut" in this take alone isn't the scene either.
  if (lastSpan[1] === cutAt - 1) while (lastSpan[1] > lastSpan[0] && (supportOf.get(lastSpan[1]) ?? 0) < need) lastSpan[1] -= 1;
  while (lastSpan[1] > lastSpan[0] && crewWord(words[lastSpan[1]])) lastSpan[1] -= 1;

  const sentences: Sentence[] = [];
  for (const [first, last] of kept) {
    let current: Word[] = [];
    for (let w = first; w <= last; w++) {
      current.push(words[w]);
      const next = words[w + 1];
      const pause = next ? next.s - words[w].e : 0;
      if (w === last || ends(w) || pause >= 0.9) {
        const text = current.map((x) => x.w.trim()).join(" ").replace(/\s+([,.?!])/g, "$1");
        // A restart says the line before it again: once is enough.
        const said = tokens(text).map(norm).join(" ");
        const previous = sentences.at(-1);
        const again = w <= current.length + first && previous && tokens(previous.text).map(norm).join(" ").endsWith(said);
        if (tokens(text).length && !again) sentences.push({ text, words: current });
        current = [];
      }
    }
  }
  // The crew's words at either end ("Set." "Action." "Cut!") are said in every take too.
  const crew = (s: Sentence) => tokens(s.text).every((t) => CREW.has(norm(t)));
  while (sentences.length && crew(sentences[0])) sentences.shift();
  while (sentences.length && crew(sentences.at(-1)!)) sentences.pop();
  return { sentences, reference };
}

const CREW = new Set(
  ("set settle settling action rolling roll rolls speed speeding sound camera cameras mark marker sticks slate cut cutting background " +
    "scene take and okay ok go reset still stand by standby here we thats it moving on " +
    "one two three four five six seven eight nine ten eleven twelve a b c").split(" "),
);
const NUMBER = /^(\d+|zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth|sixth)$/;
/** Words said around the slate that aren't the crew's calls but aren't the scene either. */
const FILLER = new Set("alright all right yeah yes great thank thanks you please ready rock hmm mm mmm uh um oh got right sit".split(" "));
const crewish = (t: string) => CREW.has(t) || NUMBER.test(t) || FILLER.has(t);

/**
 * A slate or crew call: "Camera set.", "This is one four.", "First Blood,
 * shot two, take one.", "Okay, we got four take one."
 */
export function crewSentence(text: string): boolean {
  const t = tokens(text).map(norm);
  return !t.length || t.every(crewish) || isSlate(t);
}

/**
 * Where a take's scene starts: right after the director's "Action" near the
 * start (said as a call, on its own or ending a short crew call like "Camera
 * set, action."), or the gentler call some directors give instead ("And when
 * you're ready, go ahead."), or, with no call heard, after the slate and crew
 * calls it opens with. The last such call in the opening counts (a restart).
 */
export function sceneStart(words: Word[]): number {
  // The opening, where the calls are: a director's slate and words before them can run to twenty words or more.
  const opening = Math.max(24, Math.ceil(words.length * 0.3));
  const ends = (i: number) => /[.?!,]["”']?$/.test(words[i].w.trim()) || (i + 1 < words.length && words[i + 1].s - words[i].e >= 0.4);
  let start = 0;
  let from = 0; // where the sentence being read began
  let before: string[] = []; // the sentence before it
  let longest = 0; // the longest sentence so far: the scene's lines are longer than the crew's calls
  for (let i = 0; i < Math.min(words.length - 1, opening); i++) {
    const end = ends(i) || /[.?!]["”']?$/.test(words[i].w.trim());
    if (!end) continue;
    const sentence = words.slice(from, i + 1).map((w) => w.w).join(" ");
    const t = tokens(sentence).map(norm);
    if (t.includes("action") && t.length <= 5 && t.every((x) => x === "action" || crewish(x))) start = i + 1;
    // "When you're ready, go ahead" (shoot 1007, Oct 5: its director's call on most takes, which had made it and the
    // "take a breath" before it the scene's first lines, heard from across the room). Only before any line of the
    // scene, which may say "go ahead" too.
    const call = [...before, ...t].join(" ");
    if (longest <= 8 && /\b(when|whenever) (youre|you are) ready (go ahead|go|begin)$/.test(call)) start = i + 1;
    longest = Math.max(longest, t.length);
    before = t;
    from = i + 1;
  }
  if (start) return start;
  // No "Action": after the slate if the take opens with one ("Do whatever it is. First blood shot. Two, take one."),
  // then past the crew's calls that follow it (or that the take opens with).
  const early: { to: number; t: string[] }[] = [];
  from = 0;
  for (let i = 0; i < Math.min(words.length - 1, Math.max(12, Math.min(60, Math.ceil(words.length * 0.15)))); i++) {
    if (!(ends(i) || words[i + 1].s - words[i].e >= 0.9)) continue;
    early.push({ to: i, t: tokens(words.slice(from, i + 1).map((w) => w.w).join(" ")).map(norm) });
    from = i + 1;
  }
  let k = 0;
  early.forEach((s, j) => {
    if (isSlate(s.t)) k = j + 1;
  });
  while (k < early.length && early[k].t.every(crewish)) k += 1;
  return k ? early[k - 1].to + 1 : 0;
}

/** The slate read out: a shot, take or scene and its number ("take two"), "this is" and numbers, or numbers alone ("Two, one."). */
function isSlate(t: string[]): boolean {
  if (!t.length) return false;
  if (t.some((x, i) => (x === "take" || x === "shot" || x === "scene") && NUMBER.test(t[i + 1] ?? ""))) return true;
  if (t[0] === "this" && t[1] === "is" && t.length > 2 && t.slice(2).every(crewish)) return true;
  return t.every((x) => NUMBER.test(x));
}

export const CLIENT = "CLIENT";
export const PARTNER = "PARTNER";

/**
 * A script from sentences and who says each (±1, from coverage.ts):
 * consecutive sentences by the same actor make one speech. `clientSide` is
 * the side on camera in the first take (usually the lead, who tends to be filmed first).
 */
export function scriptFrom(sentences: Sentence[], speaker: number[], clientSide: 1 | -1): ScriptLine[] {
  const lines: ScriptLine[] = [];
  sentences.forEach((s, i) => {
    const who = speaker[i] === clientSide ? CLIENT : PARTNER;
    const previous = lines.at(-1);
    if (previous && previous.kind === "speech" && previous.who === who) previous.text = `${previous.text} ${s.text}`;
    else lines.push({ kind: "speech", who, text: s.text });
  });
  return lines;
}
