// Loupe's Color mode (Guy, Oct 6): a note becomes a grade, the grade a .cube
// that the preview and Premiere both use. Claude is stood in for here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FalClient } from "../src/ai/fal.js";
import { applyGrade, clampGrade, cubeOf, gradeFor, isNeutral, NEUTRAL, parseGradeAnswer, throughLuts } from "../src/assembly/grade.js";
import { VISION_ENDPOINT } from "../src/assembly/vision.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();
const work = mkdtempSync(path.join(os.tmpdir(), "grade-test-"));
const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

function jpeg(): Buffer {
  const file = path.join(work, "frame.jpg");
  const made = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180", "-frames:v", "1", "-q:v", "3", file]);
  assert.equal(made.status, 0, String(made.stderr));
  return readFileSync(file);
}

describe("the grade", () => {
  test("neutral changes nothing", () => {
    for (const c of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.8], [0.435, 0.435, 0.435]] as [number, number, number][])
      assert.ok(close(applyGrade(NEUTRAL, c), c), String(c));
    assert.ok(isNeutral(clampGrade({})));
  });

  test("each control moves the picture the way its name says", () => {
    const grey: [number, number, number] = [0.5, 0.5, 0.5];
    const warm = applyGrade({ ...NEUTRAL, temperature: 0.5 }, grey);
    assert.ok(warm[0] > warm[2], "warmer: more red than blue");
    assert.ok(applyGrade({ ...NEUTRAL, exposure: 1 }, grey)[1] > 0.6, "a stop up is brighter");
    const punchy = { ...NEUTRAL, contrast: 1.4 };
    assert.ok(applyGrade(punchy, [0.2, 0.2, 0.2])[0] < 0.2 && applyGrade(punchy, [0.8, 0.8, 0.8])[0] > 0.8, "contrast spreads around mid grey");
    assert.ok(close(applyGrade(punchy, [0, 0, 0]), [0, 0, 0]) && close(applyGrade(punchy, [1, 1, 1]), [1, 1, 1]), "black stays black, white stays white");
    assert.ok(close(applyGrade({ ...NEUTRAL, saturation: 0 }, [0.9, 0.2, 0.1]).map((v, _i, a) => v - a[0]), [0, 0, 0]), "no saturation: grey");
    assert.ok(Math.abs(applyGrade({ ...NEUTRAL, fade: 0.1 }, [0, 0, 0])[0] - 0.1) < 1e-9, "fade lifts black");
    const teal = applyGrade({ ...NEUTRAL, shadows: { hue: 200, amount: 0.2 } }, [0.1, 0.1, 0.1]);
    assert.ok(teal[2] > teal[0], "teal shadows");
    const lifted = applyGrade({ ...NEUTRAL, lift: { r: 0, g: 0, b: 0.1 } }, [0, 0, 0]);
    assert.ok(lifted[2] > 0.05 && lifted[0] === 0, "lift on blue colours only the blacks' blue");
  });

  test("an answer is kept in range, whatever it says", () => {
    const g = clampGrade({ exposure: 9, contrast: -3, saturation: "lots", lift: { r: 1 }, shadows: { hue: -160, amount: 2 } });
    assert.equal(g.exposure, 1.5);
    assert.equal(g.contrast, 0.6);
    assert.equal(g.saturation, 1);
    assert.deepEqual(g.lift, { r: 0.15, g: 0, b: 0 });
    assert.deepEqual(g.shadows, { hue: 200, amount: 0.3 });
    assert.equal(parseGradeAnswer("no json here"), null);
    const read = parseGradeAnswer('Sure: {"grade": {"temperature": 0.3}, "said": "Warmer."} hope that helps');
    assert.equal(read?.grade.temperature, 0.3);
    assert.equal(read?.said, "Warmer.");
  });

  test("the .cube is what Premiere and Resolve read: 33 points a side, red fastest", () => {
    const cube = cubeOf({ ...NEUTRAL, temperature: 0.4 }, 'Scene 3 "warm"').trim().split("\n");
    assert.equal(cube[0], 'TITLE "Scene 3 warm"');
    assert.equal(cube[1], "LUT_3D_SIZE 33");
    assert.equal(cube.length, 4 + 33 ** 3);
    assert.equal(cube[4], "0.000000 0.000000 0.000000");
    const second = cube[5].split(" ").map(Number);
    assert.ok(second[0] > 0 && second[1] === 0 && second[2] === 0, "the second entry is a little red");
    const identity = cubeOf(NEUTRAL, "n").trim().split("\n");
    assert.equal(identity[4 + 33 * 33 * 33 - 1], "1.000000 1.000000 1.000000");
  });

  test("FFmpeg renders a frame through the .cube (as the preview does)", async () => {
    const cube = path.join(work, "warm.cube");
    writeFileSync(cube, cubeOf({ ...NEUTRAL, saturation: 0 }, "grey"));
    const graded = await throughLuts(ffmpeg, jpeg(), [cube]);
    assert.deepEqual([...graded.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
    const raw = spawnSync(ffmpeg, ["-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { input: graded });
    const px = raw.stdout;
    let off = 0;
    for (let i = 0; i < px.length; i += 3) off = Math.max(off, Math.abs(px[i] - px[i + 1]), Math.abs(px[i + 1] - px[i + 2]));
    assert.ok(off < 12, `black and white after the LUT (largest channel gap ${off})`);
  });
});

describe("Claude grading a note", () => {
  function standIn(answers: string[]) {
    const calls: Record<string, unknown>[] = [];
    const fal = {
      run: async (endpoint: string, input: Record<string, unknown>) => {
        assert.equal(endpoint, VISION_ENDPOINT);
        calls.push(input);
        return { output: answers.shift() ?? "" };
      },
    } as unknown as FalClient;
    return { fal, calls };
  }

  test("sets the grade from the frames, looks at it graded, and corrects it once", async () => {
    const { fal, calls } = standIn([
      '{"grade": {"temperature": 0.8, "lift": {"r": -0.05, "g": -0.05, "b": -0.05}}, "said": "Much warmer."}',
      '{"grade": {"temperature": 0.35, "lift": {"r": -0.05, "g": -0.05, "b": -0.05}}, "said": "Warmer, deeper shadows; skin kept natural."}',
    ]);
    const cube = path.join(work, "look.cube");
    const frame = jpeg();
    const look = await gradeFor({ fal, ffmpeg, note: "warmer, deeper shadows", frames: [frame, frame], cube, title: "Scene" });
    assert.equal(look.grade.temperature, 0.35);
    assert.equal(look.said, "Warmer, deeper shadows; skin kept natural.");
    assert.ok(String(calls[0].prompt).includes('"warmer, deeper shadows"'));
    assert.equal((calls[0].image_urls as string[]).length, 2, "the frames");
    assert.equal((calls[1].image_urls as string[]).length, 4, "each frame before and after");
    assert.equal(calls[0].reasoning, true);
    assert.equal(readFileSync(cube, "utf8"), cubeOf(look.grade, "Scene"), "the .cube holds the corrected grade");
  });

  test("keeps the first grade when the second look agrees or can't be read", async () => {
    const { fal } = standIn(['{"grade": {"saturation": 0.7}, "said": "Less colour."}', "sorry"]);
    const look = await gradeFor({ fal, ffmpeg, note: "desaturate", frames: [jpeg()], cube: path.join(work, "a.cube"), title: "S" });
    assert.equal(look.grade.saturation, 0.7);
    assert.equal(look.said, "Less colour.");
  });

  test("no grade at all is an error the run can fall back from", async () => {
    const { fal } = standIn(["I can't help with that."]);
    await assert.rejects(gradeFor({ fal, ffmpeg, note: "x", frames: [jpeg()], cube: path.join(work, "b.cube"), title: "S" }), /couldn't be read/);
  });
});
