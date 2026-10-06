// Turning one camera clip into a Premiere-ready proxy.
//
// Premiere's "Attach Proxies" only relinks when the proxy matches the raw clip
// on the points below, so each rule here is deliberate (see SPEC.md):
//   - same base filename in a parallel Proxies/ folder (the job row carries the path)
//   - same frame rate: we never pass -r
//   - same aspect ratio: width 640, height follows
//   - same audio: every audio stream mapped, channel counts left alone
//   - same start timecode, copied from the raw
// After encoding, checkProxy() reads the proxy back and confirms every rule,
// so a proxy that wouldn't relink fails here instead of in an edit bay.
//
// When the shoot has a LUT, it is baked into the proxy (and so into the still)
// so the client and the editor see the look instead of flat log footage. The
// LUT only changes the picture's colours; none of the relink rules move.
//
// The same pass also makes a web preview: an H.264 MP4, 1280 on its long side,
// that browsers can play (they can't play ProRes). It sits outside Proxies/ so
// Premiere never mistakes it for a proxy.

import { spawn } from "node:child_process";
import path from "node:path";

export const PROXY_WIDTH = 640;

export type Tools = { ffmpeg: string; ffprobe: string };

export type ProbeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_space?: string;
  color_range?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
};

export type ProbeResult = {
  streams: ProbeStream[];
  format: { format_name?: string; duration?: string; tags?: Record<string, string> };
};

/** A failure that retrying can't fix, such as a camera RAW format FFmpeg can't read. */
export class PermanentProxyError extends Error {}

// Camera RAW formats FFmpeg can't decode. Better to say so plainly than to
// fail three times with a cryptic decoder error.
const RAW_FORMATS: Record<string, string> = {
  ".r3d": "RED RAW (.R3D)",
  ".braw": "Blackmagic RAW (.braw)",
  ".crm": "Canon Cinema RAW Light (.CRM)",
  ".ari": "ARRIRAW (.ari)",
  ".arx": "ARRIRAW (.arx)",
  ".nev": "Nikon N-RAW (.NEV)",
};
const PRORES_RAW_TAGS = new Set(["aprn", "aprh"]);

export function unsupportedFormatReason(fileName: string, info?: ProbeResult): string | null {
  const ext = path.extname(fileName).toLowerCase();
  let format = RAW_FORMATS[ext];
  const video = info && mainVideoStream(info);
  if (!format && video && PRORES_RAW_TAGS.has(video.codec_tag_string ?? "")) format = "ProRes RAW";
  if (!format && video && !video.codec_name) format = `this camera format (${video.codec_tag_string || ext || "unknown"})`;
  return format ? `Proxies can't be made automatically from ${format} files yet.` : null;
}

