// The finishing touches a lazy editor skips (Guy, Oct 5, 2026): every dialogue
// join on a quiet frame, and the score's last chord found so it can land on the
// scene's last line.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmsDb, seeded, SR, writeAudio } from "../src/assembly/audio.js";
import type { Cut } from "../src/assembly/engine.js";
import { FPS } from "../src/assembly/engine.js";
import { audibleEnd, finalHit, quietJoins } from "../src/assembly/finish.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();
const work = mkdtempSync(path.join(os.tmpdir(), "finish-test-"));

describe("finishing", () => {
  test("a dialogue join moves off a sound onto the quietest frame near it, and both takes stay in sync", async () => {
    const random = seeded(2);
    const hiss = (seconds: number) => Float32Array.from({ length: seconds * SR }, () => (random() - 0.5) * 2e-3);
    const a = hiss(4);
    // A lip smack right where take A's edit ends (2.0 s in it).
    for (let i = Math.round(1.97 * SR); i < Math.round(2.03 * SR); i++) a[i] += (random() - 0.5) * 0.6;
    const b = hiss(8);
    const files = new Map([
      ["TA", path.join(work, "TA_dialogue.wav")],
      ["TB", path.join(work, "TB_dialogue.wav")],
    ]);
    await writeAudio(ffmpeg, files.get("TA")!, [a], SR, "pcm_s24le");
    await writeAudio(ffmpeg, files.get("TB")!, [b], SR, "pcm_s24le");
    const join = 24 / FPS;
    const cut = {
      takes: [],
      audio: [
        { take: "TA", in: 2.0 - join, out: 2.0, recIn: 0, recOut: join },
        { take: "TB", in: 5.0, out: 6.0, recIn: join, recOut: join + 1.0 },
      ],
    } as unknown as Cut;
    const { audio } = await quietJoins(ffmpeg, cut, files);
    const [x, y] = audio;
    assert.equal(x.recOut, y.recIn, "still back to back");
    const moved = Math.round((x.recOut - join) * FPS);
    assert.ok(Math.abs(moved) >= 1 && Math.abs(moved) <= 2, `moved ${moved} frames`);
    assert.ok(Math.abs(x.in - x.recIn - (2.0 - join)) < 0.002 && Math.abs(y.in - y.recIn - (5.0 - join)) < 0.002, "in sync");
    const around = (t: number) => rmsDb(a.subarray(Math.round((t - 0.015) * SR), Math.round((t + 0.015) * SR)));
    assert.ok(around(x.out) < around(2.0) - 20, `quiet where it cuts now (${around(x.out).toFixed(0)} dB, was ${around(2.0).toFixed(0)})`);
  });

  test("the score's last chord: the last strong attack that only rings away after it", () => {
    const seconds = 30;
    const left = new Float32Array(seconds * SR);
    const random = seeded(9);
    const note = (at: number, gain: number, decay: number, hz: number) => {
      for (let i = Math.round(at * SR); i < left.length; i++) {
        const t = i / SR - at;
        const env = gain * Math.exp(-t / decay);
        if (env < 1e-5) break;
        left[i] += env * (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(2 * Math.PI * 2 * hz * t) + 0.05 * (random() - 0.5));
      }
    };
    for (let t = 0.5; t < 22; t += 1.5) note(t, 0.05, 0.6, 220 + 40 * (Math.floor(t) % 3));
    // The last chord, then it rings away.
    for (const hz of [196, 247, 294]) note(25.0, 0.12, 1.4, hz);
    const hit = finalHit([left, left]);
    assert.ok(hit !== null && Math.abs(hit - 25.0) < 0.1, `found at ${hit}`);
  });

  test("where a score really ends: the music service often stops seconds before the length asked for", () => {
    const left = new Float32Array(30 * SR);
    for (let i = 0; i < 21 * SR; i++) {
      const t = i / SR;
      left[i] = 0.05 * Math.min(1, (21 - t) / 1.5) * Math.sin(2 * Math.PI * 220 * t);
    }
    for (let i = 21 * SR; i < left.length; i++) left[i] = 1e-5 * Math.sin(i);
    const end = audibleEnd([left, left]);
    assert.ok(end > 19.5 && end <= 21.0, `ends at ${end}`);
  });

  test("a score that just fades out has no last chord to land", () => {
    const left = new Float32Array(30 * SR);
    for (let i = 0; i < left.length; i++) {
      const t = i / SR;
      const fadeOut = t < 20 ? 1 : Math.max(0, 1 - (t - 20) / 10);
      left[i] = 0.05 * fadeOut * (Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t)));
    }
    assert.equal(finalHit([left, left]), null);
  });
});
