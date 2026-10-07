// The first assembly's dialogue (from the pilot's dialogue.py): each take's
// camera sound cleaned (low-cut, gentle noise reduction), made crisp and
// present the way Premiere's Multiband Compressor "Broadcast" preset does it,
// and brought to -20 LUFS on the on-camera actor's lines with its peaks held
// under; the same length and start as the camera clip so it follows the edit
// in Premiere; and the scene's room tone, lifted from the takes' own pauses.

import { fft, filterAudio, frameLevels, hanning, loudness, percentile, readAudio, rmsDb, SR, scale, seeded, segments, softCeiling, writeAudio } from "./audio.js";
import type { Cut, Take } from "./engine.js";
import { isFound, median, type Unit } from "./text.js";

export const DIALOGUE_LUFS = -20;
/** Peaks are held this far over the dialogue's loudness: dense and present, like broadcast dialogue. */
export const PEAK_OVER = 12;
const CLEAN = "highpass=f=80,afftdn=nr=10:nf=-45:tn=1";
/** The level the voice goes into the Broadcast stage at, so its thresholds sit where speech is. */
const SHAPE_LUFS = -24;

/**
 * Crisp, present dialogue (Guy, Oct 5, 2026: "I typically set the compressor to
 * Broadcast to make it super present"). Premiere's Broadcast bands, split at 127,
 * 1147 and 6910 Hz and each compressed on its own, so a boomy vowel can't pull
 * the consonants down with it; then a presence lift, a little air and
 * de-essing. Thresholds are for speech at -24 LUFS, set from the band levels of
 * shoot 1053's takes. First an expander, just above the take's own hiss, down
 * to `floor` (gain) between words: compression brings the hiss up there, and
 * this keeps the pauses quiet. A shout still sounds bigger than a whisper: a
 * compressor that also evened line to line flattened the scene to radio (LRA 3).
 */
const broadcast = (gate: number, floor: number) =>
  `agate=mode=downward:range=${floor}:threshold=${gate.toFixed(6)}:ratio=2:attack=5:release=250:detection=rms,` +
  "equalizer=f=250:t=q:w=1:g=-2,acrossover=split=127 1147 6910:order=4th[b1][b2][b3][b4];" +
  "[b1]acompressor=threshold=-50dB:ratio=4:attack=10:release=150:knee=3[c1];" +
  "[b2]acompressor=threshold=-30dB:ratio=3:attack=5:release=120:knee=3[c2];" +
  "[b3]acompressor=threshold=-36dB:ratio=3:attack=2:release=80:knee=3:makeup=1.2[c3];" +
  "[b4]acompressor=threshold=-42dB:ratio=2.5:attack=1:release=50:knee=3[c4];" +
  "[c1][c2][c3][c4]amix=inputs=4:normalize=0,equalizer=f=4500:t=q:w=0.9:g=2,highshelf=f=10000:g=1.5,deesser=i=0.5";

/** A look-ahead limiter that holds peaks at `ceiling` (linear) without moving the sound in time. */
const limiter = (ceiling: number) => `alimiter=limit=${ceiling.toFixed(4)}:attack=4:release=60:level=false:latency=true:asc=true`;

/**
 * How hard the takes' hiss is taken out (Guy, Oct 5, 2026: "I would like to add
 * more denoise"; then, of an 18 dB setting, "it's still getting that
 * watery-ness"). Light is the gentle reduction that follows the noise as it
 * goes, and pauses held about as quiet as they were. Medium and strong learn the
 * noise from the take's quietest second first (its noise print, as Audition and
 * RX do) and take out only a little more of it under the voice, smoothed across
 * frequencies; the rest comes off between the words, where the voice isn't (the
 * expander's floor: -10 and -14 dB). Taking 18 dB out under the voice is what
 * made it watery: on shoot 1053 it took 2 dB more of the voice's top end and made
 * what was left of it flutter.
 */
export const DENOISE = {
  light: { print: null, floor: 0.5 },
  medium: { print: { nr: 12, rf: -44 }, floor: 0.32 },
  strong: { print: { nr: 14, rf: -46 }, floor: 0.2 },
} as const;
export type Denoise = keyof typeof DENOISE;

/** The noise print is played first so FFmpeg learns it, then the take runs through with it (its gains smoothed). */
const learned = (seconds: number, { nr, rf }: { nr: number; rf: number }) =>
  `asendcmd=c='0.0 afftdn sn start; ${(seconds - 0.05).toFixed(3)} afftdn sn stop',highpass=f=80,afftdn=nr=${nr}:nf=-50:rf=${rf}:tn=0:gs=12:ad=0.7`;

