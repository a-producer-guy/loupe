// The first assembly's dialogue sound, on a made-up take: a voice-like sound
// (a buzz of harmonics in syllables, with an "s" now and then) over a steady
// hiss, run through the real FFmpeg filters.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loudness, readAudio, rmsDb, segments, seeded, SR, writeAudio } from "../src/assembly/audio.js";
import { cleanTake, DIALOGUE_LUFS, PEAK_OVER, roomTone } from "../src/assembly/dialogue.js";
import type { Cut, Take } from "../src/assembly/engine.js";
import type { Unit } from "../src/assembly/text.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();
const work = mkdtempSync(path.join(os.tmpdir(), "dialogue-test-"));
const db = (x: number) => 20 * Math.log10(x);

/** A voice saying a line from `start` to `end`, `level` dB under full scale at its loudest syllables; its pitch wanders, as a voice's does. */
function say(out: Float32Array, start: number, end: number, level: number, random: () => number) {
  const peak = 10 ** (level / 20);
  let phase = 0;
  for (let i = Math.floor(start * SR); i < Math.floor(end * SR); i++) {
    const t = i / SR - start;
    phase += (2 * Math.PI * (130 + 35 * Math.sin(2 * Math.PI * 0.9 * t) + 12 * Math.sin(2 * Math.PI * 3.1 * t))) / SR;
    const syllable = Math.max(0, Math.sin(Math.PI * 4 * t)) ** 1.5;
    let buzz = 0;
    for (let k = 1; k < 40; k++) buzz += Math.sin(k * phase + k) / k;
    const s = (t % 1) > 0.8 && (t % 1) < 0.9 ? (random() - 0.5) * 0.6 : 0;
    out[i] += peak * (0.35 * buzz * syllable + s);
  }
}

describe("the dialogue (Guy, Oct 5, 2026: Broadcast, super present)", () => {
  const lines: [number, number, number][] = [
    [1.0, 4.0, -12],
    [6.0, 9.0, -24],
    [12.0, 13.5, -12],
  ];
  const units: Unit[] = lines.map((_, i) => ({ who: "A", text: `Line ${i + 1}.`, speechStart: true, actionBefore: "", speech: i }));
  const take = {
    take: "T001",
    path: "Raw/T001.MOV",
    length: 15,
    timecode: null,
    setup: { who: "A", framing: "close" },
    matches: lines.map(([start, end], i) => ({ score: 1, start, end, said: `Line ${i + 1}.`, conf: 1, j0: i, j1: i + 1 })),
    before: "",
    after: "",
    sceneStart: 1,
    sceneEnd: 13.5,
    action: null,
    cut: null,
    cleanFrom: 0,
    stray: [],
  } as unknown as Take;

  test("clear, even and held: -20 LUFS on the actor's lines, peaks 12 dB over, the quiet line brought up, in sync", async () => {
    const random = seeded(3);
    const voice = new Float32Array(15 * SR);
    for (let i = 0; i < voice.length; i++) voice[i] = (random() - 0.5) * 2 * 10 ** (-62 / 20) * Math.sqrt(3);
    for (const [s, e, level] of lines) say(voice, s, e, level, random);
    const proxy = path.join(work, "T001.wav");
    await writeAudio(ffmpeg, proxy, [voice, voice], SR, "pcm_s24le");
    const out = path.join(work, "T001_dialogue.wav");
    const info = await cleanTake(ffmpeg, units, take, proxy, out);
    const [y] = await readAudio(ffmpeg, out, 1, SR);
    assert.equal(y.length, voice.length, "the same length as the camera clip");

    const spans = lines.map(([s, e]) => [s, e] as [number, number]);
    assert.ok(Math.abs(loudness([segments(y, spans)]) - DIALOGUE_LUFS) < 0.6, `the lines at ${loudness([segments(y, spans)]).toFixed(1)} LUFS`);
    const peak = db(y.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    assert.ok(peak <= DIALOGUE_LUFS + PEAK_OVER + 0.5, `peaks held under ${DIALOGUE_LUFS + PEAK_OVER} dBFS (${peak.toFixed(1)})`);

    // The quiet line comes up toward the loud one, and the hiss between lines stays about where it was.
    const level = (x: Float32Array, s: number, e: number) => rmsDb(x.subarray(Math.floor(s * SR), Math.floor(e * SR)));
    const before = level(voice, 1, 4) - level(voice, 6, 9);
    const after = level(y, 1, 4) - level(y, 6, 9);
    assert.ok(after < before - 3, `the quiet line ${before.toFixed(1)} dB under the loud one, now ${after.toFixed(1)}`);
    const hissBefore = level(voice, 9.5, 11.5) - level(voice, 1, 4);
    const hissAfter = level(y, 9.5, 11.5) - level(y, 1, 4);
    assert.ok(hissAfter < hissBefore + 3, `the pause ${hissBefore.toFixed(1)} dB under the voice, now ${hissAfter.toFixed(1)}`);

    // Nothing moved in time: the sound lines up with the original's within 2 ms, a twentieth of a frame (the
    // filters' own phase shift; a slip anyone could see is 40 ms or more).
    let best = 0;
    let bestScore = -Infinity;
    for (let lag = -240; lag <= 240; lag++) {
      let score = 0;
      for (let i = 1 * SR; i < 4 * SR; i++) score += voice[i] * y[i + lag];
      if (score > bestScore) [best, bestScore] = [lag, score];
    }
    assert.ok(Math.abs(best) <= (2 * SR) / 1000, `in sync (${((best / SR) * 1000).toFixed(2)} ms)`);
    assert.equal(info.channel, "both");
  });

  test("the room tone is the room, never someone talking that the compression evened out (shoot 1053)", async () => {
    const random = seeded(5);
    const sound = new Float32Array(8 * SR);
    // 0-2 s and 4-6 s: off-script talk, as steady as compressed speech gets; 2-4 s: the room, at -60 dB.
    for (let i = 0; i < sound.length; i++) {
      const t = i / SR;
      const loud = t < 2 || (t >= 4 && t < 6);
      sound[i] = (random() - 0.5) * 2 * Math.sqrt(3) * 10 ** ((loud ? -21 : -60) / 20);
    }
    const file = path.join(work, "T002_dialogue.wav");
    await writeAudio(ffmpeg, file, [sound], SR, "pcm_s24le");
    const cut = { seconds: 10, audio: [{ take: "T002", in: 0, recIn: 0, recOut: 10 }] } as unknown as Cut;
    const out = path.join(work, "room_tone.wav");
    const made = await roomTone(ffmpeg, cut, new Map([["T002", { file, gaps: [[0.1, 1.9], [2.1, 3.9], [4.1, 5.9]] as [number, number][] }]]), out);
    const [tone] = await readAudio(ffmpeg, out, 1, SR);
    const level = rmsDb(tone);
    assert.ok(Math.abs(level - -60) < 3, `the room tone at ${level.toFixed(1)} dB, like the room`);
    assert.ok(made.level < -55, `reported at ${made.level} dB`);
  });
});
