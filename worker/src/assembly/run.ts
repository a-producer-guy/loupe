// Makes one scene's cut, start to finish, in a work folder:
//
//   listening  every take transcribed (Whisper on fal), with its sound
//   script     which script it is (or the lines from the takes), who each take is on
//   cutting    the edit (engine.ts)
//   dialogue   each used take's sound cleaned, and the room tone
//   music      the extras, when asked for: ambience, a score (ElevenLabs on fal), an establishing shot
//   mixing     the preview mix and video
//   packing    the Premiere timeline and READ ME, and a check by ear
//
// It reads from B2 through `download` and returns the files to upload; the
// queue (job.ts) does the database and the uploads.

import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataUri, type FalClient, type WhisperWord } from "../ai/fal.js";
import { probe, type Tools } from "../proxy.js";
import { ffmpegPipe, readAudio, voicedWords } from "./audio.js";
import { cleanTake, matchVoice, roomTone, VOICE_BANDS, voiceMatch, type Denoise, type VoiceColour } from "./dialogue.js";
import { assembleAligned, describeShots, FPS, keepSaidLines, onMovement, type Setup, type Shot } from "./engine.js";
import { lineFlaws, pictureOf, type Picture } from "./picture.js";
import { CUT_FOLDER, introSeconds, mix, overlapIntro, type PushIn, pushIns, quietJoins, readMe, renderPreview, sceneFrame, timelineXml, type Intro, type TakeMedia } from "./finish.js";
import { ESTABLISHING_SECONDS, frameOf, makeEstablishing } from "./establishing.js";
import { cameraFor, FALLBACK_BRIEF, makeAmbience, makeScore, sceneBrief } from "./music.js";
import { workOutScene, type Corrections, type LibraryScript, type SceneTake } from "./scene.js";
import { heardInOrder, isFound, norm, tokens, type Word } from "./text.js";
import { lookAtTakes, VISION_MODEL } from "./vision.js";
import { fingerprint, remembered, type WorkCache } from "./remember.js";
import { steerOf, type Direction } from "./direction.js";
import { framesOfCut, gradeFor, type Look } from "./grade.js";
import { isolateVoice } from "./isolate.js";
import { judgePerformances, PERFORMANCE_MODEL, type Performance, type SetupTakes } from "./performance.js";

export const STEPS = ["listening", "script", "cutting", "dialogue", "music", "mixing", "packing"] as const;
export type Step = (typeof STEPS)[number];

export type ShootTake = {
  /** Where the camera clip sits in the shoot folder: "Raw/A001/SHGN1_S001_S001_T003.MOV". */
  path: string;
  proxyKey: string;
  previewKey: string;
  media: { durationSeconds?: number; width?: number; height?: number; audioChannels?: number; timecode?: string } | null;
  /** The proxy and preview already carry the shoot's look. */
  madeWithLut: boolean;
};

export type Shoot = { id: number; accountId?: number; name: string; prefix: string; lut: { key: string; fileName: string; name: string } | null; takes: ShootTake[] };

export type TranscriptCache = {
  get(take: ShootTake): Promise<Word[] | null>;
  put(take: ShootTake, words: Word[]): Promise<void>;
};

/** Keeps the establishing shot between runs (it costs about $2.50 to make). */
export type ShotCache = {
  get(file: string): Promise<boolean>;
  put(file: string): Promise<void>;
};

export type RunContext = {
  tools: Tools;
  fal: FalClient;
  workDir: string;
  signal: AbortSignal;
  log: (line: string) => void;
  step: (step: Step) => Promise<void>;
  download: (key: string, file: string) => Promise<void>;
  transcripts?: TranscriptCache;
  establishing?: ShotCache;
  /** The paid AI calls' answers, kept between versions (remember.ts). */
  work?: WorkCache;
};