/** The take's quietest second, where only the room is heard (before action, between lines); never digital silence. */
export function quietestSecond(x: Float32Array): Float32Array | null {
  const hop = SR / 20;
  const levels = frameLevels(x, hop);
  const win = 20;
  let best = -1;
  let bestPower = Infinity;
  let power = 0;
  let silent = 0;
  for (let i = 0; i < levels.length; i++) {
    power += 10 ** (levels[i] / 10);
    if (levels[i] <= -100) silent++;
    if (i >= win) {
      power -= 10 ** (levels[i - win] / 10);
      if (levels[i - win] <= -100) silent--;
    }
    if (i >= win - 1 && silent === 0 && power < bestPower) [best, bestPower] = [i - win + 1, power];
  }
  return best < 0 ? null : x.slice(best * hop, (best + win) * hop);
}

export type TakeSound = { take: string; channel: string; snr: [number, number]; was: number; gainDb: number; gaps: [number, number][]; colour: VoiceColour | null };

/** A take's lines (`speech`), the on-camera actor's own (`own`), and the pauses of a second or more between lines (`gaps`). */
export function linesOf(units: Unit[], take: Take) {
  const onCam = take.setup?.who;
  const speech: [number, number][] = [];
  const own: [number, number][] = [];
  take.matches.forEach((m, i) => {
    if (!isFound(m)) return;
    speech.push([m.start, m.end]);
    if (units[i].who === onCam) own.push([m.start, m.end]);
  });
  speech.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  own.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gaps: [number, number][] = [];
  for (let i = 1; i < speech.length; i++) if (speech[i][0] - speech[i - 1][1] > 1.0) gaps.push([speech[i - 1][1] + 0.25, speech[i][0] - 0.25]);
  return { speech, own, gaps };
}

