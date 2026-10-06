import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PermanentProxyError,
  audioStreams,
  buildProxyArgs,
  buildThumbnailArgs,
  describeMedia,
  checkProxy,
  colorOf,
  expectedProxySize,
  lookFilter,
  mainVideoStream,
  makeProxy,
  probe,
  runFfmpeg,
  startTimecode,
  unsupportedFormatReason,
} from "../src/proxy.js";
import { SAMPLES, SAMPLES_DIR, makeSamples, samplePath, testTools } from "./samples.js";

const tools = testTools();
const OUT_DIR = path.join(SAMPLES_DIR, "Proxies");

before(() => {
  makeSamples(tools);
  mkdirSync(OUT_DIR, { recursive: true });
});

describe("proxies from sample clips", () => {
  for (const sample of SAMPLES) {
    test(`${sample.file}: ${sample.about}`, async () => {
      const output = path.join(OUT_DIR, `${path.parse(sample.file).name}.mov`);
      const progress: number[] = [];
      const result = await makeProxy(tools, {
        input: samplePath(sample),
        output,
        sourceName: sample.file,
        onProgress: (f) => progress.push(f),
      });

      if ("skipped" in sample.expect) {
        assert.equal(result.kind, "skipped");
        return;
      }
      assert.equal(result.kind, "made");
      if (result.kind !== "made") return;
      assert.deepEqual(checkProxy(result.raw, result.proxy), []);

      const video = mainVideoStream(result.proxy)!;
      assert.equal(video.codec_name, "prores");
      assert.equal(video.profile, "Proxy");
      assert.equal(`${video.width}x${video.height}`, `${sample.expect.width}x${sample.expect.height}`);
      assert.equal(video.r_frame_rate, mainVideoStream(result.raw)!.r_frame_rate);
      assert.deepEqual(audioStreams(result.proxy).map((s) => s.channels), sample.expect.audio);
      assert.equal(startTimecode(result.proxy), sample.expect.timecode);
      assert.ok(progress.every((f) => f >= 0 && f < 1), "progress stays between 0 and 1");
    });
  }
});

describe("safety checks", () => {
  test("camera RAW formats fail right away with a plain message", async () => {
    assert.match(unsupportedFormatReason("A001_C001_0923AB.braw") ?? "", /Blackmagic RAW/);
    assert.match(unsupportedFormatReason("A001_C001.R3D") ?? "", /RED RAW/);
    assert.equal(unsupportedFormatReason("A001_C001.mov"), null);
    await assert.rejects(
      makeProxy(tools, { input: "/nonexistent.braw", output: "/tmp/x.mov", sourceName: "clip.braw" }),
      PermanentProxyError,
    );
  });

  test("a damaged file is a permanent failure, not three retries", async () => {
    await assert.rejects(
      makeProxy(tools, { input: path.join(SAMPLES_DIR, "missing.mov"), output: "/tmp/x.mov", sourceName: "missing.mov" }),
      PermanentProxyError,
    );
  });

  test("proxy height follows the picture's shape", () => {
    assert.deepEqual(expectedProxySize({ index: 0, width: 1920, height: 1080 }), { width: 640, height: 360 });
    assert.deepEqual(expectedProxySize({ index: 0, width: 4096, height: 2160 }), { width: 640, height: 338 });
    assert.deepEqual(expectedProxySize({ index: 0, width: 2880, height: 2160 }), { width: 640, height: 480 });
    assert.deepEqual(
      expectedProxySize({ index: 0, width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }),
      { width: 640, height: 1138 },
    );
  });

  test("checkProxy catches a proxy that wouldn't relink", async () => {
    // Deliberately break two rules: force 25 fps and fold stereo down to mono.
    const sample = SAMPLES.find((s) => s.file === "A001_C002.mov")!;
    const bad = path.join(OUT_DIR, "BAD_A001_C002.mov");
    const args = buildProxyArgs({ input: samplePath(sample), output: bad });
    args.splice(args.indexOf("-f"), 0, "-r", "25", "-ac", "1");
    await runFfmpeg(tools, args);
    const problems = checkProxy(await probe(tools, samplePath(sample)), await probe(tools, bad));
    assert.ok(problems.some((p) => p.includes("frame rate")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("audio channels")), problems.join("\n"));
  });
});

