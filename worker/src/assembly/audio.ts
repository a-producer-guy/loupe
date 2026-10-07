// Sound as numbers, for the first assembly: FFmpeg decodes and encodes, and
// everything in between (levels, loudness, mixing) happens here on plain
// arrays of samples, one Float32Array per channel.

import { spawn } from "node:child_process";

export const SR = 48_000;

/** Runs FFmpeg with `input` on stdin (if any) and returns what it writes to stdout. */
export function ffmpegPipe(ffmpeg: string, args: string[], input?: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Stopped"));
    const child = spawn(ffmpeg, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(signal.reason ?? new Error("Stopped"));
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`FFmpeg failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`));
    });
    if (input && child.stdin) {
      child.stdin.on("error", () => {}); // FFmpeg may stop reading early; the exit code says what happened
      child.stdin.end(input);
    }
  });
}

function toChannels(raw: Buffer, channels: number): Float32Array[] {
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.byteLength - (raw.byteLength % (4 * channels)))));
  const n = all.length / channels;
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = all[i * channels + c];
  return out;
}

function interleave(chans: Float32Array[]): Buffer {
  const n = Math.min(...chans.map((c) => c.length));
  const all = new Float32Array(n * chans.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < chans.length; c++) all[i * chans.length + c] = chans[c][i];
  return Buffer.from(all.buffer);
}

/** A file's first sound track as samples (`channels` 1 or 2, mixed or split by FFmpeg as needed). */
export async function readAudio(ffmpeg: string, file: string, channels: number, rate = SR, signal?: AbortSignal): Promise<Float32Array[]> {
  const raw = await ffmpegPipe(ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "-"], undefined, signal);
  return toChannels(raw, channels);
}

/** Writes samples to a WAV (24-bit unless told otherwise). */
export async function writeAudio(ffmpeg: string, file: string, chans: Float32Array[], rate = SR, codec = "pcm_s24le", signal?: AbortSignal) {
  await ffmpegPipe(ffmpeg, ["-v", "error", "-y", "-f", "f32le", "-ar", String(rate), "-ac", String(chans.length), "-i", "-", "-c:a", codec, file], interleave(chans), signal);
}

/** Runs mono samples through an FFmpeg audio filter chain. */
export async function filterAudio(ffmpeg: string, mono: Float32Array, filter: string, rate = SR, signal?: AbortSignal): Promise<Float32Array> {
  const raw = await ffmpegPipe(
    ffmpeg,
    ["-v", "error", "-f", "f32le", "-ar", String(rate), "-ac", "1", "-i", "-", "-af", filter, "-f", "f32le", "-"],
    interleave([mono]),
    signal,
  );
  return toChannels(raw, 1)[0];
}

export const db = (x: number) => 20 * Math.log10(x + 1e-9);
export const fromDb = (d: number) => 10 ** (d / 20);

export function rmsDb(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return db(Math.sqrt(sum / Math.max(1, x.length)));
}

/** The parts of a track inside the given spans (seconds), joined; the first second if there are none. */
export function segments(audio: Float32Array, spans: [number, number][], rate = SR): Float32Array {
  const parts = spans.filter(([s, e]) => e - s > 0.05).map(([s, e]) => audio.subarray(Math.max(0, Math.floor(s * rate)), Math.max(0, Math.floor(e * rate))));
  if (!parts.length) return audio.subarray(0, rate);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Level of each `window`-sample frame, in dB. */
export function frameLevels(x: Float32Array, window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + window <= x.length; i += window) {
    let sum = 0;
    for (let k = i; k < i + window; k++) sum += x[k] * x[k];
    out.push(db(Math.sqrt(sum / window)));
  }
  return out;
}

/**
 * Whisper often stretches the first word after a pause back over the silence
 * (shoot 1030, Oct 5: "This" from 15.1 s to 17.8 s, said at 17.7 s), so a line
 * seems to start seconds before anyone speaks. Such a word, if it's longer than
 * 0.6 s, starts where its sound does, judged against the take's own quiet: the
 * voiced stretch that reaches its end, or else the one it starts with, or else
 * the loudest.
 */
