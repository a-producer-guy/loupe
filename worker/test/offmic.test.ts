// Off mic (Guy, Oct 5, 2026): nobody is heard from the wrong mic, and no word
// is heard twice, even when the actors play a moment in a different order from
// one take to the next (shoot 1053: the doctor's take had "Maybe five, if I can
// stabilize her long enough", then the husband's "Five minutes?" off mic, "Yes",
// and his "Okay").

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { seeded } from "../src/assembly/audio.js";
import { offMicTalk, speechSound } from "../src/assembly/coverage.js";
import { alignTakes, assembleAligned, type Setup, type TakeInput } from "../src/assembly/engine.js";
import { buildUnits, type ScriptLine, type Word } from "../src/assembly/text.js";

// Every name here is made up.
const SCENE: ScriptLine[] = [
  { kind: "speech", who: "DOCTOR", text: "She is stable for now, but it will not last." },
  { kind: "speech", who: "HUSBAND", text: "How long do we have?" },
  { kind: "speech", who: "DOCTOR", text: "A few minutes. Maybe five." },
  { kind: "speech", who: "HUSBAND", text: "Five minutes?" },
  { kind: "speech", who: "DOCTOR", text: "If I can stabilize her long enough, yes." },
  { kind: "speech", who: "HUSBAND", text: "Then give me that." },
];

type Said = { who: string; text: string; gap?: number };
/** A take as Whisper hears it, and which of its words each actor said. */
function take(n: number, setup: Setup, lines: Said[]): { input: TakeInput; by: string[] } {
  const words: Word[] = [];
  const by: string[] = [];
  let t = 2;
  const say = (who: string, text: string) => {
    for (const w of text.split(" ")) {
      words.push({ w, s: t, e: t + 0.28, p: 0.95 });
      by.push(who);
      t += 0.34;
    }
  };
  say("CREW", `Scene nine, take ${n}. Mark. Action.`);
  t += 1.5;
  for (const line of lines) {
    t += line.gap ?? 0.7;
    say(line.who, line.text);
  }
  t += 1.0;
  say("CREW", "Cut.");
  return { input: { take: `T0${20 + n}`, path: `Raw/A003/CLIP_T0${20 + n}.MOV`, length: t + 2, timecode: null, setup, words }, by };
}

// The husband's takes play it as written; the doctor's play the middle in their own order, with his ad-libs.
const asWritten = (): Said[] => SCENE.map((l) => ({ who: l.kind === "speech" ? l.who : "", text: l.kind === "speech" ? l.text : "" }));
const doctorsWay: Said[] = [
  { who: "DOCTOR", text: "She is stable for now," },
  { who: "HUSBAND", text: "Mm.", gap: 0.15 },
  { who: "DOCTOR", text: "but it will not last.", gap: 0.15 },
  { who: "HUSBAND", text: "How long do we have?" },
  { who: "DOCTOR", text: "A few minutes. Maybe five" },
  { who: "DOCTOR", text: "if I can stabilize her long enough.", gap: 0.05 },
  { who: "HUSBAND", text: "Five minutes?", gap: 0.1 },
  { who: "DOCTOR", text: "Yes.", gap: 0.4 },
  { who: "HUSBAND", text: "Okay.", gap: 0.3 },
  { who: "HUSBAND", text: "Then give me that.", gap: 0.6 },
];

