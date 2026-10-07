// The establishing shot (Guy, Oct 5, 2026: "should match the atmosphere and
// general feel of interiors"): what fal is asked for, with a stand-in for fal.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FalClient } from "../src/ai/fal.js";
import { frameOf, IMAGE_EDIT_ENDPOINT, IMAGE_ENDPOINT, makeEstablishing, VIDEO_ENDPOINT } from "../src/assembly/establishing.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();
const work = mkdtempSync(path.join(os.tmpdir(), "establishing-test-"));
const exterior = { image: "A brick law firm on a wet city street at dusk.", motion: "A slow push in." };

/** fal as the job meets it, keeping what it was asked. */
function standIn() {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const fal = {
    run: async (endpoint: string, input: Record<string, unknown>) => {
      calls.push({ endpoint, input });
      if (endpoint === VIDEO_ENDPOINT) return { video: { url: `data:video/mp4;base64,${Buffer.from("not really a video").toString("base64")}` } };
      return { images: [{ url: "https://example.invalid/still.jpg" }] };
    },
  } as unknown as FalClient;
  return { fal, calls };
}

describe("the establishing shot", () => {
  test("drawn to match frames of the scene's takes: their light, colour and time of day, never their people", async () => {
    const { fal, calls } = standIn();
    const frames = [Buffer.from([0xff, 0xd8, 0xff, 1]), Buffer.from([0xff, 0xd8, 0xff, 2])];
    const file = path.join(work, "matched.mp4");
    await makeEstablishing(fal, exterior, file, undefined, frames);
    assert.equal(calls[0].endpoint, IMAGE_EDIT_ENDPOINT);
    const urls = calls[0].input.image_urls as string[];
    assert.equal(urls.length, 2);
    assert.ok(urls.every((u) => u.startsWith("data:image/jpeg;base64,")), "the frames go to fal as data, nothing kept anywhere");
    const prompt = String(calls[0].input.prompt);
    for (const said of [exterior.image, "time of day", "colour palette", "the kind of building this room would be in", "follow the frames", "never these people or this room"])
      assert.ok(prompt.includes(said), said);
    assert.equal(calls[1].endpoint, VIDEO_ENDPOINT);
    assert.equal(calls[1].input.image_url, "https://example.invalid/still.jpg");
    assert.ok(existsSync(file));
  });

  test("with no frames to go by, from the words alone, as before", async () => {
    const { fal, calls } = standIn();
    await makeEstablishing(fal, exterior, path.join(work, "words.mp4"));
    assert.equal(calls[0].endpoint, IMAGE_ENDPOINT);
    assert.equal(calls[0].input.image_urls, undefined);
    assert.equal(calls[0].input.prompt, `${exterior.image} Photographic, cinematic establishing shot, 16:9, natural light, subtle film grain. No text, no logos, no watermark.`);
  });

  test("a frame of a take, as a JPEG", async () => {
    const video = path.join(work, "take.mp4");
    const made = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    assert.equal(made.status, 0, String(made.stderr));
    assert.ok(statSync(video).size > 0);
    const jpeg = await frameOf(ffmpeg, video, 1.0);
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
    assert.ok(jpeg.length > 1000);
  });
});
