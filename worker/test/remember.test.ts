// What the paid AI calls answered, kept between versions (Guy, Oct 9: free cutting has to be cheap for Loupe): asked
// once per scene, reused while what's sent is exactly the same, asked again when it changes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FalClient } from "../src/ai/fal.js";
import { SR, writeAudio } from "../src/assembly/audio.js";
import type { Take } from "../src/assembly/engine.js";
import { isolateVoice } from "../src/assembly/isolate.js";
import { fingerprint, remembered, type WorkCache } from "../src/assembly/remember.js";
import { testTools } from "./samples.js";

const { ffmpeg } = testTools();

/** A cache in memory, standing in for the scene's "Loupe work" folder. */
function memoryCache(): WorkCache & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    get: async (name, file) => {
      const from = kept.get(name);
      if (!from) return false;
      await copyFile(from, file);
      return true;
    },
    put: async (name, file) => {
      const at = path.join(await mkdtemp(path.join(os.tmpdir(), "kept-")), name);
      await copyFile(file, at);
      kept.set(name, at);
    },
  };
}

describe("kept answers", () => {
  test("asked once, then reused; an answer that isn't real is asked for again", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remember-"));
    const cache = memoryCache();
    let asked = 0;
    const ask = async () => (asked++, { A1: { bonus: 1, note: "alive" } });
    assert.deepEqual(await remembered(cache, dir, "performance-x.json", ask, (p) => Object.keys(p).length > 0), { A1: { bonus: 1, note: "alive" } });
    assert.deepEqual(await remembered(cache, dir, "performance-x.json", ask, (p) => Object.keys(p).length > 0), { A1: { bonus: 1, note: "alive" } });
    assert.equal(asked, 1);

    let empty = 0;
    const nothing = async () => (empty++, {});
    await remembered(cache, dir, "performance-y.json", nothing, (p) => Object.keys(p).length > 0);
    await remembered(cache, dir, "performance-y.json", nothing, (p) => Object.keys(p).length > 0);
    assert.equal(empty, 2, "a failed answer isn't kept");
  });

  test("the fingerprint changes with anything sent", () => {
    assert.equal(fingerprint("model", "a"), fingerprint("model", "a"));
    assert.notEqual(fingerprint("model", "a"), fingerprint("model", "b"));
    assert.notEqual(fingerprint("ab", "c"), fingerprint("a", "bc"), "parts don't run into each other");
  });

  test("a take's voice is isolated once: the same dialogue sent again is reused, different dialogue isn't", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "isolate-"));
    const tone = (hz: number) => Float32Array.from({ length: SR * 2 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * hz * i) / SR));
    const make = async (name: string, hz: number) => {
      const file = path.join(dir, name);
      await writeAudio(ffmpeg, file, [tone(hz)], SR, "pcm_s24le");
      return file;
    };
    // fal's isolation, standing in: sends back what it was given.
    let calls = 0;
    const fal = {
      run: async (_endpoint: string, input: { audio_url: string }) => (calls++, { audio: { url: input.audio_url } }),
    } as unknown as FalClient;
    const take = { take: "A1", setup: { who: "A", framing: "medium" }, matches: [] } as unknown as Take;
    const cache = memoryCache();

    const first = await make("first.wav", 220);
    assert.deepEqual(await isolateVoice(fal, ffmpeg, [], take, first, undefined, cache), { reused: false });
    const again = await make("again.wav", 220);
    assert.deepEqual(await isolateVoice(fal, ffmpeg, [], take, again, undefined, cache), { reused: true });
    assert.equal(calls, 1, "the same dialogue isn't paid for twice");
    assert.deepEqual(await readFile(again), await readFile(first), "and comes out the same");

    const other = await make("other.wav", 330);
    assert.deepEqual(await isolateVoice(fal, ffmpeg, [], take, other, undefined, cache), { reused: false });
    assert.equal(calls, 2);
  });
});
