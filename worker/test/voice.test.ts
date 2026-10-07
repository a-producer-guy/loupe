// Each actor sounding the same in every shot (Guy, Oct 5, 2026: what lazy
// editors skip, #8), on made-up takes of one voice: as heard from a medium
// shot, and from a close-up whose boom made it fuller and duller.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterAudio, loudness, readAudio, seeded, segments, SR, writeAudio } from "../src/assembly/audio.js";
import { cleanTake, colourOf, DIALOGUE_LUFS, matchVoice, PEAK_OVER, VOICE_BANDS, voiceMatch, type VoiceColour } from "../src/assembly/dialogue.js";
import type { Take } from "../src/assembly/engine.js";
import type { Unit } from "../src/assembly/text.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();
const work = mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
const band = (f: number) => VOICE_BANDS.indexOf(f);

/** A voice saying a line from `start` to `end`: a buzz of harmonics in syllables, its pitch wandering, an "s" now and then. */
function say(out: Float32Array, start: number, end: number, level: number, random: () => number, pitch = 130) {
  const peak = 10 ** (level / 20);
  let phase = 0;
  for (let i = Math.floor(start * SR); i < Math.floor(end * SR); i++) {
    const t = i / SR - start;
    phase += (2 * Math.PI * (pitch + 35 * Math.sin(2 * Math.PI * 0.9 * t) + 12 * Math.sin(2 * Math.PI * 3.1 * t))) / SR;
    const syllable = Math.max(0, Math.sin(Math.PI * 4 * t)) ** 1.5;
    let buzz = 0;
    for (let k = 1; k < 60; k++) buzz += Math.sin(k * phase + k) / k;
    const s = t % 1 > 0.8 && t % 1 < 0.9 ? (random() - 0.5) * 0.6 : 0;
    out[i] += peak * (0.35 * buzz * syllable + s);
  }
}

const LINES: [number, number][] = [
  [1.0, 4.0],
  [5.5, 8.5],
  [10.0, 13.0],
];
const units: Unit[] = LINES.map((_, i) => ({ who: "A", text: `Line ${i + 1}.`, speechStart: true, actionBefore: "", speech: i }));
const takeOf = (name: string, who = "A", framing = "medium") =>
  ({
    take: name,
    path: `Raw/${name}.MOV`,
    length: 15,
    timecode: null,
    setup: { who, framing },
    matches: LINES.map(([start, end], i) => ({ score: 1, start, end, said: `Line ${i + 1}.`, conf: 1, j0: i, j1: i + 1 })),
    sceneStart: 1,
    sceneEnd: 13,
    cleanFrom: 0,
    stray: [],
  }) as unknown as Take;

/** One take of the voice, through `colour` (an FFmpeg filter, as the mic and room heard it), over a little hiss. */
async function takeSound(name: string, seed: number, colour: string | null, { level = -14, pitch = 130 } = {}) {
  const random = seeded(seed);
  let voice: Float32Array = new Float32Array(15 * SR);
  for (const [s, e] of LINES) say(voice, s, e, level, random, pitch);
  if (colour) voice = await filterAudio(ffmpeg, voice, colour, SR);
  for (let i = 0; i < voice.length; i++) voice[i] += (random() - 0.5) * 2 * 10 ** (-66 / 20) * Math.sqrt(3);
  const file = path.join(work, `${name}.wav`);
  await writeAudio(ffmpeg, file, [voice, voice], SR, "pcm_s24le");
  return file;
}
const CLOSE = "equalizer=f=250:t=o:w=1.5:g=6,equalizer=f=4000:t=o:w=1.5:g=-5";
/** A boom placed badly for one setup: far fuller and duller. */
const BADLY = "equalizer=f=250:t=o:w=1.5:g=9,equalizer=f=4000:t=o:w=1.5:g=-8";