describe("clip details and stills for the shoot page", () => {
  test("each clip is described the way an editor would", async () => {
    const described = async (file: string) => {
      const sample = SAMPLES.find((s) => s.file === file)!;
      const { durationSeconds, ...rest } = describeMedia(await probe(tools, samplePath(sample)));
      assert.ok(durationSeconds && Math.abs(durationSeconds - 2) < 0.1, `${file} lasts about 2s`);
      return rest;
    };
    assert.deepEqual(await described("A001_C001.mov"), {
      width: 1920, height: 1080, fps: "23.976", codec: "ProRes 422 HQ", audioTracks: 2, audioChannels: 2, timecode: "01:00:00:00",
    });
    assert.deepEqual(await described("C0001.MP4"), {
      width: 3840, height: 2160, fps: "25", codec: "HEVC", audioTracks: 1, audioChannels: 2, timecode: "09:59:50:00",
    });
    assert.deepEqual(await described("CLIP0001.MXF"), {
      width: 1920, height: 1080, fps: "25", codec: "DNxHR LB", audioTracks: 4, audioChannels: 4, timecode: "10:00:00:00",
    });
    assert.deepEqual(await described("IMG_0001.MOV"), {
      width: 1080, height: 1920, fps: "30", codec: "H.264", audioTracks: 1, audioChannels: 2, timecode: undefined,
    });
    assert.deepEqual(await described("A003_C001.mov"), {
      width: 1280, height: 720, fps: "59.94", codec: "ProRes 422", audioTracks: 8, audioChannels: 8, timecode: "23:59:59;28",
    });
  });

  test("a still is taken from the proxy", async () => {
    const proxy = path.join(OUT_DIR, "A001_C001.mov");
    const still = path.join(OUT_DIR, "A001_C001.jpg");
    await runFfmpeg(tools, buildThumbnailArgs({ input: proxy, output: still, durationSeconds: 2 }));
    const info = await probe(tools, still);
    assert.equal(mainVideoStream(info)?.codec_name, "mjpeg");
    assert.equal(mainVideoStream(info)?.width, 480);
  });
});

describe("LUTs baked into proxies", () => {
  /** A .cube file where every colour goes through `fn` (r, g, b from 0 to 1). */
  function writeCube(name: string, size: number, fn: (r: number, g: number, b: number) => [number, number, number]) {
    const lines = [`TITLE "${name}"`, `LUT_3D_SIZE ${size}`];
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) lines.push(fn(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(" "));
    const file = path.join(OUT_DIR, `${name}.cube`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  }

  /** The average colour of the picture (one second in, for a clip), as 0-255 RGB. */
  function averageRgb(file: string): number[] {
    const seek = file.endsWith(".jpg") ? [] : ["-ss", "1"];
    const result = spawnSync(tools.ffmpeg, [
      "-v", "error", ...seek, "-i", file, "-frames:v", "1",
      "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,scale=1:1:flags=area,format=rgb24",
      "-f", "rawvideo", "-",
    ]);
    return [...result.stdout.subarray(0, 3)];
  }

  const sample = SAMPLES.find((s) => s.file === "A001_C001.mov")!;

  test("the camera's colour matrix is read, with sensible guesses when the file doesn't say", () => {
    assert.deepEqual(colorOf({ index: 0, width: 3840, height: 2160 }), { matrix: "bt709", range: "tv" });
    assert.deepEqual(colorOf({ index: 0, width: 720, height: 480 }), { matrix: "bt601", range: "tv" });
    assert.deepEqual(colorOf({ index: 0, width: 3840, height: 2160, color_space: "bt2020nc", color_range: "pc" }), { matrix: "bt2020", range: "pc" });
    assert.deepEqual(colorOf({ index: 0, width: 1920, height: 1080, color_space: "smpte170m" }), { matrix: "bt601", range: "tv" });
  });

  test("a LUT path FFmpeg would misread is refused rather than half-applied", () => {
    assert.throws(() => lookFilter("/tmp/odd:name.cube", { index: 0, width: 1920, height: 1080 }), /unexpected path/);
    assert.match(lookFilter("/tmp/job-1-ab/look.cube", { index: 0, width: 1920, height: 1080 }), /in_color_matrix=bt709.*lut3d=file=\/tmp\/job-1-ab\/look\.cube/);
  });

  test("the LUT shows in the proxy and its still, and the proxy still relinks", async () => {
    const plain = path.join(OUT_DIR, "look-plain.mov");
    const identity = path.join(OUT_DIR, "look-identity.mov");
    const red = path.join(OUT_DIR, "look-red.mov");
    const make = (output: string, lut?: string) =>
      makeProxy(tools, { input: samplePath(sample), output, sourceName: sample.file, lut });

    await make(plain);
    const withIdentity = await make(identity, writeCube("identity", 17, (r, g, b) => [r, g, b]));
    const withRed = await make(red, writeCube("red", 2, () => [1, 0, 0]));

    for (const result of [withIdentity, withRed]) {
      assert.equal(result.kind, "made");
      if (result.kind === "made") assert.deepEqual(checkProxy(result.raw, result.proxy), [], "same relink rules as without a LUT");
    }
    // A LUT that changes nothing must leave the colours where they were: proof the camera's matrix was read right.
    const [p, i] = [averageRgb(plain), averageRgb(identity)];
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(p[c] - i[c]) <= 3, `identity LUT moved the colour: ${p} vs ${i}`);
    // A LUT that paints everything red must turn the picture red.
    const [r, g, b] = averageRgb(red);
    assert.ok(r > 200 && g < 30 && b < 30, `expected red, got ${[r, g, b]}`);
    // And the proxy says it is Rec. 709 now.
    const tags = mainVideoStream(await probe(tools, red))!;
    assert.equal(tags.color_space, "bt709");

    // The still is taken from the proxy, so it shows the look too.
    const still = path.join(OUT_DIR, "look-red.jpg");
    await runFfmpeg(tools, buildThumbnailArgs({ input: red, output: still, durationSeconds: 2 }));
    const [sr, sg, sb] = averageRgb(still);
    assert.ok(sr > 200 && sg < 40 && sb < 40, `expected a red still, got ${[sr, sg, sb]}`);
  });

  test("without a LUT the proxy is made exactly as before", () => {
    const args = buildProxyArgs({ input: "in.mov", output: "out.mov" });
    assert.equal(args[args.indexOf("-vf") + 1], "scale=640:-2");
    assert.ok(!args.includes("-colorspace"));
  });
});

