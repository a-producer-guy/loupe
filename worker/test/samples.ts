// Synthetic camera clips that mimic the formats a shoot produces, so the proxy
// rules can be checked without real footage. Each one has what the proxy must
// come out as. Real clips from the cameras still need a pass (see SETUP.md).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Tools } from "../src/proxy.js";

export const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");

export function testTools(): Tools {
  if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH) {
    return { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  }
  // Local-only fallback; the Docker image uses the system FFmpeg instead.
  const bundled = createRequire(import.meta.url)("ffmpeg-ffprobe-static") as { ffmpegPath: string; ffprobePath: string };
  return { ffmpeg: bundled.ffmpegPath, ffprobe: bundled.ffprobePath };
}

type Expect =
  | { skipped: true }
  | { width: number; height: number; audio: number[]; timecode?: string };

export type Sample = { file: string; about: string; steps: string[][]; expect: Expect };

const seconds = 2;
const picture = (size: string, rate: string) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
const monoTrack = (hz: number) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`];
const stereoTrack = ["-f", "lavfi", "-i", `aevalsrc=sin(440*2*PI*t)|sin(550*2*PI*t):s=48000:d=${seconds}`];
const mapAudio = (count: number) => Array.from({ length: count }, (_, i) => ["-map", `${i + 1}:a`]).flat();

export const SAMPLES: Sample[] = [
  {
    file: "A001_C001.mov",
    about: "ProRes 422 HQ 1080p 23.976, two mono tracks, TC 01:00:00:00",
    steps: [[
      ...picture("1920x1080", "24000/1001"), ...monoTrack(440), ...monoTrack(660),
      "-map", "0:v", ...mapAudio(2), "-c:v", "prores_ks", "-profile:v", "3", "-c:a", "pcm_s24le",
      "-timecode", "01:00:00:00",
    ]],
    expect: { width: 640, height: 360, audio: [1, 1], timecode: "01:00:00:00" },
  },
  {
    file: "A001_C002.mov",
    about: "H.264 UHD 29.97 drop-frame, stereo AAC, TC 12:34:56;02",
    steps: [[
      ...picture("3840x2160", "30000/1001"), ...stereoTrack,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-timecode", "12:34:56;02",
    ]],
    expect: { width: 640, height: 360, audio: [2], timecode: "12:34:56;02" },
  },
  {
    file: "C0001.MP4",
    about: "HEVC 10-bit UHD 25p in MP4 (mirrorless style), stereo AAC, TC 09:59:50:00",
    steps: [[
      ...picture("3840x2160", "25"), ...stereoTrack,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
      "-x265-params", "log-level=error", "-tag:v", "hvc1", "-c:a", "aac",
      "-write_tmcd", "on", "-timecode", "09:59:50:00",
    ]],
    expect: { width: 640, height: 360, audio: [2], timecode: "09:59:50:00" },
  },
  {
    file: "CLIP0001.MXF",
    about: "DNxHR 1080p25 in MXF (broadcast camera style), four mono tracks, TC 10:00:00:00",
    steps: [[
      ...picture("1920x1080", "25"), ...monoTrack(440), ...monoTrack(550), ...monoTrack(660), ...monoTrack(770),
      "-map", "0:v", ...mapAudio(4), "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
      "-c:a", "pcm_s24le", "-timecode", "10:00:00:00", "-f", "mxf",
    ]],
    expect: { width: 640, height: 360, audio: [1, 1, 1, 1], timecode: "10:00:00:00" },
  },
  {
    file: "A002_C001.mov",
    about: "ProRes LT 4K DCI 23.976, no audio, no timecode",
    steps: [[...picture("4096x2160", "24000/1001"), "-c:v", "prores_ks", "-profile:v", "1"]],
    expect: { width: 640, height: 338, audio: [] },
  },
  {
    file: "IMG_0001.MOV",
    about: "Phone-style vertical clip: 1920x1080 stored, rotated 90 degrees for display, stereo AAC",
    steps: [
      [
        ...picture("1920x1080", "30"), ...stereoTrack,
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      ],
      // Second pass adds the rotation flag without re-encoding, like a phone does.
      ["-display_rotation", "90", "-i", "{prev}", "-c", "copy"],
    ],
    expect: { width: 640, height: 1138, audio: [2] },
  },
  {
    file: "A003_C001.mov",
    about: "ProRes 422 720p 59.94 drop-frame, eight mono tracks, TC 23:59:59;28",
    steps: [[
      ...picture("1280x720", "60000/1001"), ...[440, 494, 523, 587, 659, 698, 784, 880].flatMap(monoTrack),
      "-map", "0:v", ...mapAudio(8), "-c:v", "prores_ks", "-profile:v", "2", "-c:a", "pcm_s24le",
      "-timecode", "23:59:59;28",
    ]],
    expect: { width: 640, height: 360, audio: [1, 1, 1, 1, 1, 1, 1, 1], timecode: "23:59:59;28" },
  },
  {
    file: "ZOOM0001.WAV",
    about: "Sound recorder file: audio only, gets no proxy",
    steps: [[...stereoTrack, "-c:a", "pcm_s24le"]],
    expect: { skipped: true },
  },
  {
    file: "STILL0001.JPG",
    about: "Still photo: gets no proxy",
    steps: [[...picture("1920x1080", "1"), "-frames:v", "1"]],
    expect: { skipped: true },
  },
];

export function samplePath(sample: Sample): string {
  return path.join(SAMPLES_DIR, sample.file);
}

/** Creates any sample clips that don't exist yet. */
export function makeSamples(tools = testTools()): void {
  mkdirSync(SAMPLES_DIR, { recursive: true });
  for (const sample of SAMPLES) {
    const target = samplePath(sample);
    if (existsSync(target)) continue;
    let previous = "";
    sample.steps.forEach((step, i) => {
      const last = i === sample.steps.length - 1;
      const output = last ? target : path.join(SAMPLES_DIR, `.step${i}-${sample.file}`);
      const args = ["-hide_banner", "-v", "error", "-y", ...step.map((a) => (a === "{prev}" ? previous : a)), output];
      const result = spawnSync(tools.ffmpeg, args, { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Couldn't make ${sample.file}: ${result.stderr}`);
      if (previous) rmSync(previous, { force: true });
      previous = output;
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  makeSamples();
  console.log(`Samples ready in ${SAMPLES_DIR}`);
}
