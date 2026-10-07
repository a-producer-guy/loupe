// What goes wrong in a take, and cutting on a movement (Guy, Oct 5, 2026:
// harden what lazy editors skip; "Read 'Blink of an Eye'").

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { alignTakes, assembleAligned, FPS, onMovement, type Setup, type Take, type TakeInput } from "../src/assembly/engine.js";
import { lineFlaws, SHARP_RATE, THUMB, type Picture } from "../src/assembly/picture.js";
import { buildUnits, type ScriptLine, type Word } from "../src/assembly/text.js";

// Every name here is made up.
const SCRIPT: ScriptLine[] = [
  { kind: "speech", who: "ANA", text: "You came back. I didn't think you would." },
  { kind: "speech", who: "BEN", text: "I forgot my keys." },
  { kind: "speech", who: "ANA", text: "Your keys are in the drawer, where they always are." },
  { kind: "speech", who: "BEN", text: "Maybe I wanted to see you." },
  { kind: "speech", who: "ANA", text: "Then say it properly this time." },
];

function take(n: number, setup: Setup, pace: number): TakeInput {
  const words: Word[] = [];
  let t = 4;
  const say = (text: string) => {
    for (const w of text.split(" ")) {
      words.push({ w, s: t, e: t + 0.3 * pace, p: 0.95 });
      t += 0.38 * pace;
    }
  };
  say(`Scene one, take ${n}. Action.`);
  t += 1.2;
  for (const line of SCRIPT) {
    if (line.kind !== "speech") continue;
    t += 0.9;
    say(line.text);
  }
  t += 1.5;
  say("Cut.");
  return { take: `T00${n}`, path: `Raw/A001/CLIP_T00${n}.MOV`, length: t + 2, timecode: null, setup, words };
}

const TAKES = [
  take(1, { who: "ANA", framing: "medium" }, 1.0),
  take(2, { who: "ANA", framing: "medium" }, 1.03),
  take(3, { who: "BEN", framing: "medium" }, 1.0),
  take(4, { who: "BEN", framing: "medium" }, 0.98),
];
const units = buildUnits(SCRIPT);
const cutOf = (flaw?: (takes: ReturnType<typeof alignTakes>) => void) => {
  const aligned = alignTakes(units, TAKES);
  flaw?.(aligned);
  return assembleAligned("Keys", "ANA", ["ANA", "BEN"], units, aligned);
};

/** A room as 16 by 9 blocks: a window on the left, an actor in the middle. */
const ROOM = Float32Array.from({ length: THUMB }, (_, i) => (i % 16 < 4 ? 200 : i % 16 > 6 && i % 16 < 10 && i >= 48 ? 140 : 60));
/** The same room with the camera swung onto a prop: other blocks bright. */
const PROP = Float32Array.from({ length: THUMB }, (_, i) => (i % 16 > 10 ? 210 : i < 40 ? 120 : 50));

/** A take's picture with nothing wrong: a little movement, sharp throughout, always the same room. */
function still(t: TakeInput): Picture {
  const seconds = (t.length ?? 40) + 1;
  const n = Math.round(seconds * FPS);
  const shots = Math.round(seconds * SHARP_RATE);
  const [motion, edges, middle] = [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.3), new Float32Array(n).fill(0.6)];
  const thumbs = new Float32Array(shots * THUMB);
  for (let i = 0; i < shots; i++) thumbs.set(ROOM, i * THUMB);
  return { motion, edges, middle, sharp: new Float32Array(shots).fill(400), thumbs };
}
const showing = (p: Picture, from: number, to: number, what: Float32Array) => {
  for (let i = Math.floor(from * SHARP_RATE); i <= Math.ceil(to * SHARP_RATE); i++) p.thumbs.set(what, i * THUMB);
};
const lineOf = (takes: Take[], name: string, line: number) => takes.find((t) => t.take === name)!.matches[line] as { start: number; end: number };
const flawsOf = (flaws: Map<string, { what: string; s: number }[]>) =>
  [...flaws].flatMap(([take, list]) => list.map((f) => `${take} ${f.what}`)).sort();