describe("off mic, never twice (shoot 1053, Oct 5)", () => {
  const made = [
    take(1, { who: "DOCTOR", framing: "close" }, doctorsWay),
    take(2, { who: "DOCTOR", framing: "close" }, doctorsWay),
    take(3, { who: "HUSBAND", framing: "close" }, asWritten()),
    take(4, { who: "HUSBAND", framing: "close" }, asWritten()),
  ];
  const units = buildUnits(SCENE);
  const aligned = alignTakes(units, made.map((m) => m.input));
  // The doctor's takes: the husband's "Mm." in the middle of her line sounds off mic (as offMicTalk finds it).
  for (const [t, m] of made.entries()) {
    const i = m.input.words.findIndex((w) => w.w === "Mm.");
    if (i >= 0) aligned[t].offMic = [[m.input.words[i].s, m.input.words[i].e]];
  }
  const cut = assembleAligned("Five Minutes", "HUSBAND", ["DOCTOR", "HUSBAND"], units, aligned);
  const T = new Map(made.map((m) => [m.input.take, m]));
  /** Each word heard, with who said it and which take it comes from. */
  const heard = cut.audio.flatMap((a) => {
    const m = T.get(a.take)!;
    return m.input.words.flatMap((w, i) => {
      const inside = Math.min(w.e, a.out) - Math.max(w.s, a.in);
      return inside > 0.5 * (w.e - w.s) ? [{ take: a.take, i, w: w.w, by: m.by[i], mic: m.input.setup!.who }] : [];
    });
  });

  test("nobody is heard from the other actor's mic: not their lines, not their ad-libs", () => {
    const wrong = heard.filter((h) => h.by !== "CREW" && h.by !== h.mic);
    assert.deepEqual(
      wrong.map((h) => `${h.w} (${h.by} in ${h.take})`),
      [],
    );
    assert.ok(!heard.some((h) => h.by === "CREW"), "no slate or crew");
  });

  test("every line is heard once, and no stretch of a take is played twice", () => {
    const said = heard.map((h) => h.w.toLowerCase().replace(/[^a-z]/g, "")).join(" ");
    for (const line of SCENE) {
      if (line.kind !== "speech") continue;
      const words = line.text.toLowerCase().replace(/[^a-z ]/g, "").split(" ");
      const key = words.slice(0, 3).join(" ");
      assert.equal(said.split(key).length - 1, 1, `"${line.text}" heard once (heard: ${said})`);
    }
    for (const [i, a] of cut.audio.entries())
      for (const b of cut.audio.slice(i + 1)) if (a.take === b.take) assert.ok(Math.min(a.out, b.out) - Math.max(a.in, b.in) < 0.05, `${a.take} played twice`);
  });

  test("a shot never shows its actor saying what isn't heard", () => {
    for (const p of cut.video) {
      const m = T.get(p.take)!;
      const sound = cut.audio.filter((a) => a.take === p.take);
      m.input.words.forEach((w, i) => {
        if (m.by[i] !== m.input.setup!.who || w.e <= p.in + 0.05 || w.s >= p.out - 0.05) return;
        assert.ok(
          sound.some((a) => a.in <= w.s + 0.1 && a.out >= w.e - 0.1),
          `${p.take} shows "${w.w}" without its sound`,
        );
      });
    }
  });
});

describe("telling off-mic talk by its sound", () => {
  // A take on Ana: her lines close to the boom (loud and bright), Ben's across the room (quieter and duller), then
  // two words in no line: Ben muttering off mic, and Ana whispering close to the mic.
  const rate = 16000;
  const random = seeded(11);
  const audio = new Float32Array(16 * rate);
  for (let i = 0; i < audio.length; i++) audio[i] = (random() - 0.5) * 2e-4;
  let low = 0;
  const voice = (s: number, e: number, level: number, dull: boolean) => {
    for (let i = Math.floor(s * rate); i < Math.floor(e * rate); i++) {
      const raw = random() - 0.5;
      low += 0.12 * (raw - low); // a one-pole low-pass: what distance and the mic's sides take off
      const buzz = Math.sin((2 * Math.PI * 140 * i) / rate) * 0.6;
      audio[i] += 10 ** (level / 20) * (dull ? buzz + 3 * low : buzz + raw);
    }
  };
  const words: Word[] = [];
  const line = (text: string, s: number, level: number, dull: boolean) => {
    const ws = text.split(" ");
    ws.forEach((w, k) => words.push({ w, s: s + k * 0.35, e: s + k * 0.35 + 0.3, p: 0.95 }));
    voice(s, s + ws.length * 0.35, level, dull);
  };
  const lines: ScriptLine[] = [
    { kind: "speech", who: "ANA", text: "I locked the door before I left." },
    { kind: "speech", who: "BEN", text: "Then who opened it?" },
    { kind: "speech", who: "ANA", text: "Somebody who had a key." },
    { kind: "speech", who: "BEN", text: "Nobody has a key but us." },
  ];
  line("I locked the door before I left.", 1, -18, false);
  line("Then who opened it?", 4, -31, true);
  line("Somebody who had a key.", 6.5, -18, false);
  line("Nobody has a key but us.", 9, -31, true);
  line("Unbelievable.", 12, -32, true); // Ben, off mic, in no line
  line("Wait.", 14, -30, false); // Ana, whispered close to the mic
  const [x] = alignTakes(buildUnits(lines), [{ take: "T001", path: "T001.MOV", length: 16, timecode: null, setup: { who: "ANA", framing: "close" }, words }]);

  test("quieter and duller than the actor on camera, like the other actor's lines: off mic", () => {
    const close = speechSound(audio, rate, 1, 3.4)!;
    const far = speechSound(audio, rate, 4, 5.4)!;
    assert.ok(close.level - far.level > 10 && close.bright - far.bright > 3, `close ${JSON.stringify(close)}, far ${JSON.stringify(far)}`);
    const off = offMicTalk(x, buildUnits(lines), audio, rate);
    assert.deepEqual(off.map(([s]) => Math.round(s)), [12], "Ben's mutter, and not Ana's whisper");
  });

  test("a take where both actors sound alike marks nothing", () => {
    const same = new Float32Array(16 * rate);
    const r = seeded(4);
    for (let i = 0; i < same.length; i++) same[i] = (r() - 0.5) * 0.05;
    assert.deepEqual(offMicTalk(x, buildUnits(lines), same, rate), []);
  });
});

