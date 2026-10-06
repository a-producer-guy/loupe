import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Settings come from the environment (worker/.env locally, the host's settings
// in production). The B2 key here must be one that can read and write but
// not delete.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Add it to worker/.env (see SETUP.md).`);
  return value;
}

export function loadConfig() {
  return {
    databaseUrl: required("DATABASE_URL"),
    b2: {
      endpoint: required("B2_ENDPOINT"),
      region: required("B2_REGION"),
      bucket: required("B2_BUCKET"),
      keyId: required("B2_KEY_ID"),
      appKey: required("B2_APP_KEY"),
    },
    tools: findTools(),
    // Jobs at once. Each FFmpeg already uses every CPU core, so 1-2 is right.
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 2),
    pollSeconds: Math.max(1, Number(process.env.POLL_SECONDS) || 5),
    workDir: process.env.WORK_DIR || path.join(os.tmpdir(), "loupe-worker"),
  };
}

export type Config = ReturnType<typeof loadConfig>;

/**
 * FFMPEG_PATH/FFPROBE_PATH if set; otherwise the copy bundled for running on
 * a Mac (a dev-only package, absent from the Docker image); otherwise the
 * system FFmpeg, which is what the Docker image uses.
 */
function findTools() {
  if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH) {
    return { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  }
  try {
    const bundled = createRequire(import.meta.url)("ffmpeg-ffprobe-static") as { ffmpegPath?: string; ffprobePath?: string };
    if (bundled.ffmpegPath && bundled.ffprobePath && existsSync(bundled.ffmpegPath) && existsSync(bundled.ffprobePath)) {
      return { ffmpeg: bundled.ffmpegPath, ffprobe: bundled.ffprobePath };
    }
  } catch {
    // Not installed (production): use the system FFmpeg.
  }
  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
}