describe("flaws, against the setup's other takes", () => {
  test("soft focus: far softer than another take of the setup showing the same picture there", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    const m = lineOf(takes, "T001", 2);
    pictures.get("T001")!.sharp.fill(90, Math.ceil(m.start * SHARP_RATE), Math.floor(m.end * SHARP_RATE));
    const flaws = lineFlaws(takes, pictures);
    assert.deepEqual(flawsOf(flaws), ["T001 soft focus"]);
    assert.equal(flaws.get("T001")![0].s, m.start);
  });

  test("not where every take of the setup goes softer (the actor moves into a plainer part of the room)", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    for (const name of ["T001", "T002"]) {
      const m = lineOf(takes, name, 4);
      pictures.get(name)!.sharp.fill(90, Math.floor(m.start * SHARP_RATE), Math.ceil(m.end * SHARP_RATE));
    }
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), []);
  });

  test("not where the camera has swung somewhere else (a handheld scene), or the take is darker there", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    const m = lineOf(takes, "T001", 2);
    const p = pictures.get("T001")!;
    p.sharp.fill(90, Math.floor(m.start * SHARP_RATE), Math.ceil(m.end * SHARP_RATE));
    showing(p, m.start, m.end, PROP);
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), [], "onto a prop");
    showing(p, m.start, m.end, ROOM.map((v) => v * 0.5));
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), [], "darker");
    showing(p, m.start, m.end, ROOM);
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), ["T001 soft focus"], "the same picture, soft");
  });

  test("not where the take is only blurred by the actor moving more", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    const m = lineOf(takes, "T001", 2);
    pictures.get("T001")!.sharp.fill(90, Math.ceil(m.start * SHARP_RATE), Math.floor(m.end * SHARP_RATE));
    pictures.get("T001")!.motion.fill(6, Math.floor(m.start * FPS), Math.ceil(m.end * FPS));
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), []);
  });

  test("a bumped camera: a jolt of a few frames moving the whole frame, still before and after, where the other take is still", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    const m = lineOf(takes, "T003", 3);
    const p = pictures.get("T003")!;
    const at = Math.round(((m.start + m.end) / 2) * FPS);
    for (let f = at; f < at + 4; f++) [p.edges[f], p.middle[f], p.motion[f]] = [14, 12, 13];
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), ["T003 camera bump"]);
  });

  test("not a pan every take makes, a slow reframe, or someone crossing the edge of the frame", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    // The operator whips to the door on Ben's first line in both his takes.
    for (const name of ["T003", "T004"]) {
      const m = lineOf(takes, name, 1);
      const p = pictures.get(name)!;
      const at = Math.round(m.start * FPS) + 2;
      for (let f = at; f < at + 4; f++) [p.edges[f], p.middle[f]] = [20, 18];
    }
    // A slow reframe in one take: the whole frame drifts for two seconds.
    const r = lineOf(takes, "T003", 3);
    const p3 = pictures.get("T003")!;
    for (let f = Math.round(r.start * FPS); f < Math.round(r.start * FPS) + 48; f++) [p3.edges[f], p3.middle[f]] = [9, 8];
    // Someone crosses the edge of Ana's frame: the edge moves, she doesn't.
    const c = lineOf(takes, "T001", 2);
    const p1 = pictures.get("T001")!;
    for (let f = Math.round(c.start * FPS) + 5; f < Math.round(c.start * FPS) + 9; f++) p1.edges[f] = 15;
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), []);
  });

  test("the camera off its actor: a handheld close-up that swings away where the setup's other take stays on them", () => {
    const close = TAKES.map((t) => ({ ...t, setup: { ...t.setup!, framing: "close" as const } }));
    const takes = alignTakes(units, close);
    const pictures = new Map(close.map((t) => [t.take, still(t)]));
    const m = lineOf(takes, "T001", 2);
    showing(pictures.get("T001")!, m.start, m.end, PROP);
    const flaws = lineFlaws(takes, pictures, { handheld: true });
    assert.deepEqual(flawsOf(flaws), ["T001 camera off the actor"]);
    // A steady camera that leaves its picture has gone with its actor (one standing up): not off them.
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures)), []);
    // Both takes swing there (the move is the scene's): neither is off.
    showing(pictures.get("T002")!, lineOf(takes, "T002", 2).start, lineOf(takes, "T002", 2).end, PROP);
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures, { handheld: true })), []);
  });

  test("not in a wider shot, where the actor can move about the frame and still be the shot", () => {
    const takes = alignTakes(units, TAKES);
    const pictures = new Map(TAKES.map((t) => [t.take, still(t)]));
    const m = lineOf(takes, "T001", 2);
    showing(pictures.get("T001")!, m.start, m.end, PROP);
    assert.deepEqual(flawsOf(lineFlaws(takes, pictures, { handheld: true })), []);
  });

  test("the cut takes a line from another take when the one it would use is soft there", () => {
    const plain = cutOf();
    const line = 3; // Ben's "Maybe I wanted to see you."
    const block = plain.blocks.find((b) => b.first <= line && line <= b.last)!;
    const flawedCut = cutOf((takes) => {
      const t = takes.find((x) => x.take === block.take)!;
      const m = t.matches[line] as { start: number; end: number };
      t.flaws.push({ s: m.start - 0.2, e: m.end + 0.2, what: "soft focus", cost: 0.5 });
    });
    const now = flawedCut.blocks.find((b) => b.first <= line && line <= b.last)!;
    assert.notEqual(now.take, block.take, `still ${block.take}`);
  });
});