export type AssemblyResult = {
  title: string;
  /** How the dialogue was cleaned: the studio voice isolation (paid), Loupe's own cleanup (a free preview), or as
   *  recorded with filters only (a note asked for it). */
  voice?: "isolated" | "preview" | "standard";
  fromTakes: boolean;
  scriptId: number | null;
  scriptTitle: string | null;
  /** Share of the script's lines found in the better takes (0-1). */
  match: number;
  client: string;
  partner: string;
  roles: string[];
  seconds: number;
  shots: Shot[];
  counts: { shots: number; reactions: number; splits: number; lines: number; pushIns: number; snaps: number };
  /** The scene opens on an AI establishing shot of the exterior. */
  establishing: boolean;
  /** What kind of scene the language model read it as, and so the camera: a comedy or dramedy is handheld. */
  tone: string;
  camera: "handheld" | "steady";
  /** Every take, what was worked out for it, and what the cut used. */
  takes: { take: string; path: string; found: Setup | "insert" | null; setup: Setup | null; used: boolean }[];
  /** The scene's lines as the cut has them (for a scene with no script, as worked out). */
  lines: { who: string; text: string }[];
  dropped: string[];
  jumps: number[];
  /** Share of the cut's words heard in order in the finished preview (0-1), the check by ear. */
  heard: number | null;
  place: string;
  lut: string | null;
  /** How each take's performance plays, from watching it (performance.ts), when it was watched. */
  performances?: Record<string, string>;
  /** Loupe's grade, from the director's note on the colour (grade.ts); null: none asked for. */
  look: Look | null;
  /** Which extras this version has (off unless a note asked for them). */
  extras: { establishing: boolean; ambience: boolean; score: boolean };
  /**
   * Every line in every take, for "other takes" (the script-centric cutting room): for each take, how it scored and,
   * line by line (in `lines` order), where in the take's preview the line is said (seconds), how much of it was said
   * (0-1), and the words heard. Null: not in that take.
   */
  lineTakes: Record<string, { q: number | null; why: string[]; complete: number | null; performance: number | null; lines: ({ s: number; e: number; match: number; said: string } | null)[] }>;
  /**
   * Subtitles as heard (not as shot: a line can start under the shot before it, or play over a reaction): each line
   * of `lines`, when it's heard in the preview, word by word (seconds from the preview's start).
   */
  subs: { line: number; s: number; e: number; words: { t: string; s: number }[] }[];
  /**
   * How to build this version again from the camera originals (the final file, final.ts): every shot's source take
   * and in point, where it sits, the moves, the establishing shot and the mix, which are in the package.
   */
  render: {
    seconds: number;
    pieces: { take: string; in: number; recIn: number; recOut: number }[];
    pushIns: PushIn[];
    handheld: boolean;
    intro: { seconds: number; overlap: number | null; path: string } | null;
    mix: string;
    grade: string | null;
  };
  /** Where this version's package sits in the scene's folder ("Loupe Cut/v12"; before Oct 8, "Loupe Cut" itself). */
  folder?: string;
  /** The package, relative to the scene's "Loupe Cut" folder. */
  preview: { path: string; size: number };
  files: { path: string; size: number }[];
};

export type AssemblyFile = { path: string; file: string; contentType: string };