export async function probe(tools: Tools, file: string): Promise<ProbeResult> {
  const { stdout } = await run(tools.ffprobe, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  const parsed = JSON.parse(stdout) as Partial<ProbeResult>;
  return { streams: parsed.streams ?? [], format: parsed.format ?? {} };
}

/** The clip's picture: the first video stream that isn't cover art or a thumbnail. */
export function mainVideoStream(info: ProbeResult): ProbeStream | undefined {
  return info.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
}

export function audioStreams(info: ProbeResult): ProbeStream[] {
  return info.streams.filter((s) => s.codec_type === "audio");
}

/** A still image also shows up as a one-frame "video"; it gets no proxy. */
export function isStillImage(info: ProbeResult): boolean {
  const name = info.format.format_name ?? "";
  return /(^|,)image2($|,)|_pipe($|,)/.test(name);
}

const TIMECODE = /^\d{2}:\d{2}:\d{2}[:;.]\d{2,3}$/;

/** Start timecode as FFmpeg reports it ("01:00:00:00", or with ";" for drop-frame). */
export function startTimecode(info: ProbeResult): string | undefined {
  const fromTags = (tags?: Record<string, string>) => {
    for (const [key, value] of Object.entries(tags ?? {})) {
      if (key.toLowerCase() === "timecode" && TIMECODE.test(value.trim())) return value.trim();
    }
    return undefined;
  };
  // MXF keeps it on the file, MOV/MP4 on the video stream or its timecode track.
  return (
    fromTags(info.format.tags) ??
    fromTags(mainVideoStream(info)?.tags) ??
    info.streams.map((s) => fromTags(s.tags)).find(Boolean)
  );
}

function rotationOf(stream: ProbeStream): number {
  const fromSideData = stream.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation;
  return fromSideData ?? Number(stream.tags?.rotate ?? 0);
}

/** Proxy frame size: 640 wide, height following the picture as displayed (rotation included). */
export function expectedProxySize(video: ProbeStream): { width: number; height: number } {
  let width = video.width ?? 0;
  let height = video.height ?? 0;
  if (Math.abs(rotationOf(video)) % 180 === 90) [width, height] = [height, width];
  // Same rounding as FFmpeg's scale=640:-2: nearest, then kept even.
  return { width: PROXY_WIDTH, height: Math.round((PROXY_WIDTH * height) / width / 2) * 2 };
}

function frameRate(stream: ProbeStream): number {
  const [num, den] = (stream.r_frame_rate ?? "0/0").split("/").map(Number);
  return den ? num / den : NaN;
}

function durationOf(info: ProbeResult, video?: ProbeStream): number | undefined {
  const seconds = Number(video?.duration ?? info.format.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** How the camera stored its colours, which the LUT needs to know to read them correctly. */
export function colorOf(video: ProbeStream): { matrix: "bt709" | "bt2020" | "bt601"; range: "tv" | "pc" } {
  const space = video.color_space ?? "";
  let matrix: "bt709" | "bt2020" | "bt601";
  if (space.startsWith("bt2020")) matrix = "bt2020";
  else if (space === "bt709") matrix = "bt709";
  else if (space === "smpte170m" || space === "bt470bg") matrix = "bt601";
  // Untagged: HD and bigger is Rec. 709 by convention, SD is Rec. 601.
  else matrix = Math.max(video.width ?? 0, video.height ?? 0) >= 1280 ? "bt709" : "bt601";
  return { matrix, range: video.color_range === "pc" ? "pc" : "tv" };
}

/**
 * The picture filter for a proxy with a LUT: shrink, turn the camera's YCbCr
 * into RGB with the camera's own matrix, apply the LUT, then back to Rec. 709
 * YCbCr for ProRes. Converting with the wrong matrix would shift every colour.
 */
export function lookFilter(lutFile: string, video: ProbeStream, size = `${PROXY_WIDTH}:-2`, format = "yuv422p10le"): string {
  // The path sits inside FFmpeg's filter syntax, where ":" "," "'" and friends mean something.
  if (!/^[\w./-]+$/.test(lutFile)) throw new Error("The LUT's working copy has an unexpected path.");
  const { matrix, range } = colorOf(video);
  return [
    `scale=${size}:in_color_matrix=${matrix}:in_range=${range}`,
    "format=gbrp16le",
    `lut3d=file=${lutFile}:interp=tetrahedral`,
    "scale=out_color_matrix=bt709:out_range=tv",
    `format=${format}`,
  ].join(",");
}

/** Web previews are 1280 on the long side (never enlarged), portrait clips included. */
export const PREVIEW_SIZE = "'if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'";

/** The picture filter for the web preview: shrunk, 8-bit 4:2:0 for browsers, with the LUT if there is one. */
export function previewFilter(video: ProbeStream, lutFile?: string): string {
  return lutFile ? lookFilter(lutFile, video, PREVIEW_SIZE, "yuv420p") : `scale=${PREVIEW_SIZE},format=yuv420p`;
}

const REC709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

export function buildProxyArgs(opts: {
  input: string;
  output: string;
  timecode?: string;
  look?: string;
  /** Also write a web preview, from the same decoded frames. */
  preview?: { output: string; filter: string };
}): string[] {
  const proxyFilter = opts.look ?? `scale=${PROXY_WIDTH}:-2`;
  // With a LUT the picture is now Rec. 709, and says so, so Premiere shows it as intended.
  const tags = opts.look ? REC709 : [];
  const proxyOutput = [
    "-map_metadata", "0",
    ...(opts.timecode ? ["-timecode", opts.timecode] : []),
    ...tags,
    "-c:v", "prores_ks", "-profile:v", "0", "-vendor", "apl0",
    "-c:a", "pcm_s16le",
    "-max_muxing_queue_size", "4096",
    "-f", "mov", opts.output,
  ];
  const start = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats", "-i", opts.input];
  if (!opts.preview) {
    // First real video stream (V skips cover art), plus every audio stream as-is.
    return [...start, "-map", "0:V:0", "-map", "0:a?", "-vf", proxyFilter, ...proxyOutput];
  }
  return [
    ...start,
    "-filter_complex", `[0:V:0]split=2[forproxy][forweb];[forproxy]${proxyFilter}[proxy];[forweb]${opts.preview.filter}[web]`,
    "-map", "[proxy]", "-map", "0:a?", ...proxyOutput,
    // The preview: H.264 and AAC that any browser plays, starting before it has fully downloaded.
    "-map", "[web]", "-map", "0:a:0?",
    ...tags,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart", "-max_muxing_queue_size", "4096",
    "-f", "mp4", opts.preview.output,
  ];
}

/** Every way the proxy differs from the raw in a way Premiere would reject. Empty means it will relink. */
export function checkProxy(raw: ProbeResult, proxy: ProbeResult): string[] {
  const problems: string[] = [];
  const rawVideo = mainVideoStream(raw);
  const proxyVideo = mainVideoStream(proxy);
  if (!rawVideo || !proxyVideo) return ["the proxy has no picture"];

  if (proxyVideo.codec_name !== "prores" || !/proxy/i.test(proxyVideo.profile ?? "")) {
    problems.push(`it is ${proxyVideo.codec_name} ${proxyVideo.profile ?? ""}, not ProRes 422 Proxy`);
  }
  const want = expectedProxySize(rawVideo);
  if (proxyVideo.width !== want.width || proxyVideo.height !== want.height) {
    problems.push(`it is ${proxyVideo.width}x${proxyVideo.height}, expected ${want.width}x${want.height}`);
  }
  const rawRate = frameRate(rawVideo);
  const proxyRate = frameRate(proxyVideo);
  if (!(Math.abs(rawRate - proxyRate) < 0.001)) {
    problems.push(`frame rate ${proxyVideo.r_frame_rate} doesn't match the raw's ${rawVideo.r_frame_rate}`);
  }
  const channels = (info: ProbeResult) => audioStreams(info).map((s) => s.channels ?? 0).join("+") || "none";
  if (channels(raw) !== channels(proxy)) {
    problems.push(`audio channels ${channels(proxy)} don't match the raw's ${channels(raw)}`);
  }
  const rawTc = startTimecode(raw);
  const proxyTc = startTimecode(proxy);
  if (rawTc && rawTc !== proxyTc) problems.push(`timecode ${proxyTc ?? "missing"} doesn't match the raw's ${rawTc}`);
  const rawLength = durationOf(raw, rawVideo);
  const proxyLength = durationOf(proxy, proxyVideo);
  if (rawLength && proxyLength && Math.abs(rawLength - proxyLength) > Math.max(0.5, rawLength * 0.01)) {
    problems.push(`it is ${proxyLength.toFixed(2)}s long but the raw is ${rawLength.toFixed(2)}s`);
  }
  return problems;
}

/** What the clip is, in the terms an editor uses. Shown on the shoot page. */
export type MediaInfo = {
  durationSeconds?: number;
  /** As displayed, so a vertical phone clip is taller than wide. */
  width?: number;
  height?: number;
  fps?: string;
  codec?: string;
  audioTracks: number;
  audioChannels: number;
  timecode?: string;
};

const KNOWN_RATES: Record<string, string> = {
  "24000/1001": "23.976",
  "30000/1001": "29.97",
  "60000/1001": "59.94",
  "120000/1001": "119.88",
};

export function fpsLabel(rate?: string): string | undefined {
  if (!rate) return undefined;
  if (KNOWN_RATES[rate]) return KNOWN_RATES[rate];
  const [num, den] = rate.split("/").map(Number);
  if (!den || !Number.isFinite(num / den) || num === 0) return undefined;
  return String(Math.round((num / den) * 1000) / 1000);
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  mjpeg: "Motion JPEG",
  vp9: "VP9",
  av1: "AV1",
  dvvideo: "DV",
};

export function codecLabel(video: ProbeStream): string | undefined {
  const name = video.codec_name;
  if (!name) return undefined;
  if (name === "prores") return `ProRes ${video.profile ?? ""}`.trim().replace("Standard", "422").replace(/^ProRes (HQ|LT|Proxy)$/, "ProRes 422 $1");
  if (name === "dnxhd") return video.profile?.startsWith("DNXHR") ? `DNxHR ${video.profile.slice(6)}`.trim() : "DNxHD";
  return CODEC_NAMES[name] ?? name.toUpperCase();
}

export function describeMedia(info: ProbeResult): MediaInfo {
  const video = mainVideoStream(info);
  const audio = audioStreams(info);
  let width = video?.width;
  let height = video?.height;
  if (video && Math.abs(rotationOf(video)) % 180 === 90) [width, height] = [height, width];
  return {
    durationSeconds: durationOf(info, video),
    width,
    height,
    fps: fpsLabel(video?.r_frame_rate),
    codec: video ? codecLabel(video) : undefined,
    audioTracks: audio.length,
    audioChannels: audio.reduce((sum, s) => sum + (s.channels ?? 0), 0),
    timecode: startTimecode(info),
  };
}

/** A still for the shoot page, taken from the proxy a little way into the clip. */
export function buildThumbnailArgs(opts: { input: string; output: string; durationSeconds?: number }): string[] {
  const at = Math.min(1, (opts.durationSeconds ?? 0) * 0.1);
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    "-ss", at.toFixed(2), "-i", opts.input,
    "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3",
    opts.output,
  ];
}

export type ProxyResult =
  | { kind: "made"; raw: ProbeResult; proxy: ProbeResult; timecode?: string; media: MediaInfo; previewMade: boolean }
  | { kind: "skipped"; reason: string };

/**
 * Makes `output` from `input`. `sourceName` is the raw's real filename (the
 * local copy may be renamed); it is only used to recognise formats.
 */
export async function makeProxy(
  tools: Tools,
  opts: {
    input: string;
    output: string;
    sourceName: string;
    /** A .cube file to bake into the proxy, if the shoot has a LUT. */
    lut?: string;
    /** Where to write the web preview, if one is wanted. */
    preview?: string;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  },
): Promise<ProxyResult> {
  const byName = unsupportedFormatReason(opts.sourceName);
  if (byName) throw new PermanentProxyError(byName);

  let raw: ProbeResult;
  try {
    raw = await probe(tools, opts.input);
  } catch {
    throw new PermanentProxyError("This file couldn't be opened as a video. It may be damaged or an unusual format.");
  }
  const video = mainVideoStream(raw);
  if (!video) return { kind: "skipped", reason: "No picture in this file, so it needs no proxy." };
  if (isStillImage(raw)) return { kind: "skipped", reason: "This is a still image, so it needs no proxy." };
  const byContent = unsupportedFormatReason(opts.sourceName, raw);
  if (byContent) throw new PermanentProxyError(byContent);

  const timecode = startTimecode(raw);
  const look = opts.lut ? lookFilter(opts.lut, video) : undefined;
  const run = (withPreview: boolean) =>
    runFfmpeg(
      tools,
      buildProxyArgs({
        input: opts.input,
        output: opts.output,
        timecode,
        look,
        preview: withPreview && opts.preview ? { output: opts.preview, filter: previewFilter(video, opts.lut) } : undefined,
      }),
      { durationSec: durationOf(raw, video), onProgress: opts.onProgress, signal: opts.signal },
    );
  let previewMade = Boolean(opts.preview);
  try {
    await run(previewMade);
  } catch (error) {
    // The preview is a nice-to-have; never let it stand between a clip and its proxy.
    if (!previewMade || opts.signal?.aborted) throw error;
    previewMade = false;
    await run(false);
  }

  const proxy = await probe(tools, opts.output);
  const problems = checkProxy(raw, proxy);
  if (problems.length) throw new Error(`The proxy wouldn't relink in Premiere: ${problems.join("; ")}.`);
  if (previewMade && opts.preview) previewMade = await previewPlays(tools, opts.preview, durationOf(raw, video));
  return { kind: "made", raw, proxy, timecode, media: describeMedia(raw), previewMade };
}

/** The preview is a browser-playable H.264 file about as long as the clip. */
async function previewPlays(tools: Tools, file: string, rawSeconds?: number): Promise<boolean> {
  try {
    const info = await probe(tools, file);
    const video = mainVideoStream(info);
    const seconds = durationOf(info, video);
    const longEnough = !rawSeconds || !seconds || Math.abs(seconds - rawSeconds) <= Math.max(0.5, rawSeconds * 0.01);
    return video?.codec_name === "h264" && longEnough;
  } catch {
    return false;
  }
}

export function runFfmpeg(
  tools: Tools,
  args: string[],
  opts: { durationSec?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal; stallMs?: number } = {},
): Promise<void> {
  const stallMs = opts.stallMs ?? 5 * 60_000;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error("Stopped"));
    const child = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let pending = "";
    let lastProgressAt = Date.now();
    let stalled = false;

    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > stallMs) {
        stalled = true;
        child.kill("SIGKILL");
      }
    }, 5_000);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastProgressAt = Date.now();
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        // out_time_ms is also microseconds; FFmpeg kept the old name for compatibility.
        const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (match && opts.durationSec && opts.onProgress) {
          opts.onProgress(Math.min(0.99, Number(match[1]) / 1e6 / opts.durationSec));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });

    const finish = (error?: Error) => {
      clearInterval(stallTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    child.on("error", (error) => finish(new Error(`Couldn't start FFmpeg (${tools.ffmpeg}): ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) return finish();
      if (opts.signal?.aborted) return finish(opts.signal.reason ?? new Error("Stopped"));
      if (stalled) return finish(new Error("FFmpeg stopped making progress and was restarted."));
      finish(new Error(`FFmpeg failed (${code ?? signal}): ${lastLines(stderr)}`));
    });
  });
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-8_000)));
    child.on("error", (error) => reject(new Error(`Couldn't start ${command}: ${error.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(command)} failed: ${lastLines(stderr)}`)),
    );
  });
}

function lastLines(text: string, count = 4): string {
  return text.trim().split("\n").slice(-count).join(" | ") || "no details";
}