/** The take's sound as one channel: the one with more voice over hiss, or both if they're about the same (one mic on both). */
async function voiceChannel(ffmpeg: string, proxy: string, own: [number, number][], gaps: [number, number][], signal?: AbortSignal) {
  const [left, right] = await readAudio(ffmpeg, proxy, 2, SR, signal);
  const snr = [left, right].map((c) => rmsDb(segments(c, own)) - rmsDb(segments(c, gaps))) as [number, number];
  if (Math.abs(snr[0] - snr[1]) < 1.5) {
    const mono = new Float32Array(left.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
    return { mono, channel: "both", snr };
  }
  const c = snr[0] >= snr[1] ? 0 : 1;
  return { mono: c === 0 ? left : right, channel: `channel ${c + 1}`, snr };
}

/** The octave bands a voice's colour is matched in, by their middles (Hz). */
export const VOICE_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

/**
 * The colour of the on-camera actor's voice in a cleaned take: its level in each
 * of `VOICE_BANDS` (dB) over their own lines, the room's steady sound taken off,
 * and how far it stands over that (`snr`, dB): a band with little voice in it
 * is mostly the room.
 */
export type VoiceColour = { take: string; who: string; bands: number[]; snr: number[]; seconds: number };

/** Octave-band levels of the voiced moments in `spans` (within 15 dB of the loudest), less the room's steady sound in `quiet`. */
export function colourOf(x: Float32Array, spans: [number, number][], quiet: [number, number][]) {
  const N = 4096;
  const hop = N / 2;
  const window = hanning(N);
  const bins = VOICE_BANDS.map((f) => [Math.ceil(((f / Math.SQRT2) * N) / SR), Math.floor(((f * Math.SQRT2) * N) / SR)]);
  const framesOf = (where: [number, number][]) => {
    const out: { total: number; bands: number[] }[] = [];
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (const [s, e] of where) {
      for (let at = Math.floor(s * SR); at + N <= Math.min(x.length, Math.floor(e * SR)); at += hop) {
        for (let i = 0; i < N; i++) [re[i], im[i]] = [x[at + i] * window[i], 0];
        fft(re, im);
        const bands = bins.map(([a, b]) => {
          let p = 0;
          for (let k = a; k <= b; k++) p += re[k] * re[k] + im[k] * im[k];
          return p;
        });
        out.push({ total: bands.reduce((t, p) => t + p, 0), bands });
      }
    }
    return out;
  };
  const frames = framesOf(spans);
  if (!frames.length) return null;
  const loud = percentile(frames.map((f) => f.total), 90);
  const voiced = frames.filter((f) => f.total >= loud * 10 ** (-15 / 10));
  // The room's steady sound in each band: the quieter moments of the pauses (a breath or a footstep there isn't the room).
  const pauses = framesOf(quiet);
  const room = VOICE_BANDS.map((_, b) => (pauses.length ? percentile(pauses.map((f) => f.bands[b]), 20) : 0));
  const bands = VOICE_BANDS.map((_, b) => {
    const p = voiced.reduce((t, f) => t + f.bands[b], 0) / voiced.length;
    return 10 * Math.log10(Math.max(p - room[b], 0.1 * p) + 1e-20);
  });
  const snr = VOICE_BANDS.map((_, b) => (pauses.length ? bands[b] - 10 * Math.log10(room[b] + 1e-20) : 60));
  return { bands, snr, seconds: (voiced.length * hop) / SR };
}

/**
 * An actor sounding the same in every shot (Guy, Oct 5, 2026: what lazy editors
 * skip, #8): a boom placed differently for one setup brings the same voice
 * through fuller, thinner or duller, and the cut to it is heard. Most takes
 * match already (on shoots 1007, 1030, 1039, 1051 and 1053 an actor's cleaned
 * takes were within about 1 dB of each other band by band, and an EQ matching
 * all of them moved them only tenths of a dB, once the wrong way), so only a
 * take that stands out is moved: a band 3 dB or more off the actor's usual
 * colour (the middle of at least three takes), measured against the take's own
 * middle bands, where the voice is, so a take that's only quieter isn't. And
 * only where the voice stands well over the room's steady sound, in this take
 * and the actor's usual: lifting a band that's mostly the room lifts the room.
 * It's moved three quarters of the way back: cut by up to 4 dB, lifted by up
 * to 3. On those five shoots that moved two takes, both on 1053 and both in
 * the lowest band: the client's close-up (T082) and one of the doctor's medium
 * shots (T084), 4 to 5 dB thinner there than the actor's other shots. Gains in
 * `VOICE_BANDS` per take; a take not listed is left as is.
 */
export function voiceMatch(colours: VoiceColour[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const actors = new Map<string, VoiceColour[]>();
  for (const c of colours) actors.set(c.who, [...(actors.get(c.who) ?? []), c]);
  for (const takes of actors.values()) {
    if (takes.length < 3) continue;
    const usual = VOICE_BANDS.map((_, b) => median(takes.map((t) => t.bands[b])));
    const heard = VOICE_BANDS.map((_, b) => median(takes.map((t) => t.snr[b])));
    for (const t of takes) {
      const off = usual.map((u, b) => u - t.bands[b]);
      const level = (off[2] + off[3] + off[4]) / 3; // 500 Hz to 2 kHz
      const gains = off.map((d, b) => {
        const by = d - level;
        if (Math.abs(by) < 3 || t.snr[b] < 10 || heard[b] < 10) return 0;
        return Math.round(Math.max(-4, Math.min(3, 0.75 * by)) * 10) / 10;
      });
      if (gains.some((g) => g !== 0)) out.set(t.take, gains);
    }
  }
  return out;
}

/** The EQ that gives a take its match: a gentle octave-wide bell per band. */
export const matchEq = (gains: number[]) =>
  gains.flatMap((g, b) => (g ? [`equalizer=f=${VOICE_BANDS[b]}:t=o:w=1:g=${g}`] : [])).join(",");

/** Cleans one take's sound into `out` (24-bit mono WAV), with the colour of the on-camera actor's voice in it. */
export async function cleanTake(
  ffmpeg: string,
  units: Unit[],
  take: Take,
  proxy: string,
  out: string,
  signal?: AbortSignal,
  denoise: Denoise = "light",
): Promise<TakeSound> {
  const { speech, own, gaps } = linesOf(units, take);
  const { mono, channel, snr } = await voiceChannel(ffmpeg, proxy, own, gaps, signal);
  const fit = (x: Float32Array) => {
    if (x.length === mono.length) return x;
    const fitted = new Float32Array(mono.length);
    fitted.set(x.subarray(0, mono.length));
    return fitted;
  };
  const lines = own.length ? own : speech;
  const level = DENOISE[denoise];
  const print = level.print ? quietestSecond(mono) : null;
  let clean: Float32Array;
  if (level.print && print) {
    const joined = new Float32Array(print.length + mono.length);
    joined.set(print);
    joined.set(mono, print.length);
    clean = fit((await filterAudio(ffmpeg, joined, learned(print.length / SR, level.print), SR, signal)).subarray(print.length));
  } else clean = fit(await filterAudio(ffmpeg, mono, CLEAN, SR, signal));
  const was = loudness([segments(clean, lines)]);
  scale([clean], 10 ** ((SHAPE_LUFS - was) / 20));
  // The take's own hiss: its quietest moments (before action, between lines); the expander opens 10 dB above it.
  const hiss = percentile(frameLevels(clean, SR / 20).filter((l) => l > -100), 5);
  const gate = Number.isFinite(hiss) ? Math.min(hiss + 10, SHAPE_LUFS - 16) : -100;
  const voice = fit(await filterAudio(ffmpeg, clean, broadcast(10 ** (gate / 20), level.floor), SR, signal));
  const held = await hold(ffmpeg, voice, lines, signal);
  await writeAudio(ffmpeg, out, [held], SR, "pcm_s24le", signal);
  const colour = take.setup?.who && own.length ? colourOf(held, own, gaps) : null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    take: take.take,
    channel,
    snr: [r1(snr[0]), r1(snr[1])],
    was: r1(was),
    gainDb: r1(DIALOGUE_LUFS - was),
    gaps,
    colour: colour && colour.seconds >= 3 ? { take: take.take, who: take.setup!.who, ...colour } : null,
  };
}

/** The dialogue brought to -20 LUFS on `lines` with its peaks held 12 dB over, the same length as it came. */
export async function hold(ffmpeg: string, voice: Float32Array, lines: [number, number][], signal?: AbortSignal): Promise<Float32Array> {
  const fit = (x: Float32Array) => {
    if (x.length === voice.length) return x;
    const fitted = new Float32Array(voice.length);
    fitted.set(x.subarray(0, voice.length));
    return fitted;
  };
  scale([voice], 10 ** ((DIALOGUE_LUFS - loudness([segments(voice, lines)])) / 20));
  const ceiling = 10 ** ((DIALOGUE_LUFS + PEAK_OVER) / 20);
  let held = fit(await filterAudio(ffmpeg, voice, limiter(ceiling), SR, signal));
  // Holding the peaks takes a little loudness off a peaky take: made up going into the limiter, up to 3 dB.
  for (let made = 0, i = 0; i < 3; i++) {
    const short = Math.min(DIALOGUE_LUFS - loudness([segments(held, lines)]), 3 - made);
    if (short <= 0.2) break;
    scale([voice], 10 ** (short / 20));
    made += short;
    held = fit(await filterAudio(ffmpeg, voice, limiter(ceiling), SR, signal));
  }
  softCeiling([held]);
  return held;
}

/** A cleaned take's dialogue (`file`, rewritten) with its voice moved toward the actor's usual colour (`gains`, from `voiceMatch`). */
export async function matchVoice(ffmpeg: string, units: Unit[], take: Take, file: string, gains: number[], signal?: AbortSignal) {
  const { speech, own } = linesOf(units, take);
  const [x] = await readAudio(ffmpeg, file, 1, SR, signal);
  let eq = await filterAudio(ffmpeg, x, matchEq(gains), SR, signal);
  if (eq.length !== x.length) {
    const fitted = new Float32Array(x.length);
    fitted.set(eq.subarray(0, x.length));
    eq = fitted;
  }
  await writeAudio(ffmpeg, file, [await hold(ffmpeg, eq, own.length ? own : speech, signal)], SR, "pcm_s24le", signal);
}

/**
 * The scene's room tone, the cut's length plus a second: the quietest steady
 * pauses from the takes the cut leans on most, crossfaded; when there's too
 * little clean pause to loop without it pulsing, endless tone with the room's
 * own sound colour (its spectrum, random phase), so there's no loop to hear.
 */
export async function roomTone(
  ffmpeg: string,
  cut: Cut,
  sounds: Map<string, { file: string; gaps: [number, number][] }>,
  out: string,
  signal?: AbortSignal,
): Promise<{ level: number; pieces: number }> {
  const weight = new Map<string, number>();
  for (const p of cut.audio) weight.set(p.take, (weight.get(p.take) ?? 0) + p.recOut - p.recIn);
  const leaned = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  const chunks: { level: number; piece: Float32Array }[] = [];
  for (const take of leaned) {
    const sound = sounds.get(take);
    if (!sound) continue;
    const [audio] = await readAudio(ffmpeg, sound.file, 1, SR, signal);
    for (const [s, e] of sound.gaps) {
      if (e - s < 1.2) continue;
      const piece = audio.slice(Math.floor(s * SR), Math.floor(e * SR));
      const win = SR / 10;
      const levels: number[] = [];
      for (let i = 0; i + win <= piece.length; i += win) {
        let sum = 0;
        for (let k = i; k < i + win; k++) sum += piece[k] * piece[k];
        levels.push(20 * Math.log10(Math.sqrt(sum / win) + 1e-9));
      }
      // Steady background only: no frame much louder than the typical one.
      if (!levels.length || Math.max(...levels) - median(levels) > 6) continue;
      chunks.push({ level: median(levels), piece });
    }
  }
  chunks.sort((a, b) => a.level - b.level);
  // The room is the quietest of them. A pause that only seems steady can be someone talking off the script,
  // evened out by the compression (shoot 1053, Oct 5: two of three at -21 dB beside the room at -55): nothing
  // much louder than the quietest, and nothing anywhere near the dialogue's own level.
  const quiet = chunks.filter((c) => c.level <= Math.min(chunks[0].level + 6, DIALOGUE_LUFS - 15)).slice(0, 6);
  const picked = quiet.map((c) => c.piece);
  const total = Math.floor((cut.seconds + 1.0) * SR);
  const length = picked.reduce((n, p) => n + p.length, 0);
  if (length < 6 * SR) {
    const material = picked.length ? Float32Array.from(picked.flatMap((p) => Array.from(p))) : new Float32Array(SR * 2).map(() => 1e-5 * (Math.random() - 0.5));
    const n = 4096;
    const window = hanning(n);
    const power = new Float64Array(n / 2 + 1);
    let frames = 0;
    for (let i = 0; i + n <= material.length; i += n / 4) {
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      for (let k = 0; k < n; k++) re[k] = material[i + k] * window[k];
      fft(re, im);
      for (let k = 0; k <= n / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
      frames += 1;
    }
    const spectrum = Array.from(power, (p) => (frames ? Math.sqrt(p / frames) : 1e-4));
    const bed = new Float64Array(total + n);
    const random = seeded(7);
    for (let i = 0; i < total; i += n / 4) {
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      for (let k = 0; k <= n / 2; k++) {
        const phase = 2 * Math.PI * random();
        re[k] = spectrum[k] * Math.cos(phase);
        im[k] = spectrum[k] * Math.sin(phase);
        if (k > 0 && k < n / 2) {
          re[n - k] = re[k];
          im[n - k] = -im[k];
        }
      }
      im[0] = 0;
      im[n / 2] = 0;
      fft(re, im, true);
      for (let k = 0; k < n; k++) bed[i + k] += (re[k] / n) * window[k];
    }
    const target = Math.sqrt(material.reduce((s, v) => s + v * v, 0) / Math.max(1, material.length));
    let sum = 0;
    for (let i = 0; i < total; i++) sum += bed[i] * bed[i];
    const g = target / (Math.sqrt(sum / total) + 1e-12);
    const tone = new Float32Array(total);
    for (let i = 0; i < total; i++) tone[i] = bed[i] * g;
    await writeAudio(ffmpeg, out, [tone], SR, "pcm_s24le", signal);
    return { level: Math.round(20 * Math.log10(target + 1e-9) * 10) / 10, pieces: -picked.length };
  }
  const fade = Math.floor(0.3 * SR);
  const bed = new Float32Array(total + SR * 30);
  let at = 0;
  for (let k = 0; at < total; k++) {
    const piece = picked[k % picked.length];
    const overlap = at > 0 && piece.length > fade ? fade : 0;
    for (let i = 0; i < piece.length && at - overlap + i < bed.length; i++) {
      const v = piece[i] * (i < overlap ? i / overlap : 1);
      const j = at - overlap + i;
      bed[j] = i < overlap ? bed[j] * (1 - i / overlap) + v : v;
    }
    at += piece.length - overlap;
  }
  await writeAudio(ffmpeg, out, [bed.subarray(0, total)], SR, "pcm_s24le", signal);
  return { level: Math.round(median(quiet.map((c) => c.level)) * 10) / 10, pieces: picked.length };
}