/** A take's short name: "T003" for camera-numbered takes, else the clip's name. */
export function takeLabels(paths: string[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((p) => {
    const stem = path.posix.basename(p).replace(/\.[^.]+$/, "");
    const label = /T\d{3}/.exec(stem)?.[0] ?? stem;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label}-${n}`;
  });
}

/** fal's Whisper words as the engine's. */
export const wordsFrom = (chunks: WhisperWord[]): Word[] =>
  chunks
    .map((c) => ({ w: c.text.trim(), s: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] + 0.3, p: 0.9 }))
    .filter((w) => w.w && Number.isFinite(w.s));

async function transcribe(ctx: RunContext, audio: string): Promise<Word[]> {
  const mp3 = audio.replace(/\.wav$/, ".mp3");
  await ffmpegPipe(ctx.tools.ffmpeg, ["-v", "error", "-y", "-nostdin", "-i", audio, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-t", "1500", mp3], undefined, ctx.signal);
  const result = await ctx.fal.run<{ chunks?: WhisperWord[] }>(
    "fal-ai/whisper",
    { audio_url: dataUri(await readFile(mp3), "audio/mpeg"), task: "transcribe", language: "en", chunk_level: "word" },
    { signal: ctx.signal, timeoutMs: 15 * 60_000 },
  );
  await rm(mp3, { force: true });
  return wordsFrom(result.chunks ?? []);
}

/** Runs `work` over items, a few at a time. */
async function inBatches<T>(items: T[], size: number, work: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await work(items[i], i);
    }),
  );
}

export async function makeAssembly(
  ctx: RunContext,
  shoot: Shoot,
  library: LibraryScript[],
  corrections: Corrections,
  { denoise = "light", direction = {}, isolate = true }: { denoise?: Denoise; direction?: Direction; isolate?: boolean } = {},
): Promise<{ result: AssemblyResult; files: AssemblyFile[] }> {
  const { tools, signal, log } = ctx;
  const dir = ctx.workDir;
  const pkg = path.join(dir, CUT_FOLDER);
  // The extras, off unless asked for (Guy, Oct 7). A note on the music asks for a score.
  const extras = { establishing: Boolean(direction.extras?.establishing), ambience: Boolean(direction.extras?.ambience), score: Boolean(direction.extras?.score || direction.music) };
  await mkdir(pkg, { recursive: true });
  const takes = [...shoot.takes].sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  const labels = takeLabels(takes.map((t) => t.path));
  if (takes.length < 2) throw new Error("Loupe needs at least two takes with proxies to cut a scene.");

  // 1. Every take's sound (from its proxy, which is then deleted to save room), its words and its preview.
  await ctx.step("listening");
  const sound = new Map<string, string>();
  const preview = new Map<string, string>();
  const words = new Map<string, Word[]>();
  await inBatches(takes, 3, async (t, i) => {
    const label = labels[i];
    const proxy = path.join(dir, `${label}.proxy.mov`);
    await ctx.download(t.proxyKey, proxy);
    const wav = path.join(dir, `${label}.sound.wav`);
    await ffmpegPipe(tools.ffmpeg, ["-v", "error", "-y", "-nostdin", "-i", proxy, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", wav], undefined, signal);
    await rm(proxy, { force: true });
    sound.set(label, wav);
    const mp4 = path.join(dir, `${label}.preview.mp4`);
    await ctx.download(t.previewKey, mp4);
    preview.set(label, mp4);
    let w = (await ctx.transcripts?.get(t)) ?? null;
    if (!w) {
      w = await transcribe(ctx, wav);
      await ctx.transcripts?.put(t, w).catch(() => {});
    }
    words.set(label, w);
  });
  log(`Transcribed ${takes.length} takes (${[...words.values()].reduce((n, w) => n + w.length, 0)} words).`);

  // 2. The script, who each take is on, and the client's part.
  await ctx.step("script");
  const sceneTakes: SceneTake[] = [];
  for (const [i, t] of takes.entries()) {
    const label = labels[i];
    const [audio] = await readAudio(tools.ffmpeg, sound.get(label)!, 1, 16000, signal);
    sceneTakes.push({
      take: label,
      path: t.path,
      length: t.media?.durationSeconds ?? null,
      timecode: t.media?.timecode ?? null,
      // Each word where it's actually heard: Whisper can start one seconds early, over the silence before it.
      words: voicedWords(words.get(label)!, audio, 16000),
      audio,
      video: preview.get(label)!,
    });
  }
  const scene = await workOutScene({
    ffmpeg: tools.ffmpeg,
    takes: sceneTakes,
    rate: 16000,
    library,
    workDir: dir,
    // What each take shows, seen once per scene (the same stills: the same answer).
    look: async (stills) => {
      const sent = await Promise.all(stills.map(async (s) => [s.label, await readFile(s.file)] as const));
      const name = `seen-${fingerprint(VISION_MODEL, ...sent.flat())}.json`;
      return remembered(ctx.work, dir, name, () => lookAtTakes(ctx.fal, stills, signal), (seen) => seen !== null);
    },
    corrections,
    signal,
    log,
  });
  for (const t of sceneTakes) t.audio = new Float32Array(0); // free the memory
  // Each take's picture, read once: for what goes wrong in it (below, once the scene read says whether the camera is
  // handheld) and for the cut's movements.
  const pictures = new Map<string, Picture>();
  await inBatches(scene.takes, 3, async (x) => {
    pictures.set(x.take, await pictureOf(tools.ffmpeg, preview.get(x.take)!, signal));
  });

  // How each performance plays (Guy, Oct 6: "judge acting"): Gemini watches every take of each setup, with its sound.
  const setups = new Map<string, SetupTakes>();
  for (const x of scene.takes) {
    if (!x.setup || x.sceneStart === null || x.sceneEnd === null || !preview.has(x.take)) continue;
    const key = `${x.setup.who}|${x.setup.framing}`;
    const lines = scene.units.filter((u) => u.who === x.setup!.who).map((u) => u.text);
    const s = setups.get(key) ?? { who: x.setup.who, framing: x.setup.framing, lines, takes: [] };
    s.takes.push({ take: x.take, video: preview.get(x.take)!, from: x.sceneStart, to: x.sceneEnd });
    setups.set(key, s);
  }
  // Judged once per scene: a setup's takes, lines and moments the same, its answer is reused.
  const previewOf = new Map(takes.map((t, i) => [labels[i], t.previewKey]));
  const performance: Record<string, Performance> = {};
  for (const s of setups.values()) {
    const asked = JSON.stringify({ who: s.who, framing: s.framing, lines: s.lines, takes: s.takes.map((t) => [t.take, previewOf.get(t.take), t.from, t.to]) });
    const judged = await remembered(ctx.work, dir, `performance-${fingerprint(PERFORMANCE_MODEL, asked)}.json`, () => judgePerformances({ fal: ctx.fal, ffmpeg: tools.ffmpeg, setups: [s], signal, log }), (p) => Object.keys(p).length > 0);
    Object.assign(performance, judged);
  }
  if (Object.keys(performance).length) log(`Performances: ${Object.entries(performance).map(([t, p]) => `${t} ${p.bonus >= 0 ? "+" : ""}${p.bonus}`).join(", ")}.`);

  // 3. The scene read once by a language model (place, ambience, score, the exterior, the lines where it peaks,
  //    its tone and biggest laugh), then the cut, which shows the other actor taking in the lines where it peaks.
  await ctx.step("cutting");
  const title = scene.script.fromTakes ? shoot.name : scene.script.title;
  const said = keepSaidLines(scene.units, scene.takes).units;
  const brief = await sceneBrief(ctx.fal, scene.script.heading ?? "", said, signal).catch((error: Error) => {
    if (signal.aborted) throw error;
    log(`Scene brief by default (${error.message}).`);
    return FALLBACK_BRIEF;
  });
  // A comedy (or dramedy) is shot handheld, with a quick zoom on its biggest laugh (Guy, Oct 2).
  const camera = cameraFor(brief.tone);
  const handheld = camera === "handheld";
  const laugh = handheld ? brief.laugh : null;
  // What goes wrong in each take's picture (Guy, Oct 5: what lazy editors use anyway): soft focus, camera bumps and,
  // handheld, the camera off its actor, line by line against the setup's other takes.
  for (const [take, flaws] of lineFlaws(scene.takes, pictures, { handheld })) scene.takes.find((x) => x.take === take)!.flaws.push(...flaws);
  const seen = scene.takes.flatMap((x) => {
    const inScene = x.flaws.filter((f) => x.sceneStart !== null && x.sceneEnd !== null && f.e > x.sceneStart && f.s < x.sceneEnd);
    return inScene.length ? [`${x.take} ${[...new Set(inScene.map((f) => f.what))].join(", ")}`] : [];
  });
  if (seen.length) log(`Flaws, against each setup's other takes, kept clear of where they can be: ${seen.join("; ")}.`);
  // With an establishing shot in front, the scene starts right on its first line, heard under the shot's end.
  const exterior = extras.establishing ? brief.exterior : null;
  const cut0 = assembleAligned(title, scene.client, scene.roles, scene.units, scene.takes, { tightHead: Boolean(exterior), beats: brief.peaks, laugh, steer: steerOf(direction, performance) });
  log(`Cut: ${cut0.seconds.toFixed(0)} s, ${cut0.video.length} shots, jumps ${cut0.jumps.length}.`);

  // 4. Dialogue, cleaned, for every take the timeline uses; then the room tone.
  await ctx.step("dialogue");
  const used = new Set(cut0.audio.map((p) => p.take));
  for (const p of cut0.video) for (const alt of p.alternates.slice(0, 1)) used.add(alt.take);
  const T = new Map(cut0.takes.map((t) => [t.take, t]));
  const cleaned = new Map<string, string>();
  const gaps = new Map<string, { file: string; gaps: [number, number][] }>();
  const colours: VoiceColour[] = [];
  await inBatches([...used], 3, async (take) => {
    const out = path.join(dir, `${take}_dialogue.wav`);
    // Alternates of a setup are cleaned the same way, with the setup's actor as the one on camera.
    const info = await cleanTake(tools.ffmpeg, scene.units, T.get(take)!, sound.get(take)!, out, signal, denoise);
    cleaned.set(take, out);
    gaps.set(take, { file: out, gaps: info.gaps });
    if (info.colour) colours.push(info.colour);
  });
  // Each actor sounding the same in every shot (Guy, Oct 5: what lazy editors skip): a take whose voice stands out.
  const match = voiceMatch(colours);
  await inBatches([...match.keys()], 3, (take) => matchVoice(tools.ffmpeg, scene.units, T.get(take)!, cleaned.get(take)!, match.get(take)!, signal));
  if (match.size) {
    const hz = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
    const moved = [...match].map(([take, g]) => `${take} ${g.flatMap((x, b) => (x ? [`${x > 0 ? "+" : ""}${x} dB at ${hz(VOICE_BANDS[b])}`] : [])).join(", ")}`);
    log(`Voices matched shot to shot: ${moved.join("; ")}.`);
  }
  const tone = path.join(dir, "room_tone.wav");
  const room = await roomTone(tools.ffmpeg, cut0, gaps, tone, signal);
  log(`Dialogue: ${used.size} takes, Broadcast, ${denoise} noise reduction; room tone at ${room.level} dB from ${room.pieces > 0 ? `${room.pieces} pauses` : "the room's own colour"}.`);
  // Then the voice isolated from everything else in every line (Guy, Oct 6), unless a note asked for the filters alone.
  // After the room tone, which is made from the takes' own pauses and lies under the lines.
  // Free cuts are previews (Guy, Oct 9): Loupe's own cleanup; the voice is isolated once the scene is paid for.
  const voice: "isolated" | "preview" | "standard" = direction.clean === "standard" ? "standard" : isolate ? "isolated" : "preview";
  if (voice === "isolated") {
    let isolated = 0;
    let reused = 0;
    await inBatches([...cleaned.keys()], 3, async (take) => {
      try {
        if ((await isolateVoice(ctx.fal, tools.ffmpeg, scene.units, T.get(take)!, cleaned.get(take)!, signal, ctx.work)).reused) reused += 1;
        isolated += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        log(`${take}: voice not isolated, filters only (${(error as Error).message}).`);
      }
    });
    log(`Voice isolation: ${isolated} of ${cleaned.size} takes${reused ? ` (${reused} kept from an earlier version)` : ""}.`);
  }

  // What the scene looks like inside, for the establishing shot to match (Guy, Oct 5): a frame of each actor's first
  // shot, or of their first medium one (more of the room), from the previews as graded.
  const interiors = async () => {
    const picks = new Map<string, (typeof cut0.video)[number]>();
    for (const p of cut0.video) {
      const setup = T.get(p.take)?.setup;
      if (!setup || p.kind !== "shot") continue;
      const seen = picks.get(setup.who);
      if (!seen || (T.get(seen.take)!.setup!.framing === "close" && setup.framing === "medium")) picks.set(setup.who, p);
    }
    return Promise.all([...picks.values()].map((p) => frameOf(tools.ffmpeg, preview.get(p.take)!, (p.in + p.out) / 2, signal)));
  };

  // 5. The extras that were asked for (ambience, score, establishing shot), made at the same time.
  await ctx.step("music");
  const ambience = extras.ambience ? path.join(dir, "ambience.mp3") : null;
  const music = extras.score ? path.join(dir, "music.mp3") : null;
  const establishing = path.join(dir, "establishing.mp4");
  const [, , made] = await Promise.all([
    ambience ? makeAmbience(ctx.fal, brief, ambience, signal) : null,
    // A note on the music (Loupe, Oct 6) comes first in the composer's brief.
    music
      ? makeScore(ctx.fal, direction.music ? { ...brief, score: `The director's note, which comes first: ${direction.music}. ${brief.score}` } : brief, cut0.seconds + (exterior ? ESTABLISHING_SECONDS : 0), music, signal)
      : null,
    (async (): Promise<Intro> => {
      if (!exterior) return null;
      try {
        if (!(await ctx.establishing?.get(establishing))) {
          await makeEstablishing(ctx.fal, exterior, establishing, signal, await interiors().catch(() => []));
          await ctx.establishing?.put(establishing).catch(() => {});
        }
        const info = await probe(tools, establishing);
        const seconds = Math.min(ESTABLISHING_SECONDS, Number(info.format.duration) || ESTABLISHING_SECONDS);
        return { file: establishing, seconds, hasAudio: info.streams.some((x) => x.codec_type === "audio") };
      } catch (error) {
        if (signal.aborted) throw error;
        log(`No establishing shot (${(error as Error).message}).`);
        return null;
      }
    })(),
  ]);
  // The first line heard under the establishing shot's end, then the picture cuts in (Guy, Oct 5).
  const opened = overlapIntro(cut0, made);
  const intro = opened.intro;
  // Every cut on a movement, where there's one near it.
  const moving = onMovement(opened.cut, new Map([...pictures].map(([take, p]) => [take, p.motion])));
  if (moving.moved) log(`Cuts on a movement: ${moving.moved}.`);
  let cut = moving.cut;
  const pushed = pushIns(cut, brief.peaks, laugh);
  const snapped = pushed.some((x) => x.snap !== undefined);
  log(
    `Brief: ${brief.place}; ${brief.tone}, so a ${camera} camera; establishing shot ${intro ? `yes${intro.overlap ? `, the first line under its last ${intro.overlap.toFixed(1)} s` : ""}` : "no"}; ` +
      `push-ins on ${pushed.length - (snapped ? 1 : 0)} shot(s)${snapped ? ", a quick zoom on the biggest laugh" : ""}; ` +
      `${cut.video.filter((p) => p.kind === "reaction").length} reaction(s), ${cut.blocks.reduce((n, b) => n + b.patches.length, 0)} line(s) heard over the listener.`,
  );

  // 6. The mix and the preview.
  await ctx.step("mixing");
  const audioDir = path.join(pkg, "Audio");
  const mixFile = path.join(dir, "mix.wav");
  // Every join in the dialogue on its quietest frame, before the mix and the timeline both take it.
  const joined = await quietJoins(tools.ffmpeg, cut, cleaned, signal);
  const moved = joined.audio.filter((a, i) => a.recIn !== cut.audio[i].recIn).length;
  if (moved) log(`Dialogue joins: ${moved} moved onto a quieter frame.`);
  cut = joined;
  const { layers, seconds } = await mix({ ffmpeg: tools.ffmpeg, cut, dialogue: cleaned, roomTone: tone, ambience, music, intro, audioDir, mixFile, signal });
  const media = new Map<string, TakeMedia>(
    takes.map((t, i) => [labels[i], { width: t.media?.width ?? 1920, height: t.media?.height ?? 1080, audioChannels: t.media?.audioChannels ?? 2, preview: preview.get(labels[i])! }]),
  );
  // The look: the previews may already carry it; if not, the preview gets it here.
  const looked = takes.some((t) => t.madeWithLut);
  let lutFile: string | null = null;
  if (shoot.lut && !looked) {
    lutFile = path.join(dir, "look.cube");
    await ctx.download(shoot.lut.key, lutFile);
  }
  // Loupe's grade, from the note on the colour (Guy, Oct 6): set by looking at frames of this cut, rendered into the
  // preview after the shoot's look, and the same .cube goes in the package for Premiere.
  let look: Look | null = null;
  const gradeFile = path.join(pkg, "Loupe look.cube");
  if (direction.look) {
    try {
      const frames = await framesOfCut({ ffmpeg: tools.ffmpeg, shots: cut.video, previews: preview, shootLut: lutFile, signal });
      look = await gradeFor({ fal: ctx.fal, ffmpeg: tools.ffmpeg, note: direction.look, frames, cube: gradeFile, title: `${title} - Loupe look`, signal, log });
      log(`Grade: "${direction.look}": ${look.said}`);
    } catch (error) {
      if (signal.aborted) throw error;
      log(`No grade (${(error as Error).message}).`);
    }
  }
  const previewName = `${title} - Loupe cut (preview).mp4`;
  await renderPreview({ ffmpeg: tools.ffmpeg, cut, media, mixFile, lut: lutFile, grade: look ? gradeFile : null, intro, pushIns: pushed, handheld, out: path.join(pkg, previewName), signal });

  // 7. The timeline, the READ ME, and a check by ear: every kept line heard once, in order.
  await ctx.step("packing");
  const lutNote =
    (shoot.lut
      ? looked
        ? `LUT: the proxies and the preview already have the shoot's look (${shoot.lut.name}). For the camera originals, add an Adjustment Layer on top with Lumetri Color > Basic Correction > Input LUT = LUTs/${shoot.lut.fileName} (it comes with the Premiere download).`
        : `LUT: add an Adjustment Layer on top with Lumetri Color > Basic Correction > Input LUT = LUTs/${shoot.lut.fileName} (it comes with the Premiere download).`
      : "No LUT was set for this shoot.") +
    (look
      ? ` Grade (Loupe: ${look.said}): on ${shoot.lut ? "the same" : "an"} Adjustment Layer on top, Lumetri Color > Creative > Look = "${CUT_FOLDER}/Loupe look.cube" (after the LUT, as the preview has it).`
      : "");
  const xmlName = `${title} - Loupe cut.xml`;
  if (intro) await copyFile(intro.file, path.join(pkg, "Establishing (AI).mp4"));
  await writeFile(path.join(pkg, xmlName), timelineXml({ cut, title, prefix: shoot.prefix, media, layers, seconds, place: brief.place, lutNote, intro, pushIns: pushed, handheld }));
  await writeFile(path.join(pkg, "READ ME.txt"), readMe({ title, prefix: shoot.prefix, fromTakes: scene.script.fromTakes, lutNote, handheld, ambience: layers.ambience, music: layers.music }));
  let heard: number | null = null;
  try {
    const result = await ctx.fal.run<{ text?: string }>(
      "fal-ai/whisper",
      { audio_url: dataUri(await mp3Of(tools, mixFile, signal), "audio/mpeg"), task: "transcribe", language: "en", chunk_level: "segment" },
      { signal, timeoutMs: 10 * 60_000 },
    );
    const expected = cut.blocks.flatMap((b) => cut.units.slice(b.first, b.last + 1)).flatMap((u) => tokens(u.text).map(norm));
    const got = tokens(result.text ?? "").map(norm);
    const { matched, total } = heardInOrder(expected, got);
    heard = total ? Math.round((matched / total) * 100) / 100 : null;
    log(`Check by ear: ${matched}/${total} of the cut's words heard in order.`);
  } catch (error) {
    if (signal.aborted) throw error;
    log(`No check by ear (${(error as Error).message}).`);
  }

  const files: AssemblyFile[] = [
    { path: xmlName, file: path.join(pkg, xmlName), contentType: "application/xml" },
    { path: previewName, file: path.join(pkg, previewName), contentType: "video/mp4" },
    { path: "READ ME.txt", file: path.join(pkg, "READ ME.txt"), contentType: "text/plain; charset=utf-8" },
    ...[...used].filter((t) => cleaned.has(t)).map((t) => ({ path: `Audio/${t}_dialogue.wav`, file: path.join(audioDir, `${t}_dialogue.wav`), contentType: "audio/wav" })),
    ...["room_tone.wav", ...(layers.ambience ? ["ambience.wav"] : []), ...(layers.music ? ["music.wav"] : [])].map((name) => ({ path: `Audio/${name}`, file: path.join(audioDir, name), contentType: "audio/wav" })),
    ...(intro ? [{ path: "Establishing (AI).mp4", file: path.join(pkg, "Establishing (AI).mp4"), contentType: "video/mp4" }] : []),
    ...(look ? [{ path: "Loupe look.cube", file: gradeFile, contentType: "text/plain; charset=utf-8" }] : []),
    // The finished mix, for the final file (made from the camera originals later, with exactly this sound).
    { path: "Audio/mix.wav", file: mixFile, contentType: "audio/wav" },
  ];
  // The shot list as the preview plays it: the establishing shot first, then the cut (its sound starting under the
  // shot's end), with its push-ins.
  const lead = sceneFrame(intro) / FPS;
  const shots: Shot[] = [
    ...(intro
      ? [{ n: 0, at: 0, seconds: Math.round(introSeconds(intro) * 100) / 100, take: "AI", who: "", framing: "medium" as const, kind: "establishing" as const, line: brief.place, speaker: "", listening: false, why: "An establishing shot of the outside, made by Seedance", alternates: [], cut: null }]
      : []),
    ...describeShots(cut).map((shot, k) => {
      const push = pushed.find((x) => x.piece === k);
      return { ...shot, at: Math.round((shot.at + lead) * 1000) / 1000, ...(push ? { pushIn: push.scale, ...(push.snap !== undefined ? { snap: true } : {}) } : {}) };
    }),
  ];
  // When every word is heard in the preview: each dialogue edit plays its take from `in` to `out` at `recIn` on the
  // scene's timeline, which starts `lead` seconds into the preview.
  const heardWords = new Map<number, { t: string; s: number; e: number }[]>();
  const TT = new Map(cut.takes.map((t) => [t.take, t]));
  for (const a of cut.audio) {
    const take = TT.get(a.take);
    if (!take) continue;
    take.matches.forEach((m, j) => {
      if (!isFound(m) || m.end < a.in || m.start > a.out) return;
      for (const w of take.words.slice(m.j0, m.j1 + 1)) {
        if (w.s < a.in - 0.05 || w.s > a.out) continue;
        const at = lead + a.recIn + (w.s - a.in);
        heardWords.set(j, [...(heardWords.get(j) ?? []), { t: w.t, s: at, e: at + (w.e - w.s) }]);
      }
    });
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const subs = [...heardWords.entries()]
    .map(([line, ws]) => {
      const words = ws.sort((x, y) => x.s - y.s).filter((w, i, all) => i === 0 || w.s - all[i - 1].s > 0.01);
      return { line, s: r3(words[0].s), e: r3(Math.max(...words.map((w) => w.e))), words: words.map((w) => ({ t: w.t, s: r3(w.s) })) };
    })
    .sort((x, y) => x.s - y.s);
  const sizes = await Promise.all(files.map(async (f) => (await stat(f.file)).size));
  const result: AssemblyResult = {
    title,
    fromTakes: scene.script.fromTakes,
    scriptId: scene.script.id,
    scriptTitle: scene.script.fromTakes ? null : scene.script.title,
    match: Math.round(scene.script.match * 100) / 100,
    client: scene.client,
    partner: cut.partner,
    roles: scene.roles,
    seconds: Math.round(seconds * 100) / 100,
    shots,
    counts: {
      shots: cut.video.length,
      reactions: cut.video.filter((p) => p.kind === "reaction").length,
      splits: cut.blocks.filter((b) => b.cutAfter && b.cutAfter.kind !== "straight").length,
      lines: cut.units.length,
      pushIns: pushed.filter((x) => x.snap === undefined).length,
      snaps: pushed.filter((x) => x.snap !== undefined).length,
    },
    establishing: Boolean(intro),
    extras: { establishing: Boolean(intro), ambience: layers.ambience, score: layers.music },
    lineTakes: Object.fromEntries(
      cut.takes.map((t) => {
        const s = cut.scores[t.take];
        const r2 = (x: number) => Math.round(x * 100) / 100;
        return [
          t.take,
          {
            q: s ? s.q : null,
            why: s ? s.why : [],
            complete: s ? s.complete : null,
            performance: performance[t.take]?.bonus ?? null,
            lines: t.matches.map((m) => (isFound(m) ? { s: r2(m.start), e: r2(m.end), match: r2(m.score), said: m.said } : null)),
          },
        ];
      }),
    ),
    tone: brief.tone,
    camera,
    takes: scene.takes.map((t) => ({ take: t.take, path: t.path, found: scene.found[t.take] ?? null, setup: t.setup, used: used.has(t.take) || cut.video.some((p) => p.take === t.take) })),
    lines: cut.units.map((u) => ({ who: u.who, text: u.text })),
    subs,
    voice,
    dropped: cut.dropped,
    jumps: cut.jumps,
    heard,
    place: brief.place,
    lut: shoot.lut?.name ?? null,
    look,
    ...(Object.keys(performance).length ? { performances: Object.fromEntries(Object.entries(performance).map(([t, p]) => [t, p.note.replace(/^on watching: /, "")])) } : {}),
    render: {
      seconds: cut.seconds,
      pieces: cut.video.map((p) => ({ take: p.take, in: p.in, recIn: p.recIn, recOut: p.recOut })),
      pushIns: pushed,
      handheld,
      intro: intro ? { seconds: intro.seconds, overlap: intro.overlap ?? null, path: "Establishing (AI).mp4" } : null,
      mix: "Audio/mix.wav",
      grade: look ? "Loupe look.cube" : null,
    },
    preview: { path: previewName, size: sizes[1] },
    files: files.map((f, i) => ({ path: f.path, size: sizes[i] })),
  };
  return { result, files };
}

async function mp3Of(tools: Tools, wav: string, signal: AbortSignal): Promise<Buffer> {
  return ffmpegPipe(tools.ffmpeg, ["-v", "error", "-nostdin", "-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-f", "mp3", "-"], undefined, signal);
}
