// Judging the acting and isolating the voice (Guy, Oct 6), with stand-ins for fal.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FalClient } from "../src/ai/fal.js";
import { lagOf, realign } from "../src/assembly/isolate.js";
import { judgePerformances, parsePerformances, PERFORMANCE_ENDPOINT, PERFORMANCE_MODEL, performancePrompt } from "../src/assembly/performance.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();
const work = mkdtempSync(path.join(os.tmpdir(), "judge-test-"));

describe("voice isolation keeps the dialogue in sync", () => {
  // Bursts of "speech" at uneven times, so there's only one way to line them up.
  const rate = 48_000;
  const original = new Float32Array(rate * 6);
  for (const [s, e] of [[0.5, 1.4], [2.0, 2.3], [3.1, 4.6], [5.2, 5.5]])
    for (let i = Math.floor(s * rate); i < e * rate; i++) original[i] = Math.sin(i * 0.05) * 0.5 * (1 + Math.sin(i * 0.0007));

  test("finds an encoder's delay to the sample, and undoes it", () => {
    for (const delay of [0, 1105, 2257, -480]) {
      const moved = realign(original, -delay, original.length + 3000);
      assert.equal(lagOf(original, moved, rate), delay, `delay ${delay}`);
      const back = realign(moved, lagOf(original, moved, rate), original.length);
      assert.equal(back.length, original.length);
      assert.ok(Math.abs(back[Math.floor(3.5 * rate)] - original[Math.floor(3.5 * rate)]) < 1e-6);
    }
  });
});

describe("judging the acting", () => {
  test("scores become a small nudge around the setup's average, with the note", () => {
    const p = parsePerformances('{"T003": {"score": 9, "note": "rawer; her voice breaks"}, "T004": {"score": 5, "note": "flat"}, "T005": {"score": "great"}}', ["T003", "T004", "T005"])!;
    assert.deepEqual(Object.keys(p), ["T003", "T004"]);
    assert.equal(p.T003.bonus, 0.06);
    assert.equal(p.T004.bonus, -0.06);
    assert.equal(p.T003.note, "on watching: rawer; her voice breaks");
    assert.equal(parsePerformances('{"T003": {"score": 99}}', ["T003", "T004"]), null, "one take alone can't be compared");
    assert.equal(parsePerformances("no", ["T003"]), null);
    const wild = parsePerformances('{"A": {"score": 10}, "B": {"score": 1}, "C": {"score": 1}, "D": {"score": 1}, "E": {"score": 1}, "F": {"score": 1}, "G": {"score": 1}}', ["A", "B", "C", "D", "E", "F", "G"])!;
    assert.equal(wild.A.bonus, 0.15, "never more than 0.15");
  });

  test("each setup's takes go to Gemini together, small, with their sound; a setup of one isn't judged", async () => {
    const video = path.join(work, "take.mp4");
    const made = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
    assert.equal(made.status, 0, String(made.stderr));
    const calls: Record<string, unknown>[] = [];
    const fal = {
      run: async (endpoint: string, input: Record<string, unknown>) => {
        assert.equal(endpoint, PERFORMANCE_ENDPOINT);
        calls.push(input);
        return { output: '{"T001": {"score": 8, "note": "lands it"}, "T002": {"score": 6, "note": "rushed"}}' };
      },
    } as unknown as FalClient;
    const setups = [
      { who: "ANA", framing: "close", lines: ["You came back."], takes: [{ take: "T001", video, from: 1, to: 4 }, { take: "T002", video, from: 1, to: 4 }] },
      { who: "BEN", framing: "close", lines: ["I forgot my keys."], takes: [{ take: "T005", video, from: 1, to: 4 }] },
    ];
    const judged = await judgePerformances({ fal, ffmpeg, setups });
    assert.equal(calls.length, 1, "Ben's single take isn't sent");
    assert.equal(calls[0].model, PERFORMANCE_MODEL);
    const urls = calls[0].video_urls as string[];
    assert.equal(urls.length, 2);
    assert.ok(urls.every((u) => u.startsWith("data:video/mp4;base64,")));
    assert.ok(urls[0].length < 2_000_000, "small");
    assert.ok(String(calls[0].prompt).includes("You came back."));
    assert.ok(judged.T001.bonus > 0 && judged.T002.bonus < 0);
  });

  test("the prompt asks about the performance, not the camera", () => {
    const p = performancePrompt({ who: "ANA", framing: "close", lines: ["Hi."], takes: [{ take: "T1", video: "", from: 0, to: 1 }, { take: "T2", video: "", from: 0, to: 1 }] });
    for (const said of ["Judge the performance only", "T1, T2", "- Hi.", '"score"', '"note"']) assert.ok(p.includes(said), said);
  });
});