export function voicedWords<T extends { s: number; e: number }>(words: T[], audio: Float32Array, rate: number): T[] {
  const hop = Math.round(rate / 100);
  const levels = frameLevels(audio, hop);
  if (!levels.length) return words;
  const floor = percentile(levels, 10);
  return words.map((w, i) => {
    if (w.e - w.s <= 0.6 || (i > 0 && words[i - 1].e > w.s - 0.25)) return w;
    const a = Math.max(0, Math.floor(w.s * 100));
    const span = levels.slice(a, Math.min(levels.length, Math.ceil(w.e * 100)));
    if (span.length < 10) return w;
    const peak = Math.max(...span);
    if (peak - floor < 12) return w;
    // Stretches of sound well above the quiet, joined across gaps of up to 120 ms (the stops inside a word).
    const threshold = floor + 0.45 * (peak - floor);
    const runs: [number, number, number][] = [];
    span.forEach((v, k) => {
      if (v < threshold) return;
      const last = runs.at(-1);
      if (last && k - last[1] <= 12) [last[1], last[2]] = [k, last[2] + 10 ** (v / 10)];
      else runs.push([k, k, 10 ** (v / 10)]);
    });
    if (!runs.length) return w;
    const [r0] = span.length - 1 - runs.at(-1)![1] <= 15 ? runs.at(-1)! : runs[0][0] <= 15 ? runs[0] : runs.reduce((x, y) => (y[2] > x[2] ? y : x));
    const s = Math.max(w.s, Math.min((a + r0 - 3) / 100, w.e - 0.08));
    return s - w.s > 0.15 ? { ...w, s: Math.round(s * 1000) / 1000 } : w;
  });
}

export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const at = (p / 100) * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}

// ─── Loudness (ITU-R BS.1770 / EBU R128, integrated), as FFmpeg's ebur128 measures it ─────

function biquads(rate: number) {
  // libebur128's K-weighting for any sample rate.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const highpass = { b: [1, -2, 1], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  return [shelf, highpass];
}

function kWeighted(x: Float32Array, rate: number): Float64Array {
  let y = Float64Array.from(x);
  for (const { b, a } of biquads(rate)) {
    const out = new Float64Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b[0] * y[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1;
      x1 = y[i];
      y2 = y1;
      y1 = v;
      out[i] = v;
    }
    y = out;
  }
  return y;
}

/** Integrated loudness in LUFS of one or two channels (-70 for silence or anything under 0.4 s). */
export function loudness(chans: Float32Array[], rate = SR): number {
  const weighted = chans.map((c) => kWeighted(c, rate));
  const n = Math.min(...weighted.map((w) => w.length));
  const block = Math.round(0.4 * rate);
  const step = Math.round(0.1 * rate);
  // Running sums of squares, so each 400 ms block is quick.
  const sums = weighted.map((w) => {
    const s = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) s[i + 1] = s[i] + w[i] * w[i];
    return s;
  });
  const powers: number[] = [];
  for (let at = 0; at + block <= n; at += step) {
    let z = 0;
    for (const s of sums) z += (s[at + block] - s[at]) / block;
    powers.push(z);
  }
  const lufs = (z: number) => -0.691 + 10 * Math.log10(z);
  const loud = powers.filter((z) => z > 0 && lufs(z) > -70);
  if (!loud.length) return -70;
  const gate = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((z) => lufs(z) > gate);
  return kept.length ? lufs(kept.reduce((a, b) => a + b, 0) / kept.length) : -70;
}

/** Peaks over -1 dBFS rounded off gently instead of clipping (tanh soft knee at 0.89), in place. */
export function softCeiling(chans: Float32Array[], ceiling = 0.89, always = false) {
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  if (!always && peak <= ceiling) return;
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] = Math.tanh(c[i] / ceiling) * ceiling;
}

export const scale = (chans: Float32Array[], gain: number) => {
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= gain;
};

/** numpy's hanning window. */
export function hanning(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let k = 0; k < n; k++) w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
  return w;
}

/** In-place radix-2 FFT (n a power of two); `inverse` without the 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** A small seeded random number generator (mulberry32), so the same scene always gets the same room tone. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