describe("cutting on a movement", () => {
  test("a cut moves a few frames onto a movement in the outgoing shot, and both shots stay in sync", () => {
    const cut = cutOf();
    const k = 0;
    const [p, q] = [cut.video[k], cut.video[k + 1]];
    const motion = new Map(TAKES.map((t) => [t.take, new Float32Array(Math.round(40 * FPS)).fill(0.5)]));
    // The outgoing actor turns their head two frames after the cut.
    const at = Math.round((p.out + 2 / FPS) * FPS);
    for (let f = at - 3; f < at; f++) motion.get(p.take)![f] = 6;
    const { cut: moved, moved: count } = onMovement(cut, motion);
    const [p2, q2] = [moved.video[k], moved.video[k + 1]];
    assert.equal(count, 1);
    assert.equal(Math.round((p2.recOut - p.recOut) * FPS), 2);
    assert.equal(p2.recOut, q2.recIn, "still back to back");
    assert.ok(Math.abs(p2.out - p2.recOut - (p.out - p.recOut)) < 0.002 && Math.abs(q2.in - q2.recIn - (q.in - q.recIn)) < 0.002, "in sync");
    assert.deepEqual(moved.audio, cut.audio, "the sound doesn't move");
  });

  test("never so that a shot shows its actor talking unheard, and only for a clear gain", () => {
    const cut = cutOf();
    const [p] = cut.video;
    const motion = new Map(TAKES.map((t) => [t.take, new Float32Array(Math.round(40 * FPS)).fill(0.5)]));
    assert.equal(onMovement(cut, motion).moved, 0, "nothing moves anywhere: no cut moves");
    // A movement just after the cut, but the outgoing actor says something there (unheard: the sound is the next take's).
    const at = Math.round((p.out + 2 / FPS) * FPS);
    for (let f = at - 3; f < at; f++) motion.get(p.take)![f] = 6;
    assert.equal(onMovement(cut, motion).moved, 1, "free to move");
    const take = cut.takes.find((t) => t.take === p.take)!;
    take.words.push({ s: p.out + 0.03, e: p.out + 0.2, t: "well", inLine: false, stop: false });
    take.words.sort((x, y) => x.s - y.s);
    assert.equal(onMovement(cut, motion).moved, 0, "not onto words nobody hears");
  });
});