describe("web previews, made in the same pass", () => {
  const find = (file: string) => SAMPLES.find((s) => s.file === file)!;

  test("an H.264 preview, 1280 on its long side, that starts playing before it has downloaded", async () => {
    const output = path.join(OUT_DIR, "preview-hd.mov");
    const preview = path.join(OUT_DIR, "preview-hd.mp4");
    const sample = find("A001_C001.mov");
    const result = await makeProxy(tools, { input: samplePath(sample), output, preview, sourceName: sample.file });
    assert.equal(result.kind, "made");
    if (result.kind !== "made") return;
    assert.equal(result.previewMade, true);
    assert.deepEqual(checkProxy(result.raw, result.proxy), [], "the proxy is exactly as without a preview");

    const info = await probe(tools, preview);
    const video = mainVideoStream(info)!;
    assert.deepEqual([video.codec_name, video.width, video.height], ["h264", 1280, 720]);
    assert.deepEqual(audioStreams(info).map((a) => [a.codec_name, a.channels]), [["aac", 2]]);
    // "Fast start": the index sits before the picture data, so a browser can play while downloading.
    const bytes = readFileSync(preview);
    assert.ok(bytes.indexOf("moov") < bytes.indexOf("mdat"), "moov comes before mdat");
  });

  test("a vertical phone clip gets a vertical preview", async () => {
    const sample = find("IMG_0001.MOV");
    const preview = path.join(OUT_DIR, "preview-phone.mp4");
    const result = await makeProxy(tools, { input: samplePath(sample), output: path.join(OUT_DIR, "preview-phone.mov"), preview, sourceName: sample.file });
    assert.equal(result.kind === "made" && result.previewMade, true);
    const video = mainVideoStream(await probe(tools, preview))!;
    assert.deepEqual([video.width, video.height], [720, 1280]);
  });

  test("the preview has the LUT too", async () => {
    const sample = find("A001_C001.mov");
    const lut = path.join(OUT_DIR, "red.cube");
    writeFileSync(lut, `LUT_3D_SIZE 2\n${Array(8).fill("1 0 0").join("\n")}\n`);
    const preview = path.join(OUT_DIR, "preview-red.mp4");
    await makeProxy(tools, { input: samplePath(sample), output: path.join(OUT_DIR, "preview-red.mov"), preview, lut, sourceName: sample.file });
    const frame = spawnSync(tools.ffmpeg, [
      "-v", "error", "-ss", "1", "-i", preview, "-frames:v", "1",
      "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,scale=1:1:flags=area,format=rgb24", "-f", "rawvideo", "-",
    ]).stdout;
    const [r, g, b] = [...frame.subarray(0, 3)];
    assert.ok(r > 200 && g < 40 && b < 40, `expected red, got ${[r, g, b]}`);
  });

  test("if the preview can't be made, the proxy still is", async () => {
    const sample = find("A001_C001.mov");
    const output = path.join(OUT_DIR, "no-preview.mov");
    const result = await makeProxy(tools, {
      input: samplePath(sample),
      output,
      preview: path.join(OUT_DIR, "missing-folder", "preview.mp4"),
      sourceName: sample.file,
    });
    assert.equal(result.kind, "made");
    if (result.kind === "made") {
      assert.equal(result.previewMade, false);
      assert.deepEqual(checkProxy(result.raw, result.proxy), []);
    }
  });
});