describe("each actor sounding the same in every shot", () => {
  test("a take's voice colour, as cleaned: the close-up's boom still heard as fuller and duller", async () => {
    const [medium, close] = [await takeSound("T001", 1, null), await takeSound("T003", 3, CLOSE)];
    const a = (await cleanTake(ffmpeg, units, takeOf("T001"), medium, path.join(work, "T001_dialogue.wav"))).colour!;
    const b = (await cleanTake(ffmpeg, units, takeOf("T003", "A", "close"), close, path.join(work, "T003_dialogue.wav"))).colour!;
    assert.ok(a.seconds >= 3, `${a.seconds} s of voice`);
    assert.equal(a.who, "A");
    const d = (f: number) => b.bands[band(f)] - a.bands[band(f)] - (b.bands[band(1000)] - a.bands[band(1000)]);
    assert.ok(d(250) > 1.5, `250 Hz ${d(250).toFixed(1)} dB fuller`);
    assert.ok(d(4000) < -1.5, `4 kHz ${d(4000).toFixed(1)} dB duller`);
  });

  test("the hiss between lines isn't the voice's colour", () => {
    const random = seeded(9);
    const x = new Float32Array(15 * SR);
    for (const [s, e] of LINES) say(x, s, e, -14, random);
    const clean = colourOf(x, LINES, [[4.2, 5.3], [8.7, 9.8]])!;
    // A loud hiss with a lot of top end, everywhere.
    const hissy = Float32Array.from(x, (v) => v + (random() - 0.5) * 2 * 10 ** (-40 / 20) * Math.sqrt(3));
    const noisy = colourOf(hissy, LINES, [[4.2, 5.3], [8.7, 9.8]])!;
    const top = band(8000);
    assert.ok(Math.abs(noisy.bands[top] - clean.bands[top]) < 3, `8 kHz ${clean.bands[top].toFixed(1)} → ${noisy.bands[top].toFixed(1)} dB`);
  });

  test("only a take that stands out is moved, gently, toward its actor's usual sound, never another actor's", () => {
    const flat = [60, 62, 61, 58, 54, 50, 44];
    const snr = flat.map(() => 30);
    const colours: VoiceColour[] = [
      { take: "T001", who: "A", bands: flat, snr, seconds: 20 },
      { take: "T002", who: "A", bands: flat.map((v) => v + 0.3), snr, seconds: 20 },
      // The close-up: fuller at 250 Hz, duller at 4 kHz.
      { take: "T003", who: "A", bands: flat.map((v, b) => v + (b === 1 ? 6 : b === 5 ? -5 : 0)), snr, seconds: 20 },
      // Ben's voice is his own, and with one take there's nothing to match.
      { take: "T004", who: "B", bands: flat.map((v, b) => v + b), snr, seconds: 20 },
    ];
    const match = voiceMatch(colours);
    assert.deepEqual(match.get("T003"), [0, -4, 0, 0, 0, 3, 0], "the close-up's 250 Hz cut, its 4 kHz lifted, nothing else");
    assert.deepEqual([...match.keys()], ["T003"], "the medium shots and Ben's one take left as they are");
    const others = colours.slice(0, 2);
    // A much fuller take is cut at most 4 dB; a take only quieter isn't moved at all; nor is a band 2 dB off.
    assert.deepEqual(voiceMatch([...others, { take: "T005", who: "A", bands: flat.map((v, b) => v + (b < 2 ? 15 : 0)), snr, seconds: 20 }]).get("T005"), [-4, -4, 0, 0, 0, 0, 0]);
    assert.equal(voiceMatch([...others, { take: "T006", who: "A", bands: flat.map((v) => v - 10), snr, seconds: 20 }]).size, 0, "only quieter");
    assert.equal(voiceMatch([...others, { take: "T007", who: "A", bands: flat.map((v, b) => v + (b === 5 ? -2 : 0)), snr, seconds: 20 }]).size, 0, "2 dB off");
    // A band with little voice in it is mostly the room: a take with less of it isn't lifted there.
    const thin = { take: "T008", who: "A", bands: flat.map((v, b) => v + (b === 0 ? -8 : 0)), snr: snr.map((x, b) => (b === 0 ? 4 : x)), seconds: 20 };
    assert.equal(voiceMatch([...others, thin]).size, 0, "the room isn't lifted");
    assert.deepEqual(voiceMatch([...others, { ...thin, snr }]).get("T008"), [3, 0, 0, 0, 0, 0, 0], "the voice is");
    // Two takes of an actor are too few to tell which one stands out.
    assert.equal(voiceMatch([colours[0], colours[2]]).size, 0);
  });

  test("matched, the close-up sounds like the medium shots, as loud and held as before, in sync", async () => {
    const takes = [takeOf("T001"), takeOf("T002"), takeOf("T003", "A", "close")];
    const files = [await takeSound("T001", 1, null), await takeSound("T002", 2, null), await takeSound("T003", 3, BADLY)];
    const outs = takes.map((t) => path.join(work, `${t.take}-m_dialogue.wav`));
    const colours = await Promise.all(takes.map(async (t, i) => (await cleanTake(ffmpeg, units, t, files[i], outs[i])).colour!));
    const match = voiceMatch(colours);
    assert.deepEqual([...match.keys()], ["T003"]);
    const [before] = await readAudio(ffmpeg, outs[2], 1, SR);
    await matchVoice(ffmpeg, units, takes[2], outs[2], match.get("T003")!);
    const [after] = await readAudio(ffmpeg, outs[2], 1, SR);
    const [medium] = await readAudio(ffmpeg, outs[0], 1, SR);
    const colour = (x: Float32Array) => {
      const c = colourOf(x, LINES, [])!.bands;
      return c.map((v) => v - c[band(1000)]);
    };
    const [m, was, now] = [colour(medium), colour(before), colour(after)];
    for (const f of [250, 4000]) {
      const [off, left] = [Math.abs(was[band(f)] - m[band(f)]), Math.abs(now[band(f)] - m[band(f)])];
      assert.ok(left < 0.6 * off, `${f} Hz: ${off.toFixed(1)} dB off the medium shot, now ${left.toFixed(1)}`);
    }
    assert.equal(after.length, before.length, "the same length");
    assert.ok(Math.abs(loudness([segments(after, LINES)]) - DIALOGUE_LUFS) < 0.6, `the lines at ${loudness([segments(after, LINES)]).toFixed(1)} LUFS`);
    const peak = 20 * Math.log10(after.reduce((p, v) => Math.max(p, Math.abs(v)), 0));
    assert.ok(peak <= DIALOGUE_LUFS + PEAK_OVER + 0.5, `peaks held (${peak.toFixed(1)} dBFS)`);
    let [best, bestScore] = [0, -Infinity];
    for (let lag = -240; lag <= 240; lag++) {
      let score = 0;
      for (let i = 1 * SR; i < 4 * SR; i++) score += before[i] * after[i + lag];
      if (score > bestScore) [best, bestScore] = [lag, score];
    }
    assert.ok(Math.abs(best) <= (2 * SR) / 1000, `in sync (${((best / SR) * 1000).toFixed(2)} ms)`);
  });
});
