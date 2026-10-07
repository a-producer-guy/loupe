import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { framingsFor, onCameraSides, setupSplits } from "../src/assembly/coverage.js";
import { consensusSentences, crewSentence, sceneStart, scriptFrom } from "../src/assembly/derive.js";
import { alignTakes, assemble, assembleAligned, collapseLoops, describeShots, type Cut, type Setup, type TakeInput } from "../src/assembly/engine.js";
import { cameraAt, handheldFilter, handheldKeys, HANDHELD_ZOOM, shakeFor, SNAP_FRAMES, SNAP_SCALE, zoomAt } from "../src/assembly/camera.js";
import { DIP_JOIN, duckPoints, overlapIntro, PREVIEW_VIDEO, pushIns, SCORE_IN, sceneFrame, speechOnTimeline, tcFrames, timelineXml, zoomFor } from "../src/assembly/finish.js";
import { cameraFor, parseBrief } from "../src/assembly/music.js";
import { takeLabels, wordsFrom } from "../src/assembly/run.js";
import { twoGroups, whoSays } from "../src/assembly/scene.js";
import { alignTake, buildUnits, matchingBlocks, pyRound, sentences, takeWords, tokens, type ScriptLine, type Word } from "../src/assembly/text.js";
import { parseCoverage } from "../src/assembly/vision.js";
import { voicedWords } from "../src/assembly/audio.js";

// Every name here is made up.

describe("words and sentences, as the pilot's Python had them", () => {
  test("rounding works like Python's round()", () => {
    assert.deepEqual(
      [pyRound(0.125, 2), pyRound(0.375, 2), pyRound(2.675, 2), pyRound(0.995, 2), pyRound(2.5), pyRound(3.5), pyRound(-0.125, 2)],
      [0.12, 0.38, 2.67, 0.99, 2, 4, -0.12],
    );
  });

  test("lining up two lists of words gives difflib's matching blocks", () => {
    const a = "the cat sat on the mat today".split(" ");
    const b = "so the cat sat down on a mat today ok".split(" ");
    assert.deepEqual(matchingBlocks(a, b), [
      [0, 1, 3],
      [3, 5, 1],
      [5, 7, 2],
    ]);
    assert.deepEqual(matchingBlocks("a b c a b c".split(" "), "c a b a c b c".split(" ")), [
      [2, 0, 3],
      [5, 4, 1],
    ]);
  });

  test("tokens and sentences", () => {
    assert.deepEqual(tokens("You’re lying, 24/7!"), ["you're", "lying", "24", "7"]);
    assert.deepEqual(sentences("Paris. Yes, I'm aware. Did he...ask? \"Fine.\""), ["Paris.", "Yes, I'm aware.", "Did he...ask?", '"Fine."']);
  });

  test("a take is lined up against the script line by line", () => {
    const units = buildUnits([
      { kind: "action", text: "She looks up." },
      { kind: "speech", who: "ANA", text: "Where were you? I waited." },
      { kind: "speech", who: "BEN", text: "Traffic." },
    ]);
    assert.equal(units.length, 3);
    assert.equal(units[0].actionBefore, "She looks up.");
    const words: Word[] = ["okay", "action", "where", "were", "you", "i", "waited", "traffic", "cut"].map((w, i) => ({ w, s: i, e: i + 0.8, p: 0.9 }));
    const matches = alignTake(units, takeWords(words));
    assert.deepEqual(
      matches.map((m) => m.score),
      [1, 1, 1],
    );
    assert.equal((matches[1] as { start: number }).start, 5);
  });

  test("Whisper's loops on silence collapse", () => {
    assert.equal(collapseLoops("that was great great great"), "that was great");
    // As the pilot's Python did it, quirks and all.
    assert.equal(collapseLoops("jump jump jump the gun"), "jump the");
  });
});

// A made-up two-hander: Ana (the client) and Ben, four setups, two takes each.
const SCRIPT: ScriptLine[] = [
  { kind: "action", text: "ANA sits at the table. BEN stands by the door." },
  { kind: "speech", who: "ANA", text: "You came back. I didn't think you would." },
  { kind: "speech", who: "BEN", text: "I forgot my keys." },
  { kind: "speech", who: "ANA", text: "Your keys are in the drawer, where they always are. You know that." },
  { kind: "speech", who: "BEN", text: "Maybe I wanted to see you." },
  { kind: "action", text: "Beat. She stands and walks to him." },
  { kind: "speech", who: "ANA", text: "Then look at me and say it. Say it properly this time." },
  { kind: "speech", who: "BEN", text: "I missed you." },
  { kind: "speech", who: "ANA", text: "Good. Now get your keys." },
];

/** A take where every line is said, a little slower or faster each time. */
function take(n: number, setup: Setup, pace: number, after = `Cut! Thank you, reset for ${n + 1}.`): TakeInput {
  const words: Word[] = [];
  let t = 4;
  const say = (text: string) => {
    for (const w of text.split(" ")) {
      words.push({ w, s: t, e: t + 0.3 * pace, p: 0.95 });
      t += 0.38 * pace;
    }
  };
  say(`Scene one, take ${n}. Action.`);
  t += 1.2;
  for (const line of SCRIPT) {
    if (line.kind === "speech") {
      t += 0.6;
      say(line.text);
    } else t += 1.5;
  }
  t += 1;
  say(after);
  return { take: `T00${n}`, path: `Raw/A001/CLIP_T00${n}.MOV`, length: t + 2, timecode: "10:00:00:00", setup, words };
}

const TAKES: TakeInput[] = [
  take(1, { who: "ANA", framing: "medium" }, 1.0),
  take(2, { who: "ANA", framing: "medium" }, 1.05, "great cut"),
  take(3, { who: "ANA", framing: "close" }, 0.95),
  take(4, { who: "ANA", framing: "close" }, 1.0, "that's the one"),
  take(5, { who: "BEN", framing: "medium" }, 1.0),
  take(6, { who: "BEN", framing: "medium" }, 1.02),
  take(7, { who: "BEN", framing: "close" }, 0.98),
  take(8, { who: "BEN", framing: "close" }, 1.0),
];

/** The same scene cut to follow an establishing shot (straight into the first line). */
function assembleTight() {
  const units = buildUnits(SCRIPT);
  return assembleAligned("Keys", "ANA", ["ANA", "BEN"], units, alignTakes(units, TAKES), { tightHead: true });
}

describe("the cut", () => {
  const cut = assemble({ title: "Keys", client: "ANA", script: SCRIPT, takes: TAKES });
  const setupOf = (t: string) => TAKES.find((x) => x.take === t)!.setup!;

  test("every line is in the cut once, in order, picture and sound end to end", () => {
    const covered = cut.blocks.flatMap((b) => Array.from({ length: b.last - b.first + 1 }, (_, i) => b.first + i));
    assert.deepEqual(
      covered,
      cut.units.map((_, i) => i),
    );
    for (let i = 1; i < cut.audio.length; i++) assert.ok(Math.abs(cut.audio[i].recIn - cut.audio[i - 1].recOut) < 0.002);
    for (let i = 1; i < cut.video.length; i++) assert.ok(Math.abs(cut.video[i].recIn - cut.video[i - 1].recOut) < 0.002);
    assert.ok(Math.abs(cut.video.at(-1)!.recOut - cut.audio.at(-1)!.recOut) < 0.002);
  });

  test("no jump cuts: two shots of the same actor never meet", () => {
    assert.deepEqual(cut.jumps, []);
    for (let i = 1; i < cut.video.length; i++) assert.notEqual(setupOf(cut.video[i].take).who, setupOf(cut.video[i - 1].take).who);
  });

  test("it opens on whoever says the first line, and the director's favourite reads win", () => {
    assert.equal(setupOf(cut.video[0].take).who, "ANA");
    const used = new Set(cut.video.map((p) => p.take));
    assert.ok(used.has("T004") || used.has("T002"), "a take the director praised is used");
  });

  test("the shot list says what each shot is and why", () => {
    const shots = describeShots(cut);
    assert.equal(shots.length, cut.video.length);
    assert.ok(shots.every((s) => s.why && s.line && (s.framing === "medium" || s.framing === "close")));
  });

  test("the Premiere timeline is one well-formed sequence with every layer", () => {
    const media = new Map(TAKES.map((t) => [t.take, { width: 1920, height: 1080, audioChannels: 2, preview: "" }]));
    const layers = { start: 0, musicLength: cut.seconds, points: duckPoints(speechOnTimeline(cut), cut.seconds, 0), musicGainDb: -6, ambienceGainDb: -20, introGainDb: -10, ambience: true, music: true };
    const xml = timelineXml({ cut, title: "Keys", prefix: "2026-10-01_Keys_p1", media, layers, seconds: cut.seconds, place: "kitchen", lutNote: "No LUT." });
    assert.match(xml, /^<\?xml/);
    for (const tag of ["sequence", "clipitem", "track", "file", "marker"]) {
      const opens = xml.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0;
      const closes = xml.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      const selfClosed = xml.match(new RegExp(`<${tag} [^>]*/>`, "g"))?.length ?? 0;
      assert.equal(opens - selfClosed, closes, tag);
    }
    assert.equal(xml.match(/<track[ >]/g)?.length, 3 + 10);
    // Each actor's dialogue on a track of their own: Ana's takes are T001-T004, Ben's T005-T008.
    const audioTracks = xml.slice(xml.indexOf("<audio><numOutputChannels>")).split("</track>");
    const names = (track: string) => [...track.matchAll(/<clipitem id="[^"]+"><name>([^<]+)<\/name>/g)].map((m) => m[1]);
    assert.ok(names(audioTracks[0]).length && names(audioTracks[0]).every((n) => /^DIALOGUE ANA T00[1-4]$/.test(n)), `A1 is Ana's: ${names(audioTracks[0])}`);
    assert.ok(names(audioTracks[1]).length && names(audioTracks[1]).every((n) => /^DIALOGUE BEN T00[5-8]$/.test(n)), `A2 is Ben's: ${names(audioTracks[1])}`);
    // Each file is described in full once, before anything points back at it.
    for (const id of new Set(xml.match(/<file id="([^"]+)"/g))) assert.ok(xml.indexOf(id) === xml.indexOf(`${id}>`));
    assert.match(xml, /2026-10-01_Keys_p1\/Raw\/A001\/CLIP_T00\d\.MOV/);
    assert.equal(tcFrames("10:00:00:00"), 864000);
  });

  test("an establishing shot in front: the scene starts right on its first line", () => {
    const tight = assemble({ title: "Keys", client: "ANA", script: SCRIPT, takes: TAKES });
    const loose = assembleTight();
    const first = (c: typeof tight) => c.takes.find((t) => t.take === c.blocks[0].take)!.matches[0] as { start: number };
    assert.ok(Math.abs(loose.blocks[0].audio.in - (first(loose).start - 0.5)) < 0.01);
    assert.ok(tight.blocks[0].audio.in <= loose.blocks[0].audio.in);
  });

  test("push-ins go on the shots where the tense lines are said, never on neighbouring shots", () => {
    const peaks = [cut.units.length - 2, cut.units.length - 1, 1];
    const pushes = pushIns(cut, peaks);
    assert.ok(pushes.length >= 1 && pushes.length <= 3);
    for (const p of pushes) {
      const piece = cut.video[p.piece];
      assert.equal(piece.kind, "shot");
      assert.ok(piece.recOut - piece.recIn >= 2.5);
      assert.ok(p.scale >= 1.05 && p.scale <= 1.12);
    }
    for (let i = 1; i < pushes.length; i++) assert.ok(pushes[i].piece - pushes[i - 1].piece > 1);
  });

  test("with an establishing shot and push-ins, the timeline opens on it, fades in and out, and zooms", () => {
    const media = new Map(TAKES.map((t) => [t.take, { width: 1920, height: 1080, audioChannels: 2, preview: "" }]));
    const intro = { file: "/tmp/establishing.mp4", seconds: 5, hasAudio: true };
    const pushes = pushIns(cut, [cut.units.length - 2]);
    const layers = { start: 0, musicLength: cut.seconds + 5, points: [[0, 0]] as [number, number][], musicGainDb: -6, ambienceGainDb: -20, introGainDb: -8, ambience: true, music: true };
    const xml = timelineXml({ cut, title: "Keys", prefix: "2026-10-01_Keys_p1", media, layers, seconds: cut.seconds + 5, place: "kitchen", lutNote: "No LUT.", intro, pushIns: pushes });
    const v1 = xml.slice(xml.indexOf("<video>"), xml.indexOf("</track>", xml.indexOf("<video>")));
    assert.match(v1, /^<video><format>.*?<track><transitionitem>.*?<alignment>start-black<\/alignment>/);
    assert.match(v1, /<clipitem id="[^"]+"><name>ESTABLISHING \(AI\)<\/name>.*?<start>0<\/start><end>120<\/end>/);
    assert.match(v1, /<alignment>end-black<\/alignment><effect>.*?<\/transitionitem>$/);
    if (pushes.length) assert.match(v1, /<effectid>basic<\/effectid>.*?<parameterid>scale<\/parameterid>/);
    assert.equal(xml.match(/<track[ >]/g)?.length, 3 + 12, "the street sound gets its own pair of tracks");
    assert.match(xml, /EXTERIOR SOUND \(AI\)/);
    // Everything from the scene starts after the establishing shot.
    const firstShot = /<clipitem id="clipitem-2"><name>[^<]+<\/name><enabled>TRUE<\/enabled><duration>\d+<\/duration><rate>.*?<\/rate><start>(\d+)<\/start>/.exec(xml);
    assert.equal(firstShot?.[1], "120");
  });

  test("a comedy's biggest laugh gets a quick zoom; the other peaks keep their slow push-ins", () => {
    const laugh = cut.units.length - 1;
    const pushes = pushIns(cut, [laugh, 1], laugh);
    const snap = pushes.find((p) => p.snap !== undefined);
    assert.ok(snap, "the laugh's shot zooms");
    assert.equal(snap.scale, SNAP_SCALE);
    const piece = cut.video[snap.piece];
    assert.ok(snap.snap! >= 0.25 && snap.snap! <= piece.recOut - piece.recIn - 1, "seen to start, and held a second after");
    assert.ok(pushes.filter((p) => p.snap === undefined).every((p) => p.scale < SNAP_SCALE), "the rest are slow");
    assert.deepEqual(zoomFor(snap, 4), { kind: "snap", to: SNAP_SCALE, at: snap.snap });
    assert.equal(pushIns(cut, [laugh]).some((p) => p.snap !== undefined), false, "no laugh, no quick zoom");
  });

  test("a handheld comedy: every shot gets its own keyframed move in Premiere, the quick zoom included", () => {
    const media = new Map(TAKES.map((t) => [t.take, { width: 1920, height: 1080, audioChannels: 2, preview: "" }]));
    const layers = { start: 0, musicLength: cut.seconds, points: [[0, 0]] as [number, number][], musicGainDb: -6, ambienceGainDb: -20, introGainDb: -8, ambience: true, music: true };
    const pushes = pushIns(cut, [], cut.units.length - 1);
    const xml = timelineXml({ cut, title: "Keys", prefix: "2026-10-01_Keys_p1", media, layers, seconds: cut.seconds, place: "kitchen", lutNote: "No LUT.", pushIns: pushes, handheld: true });
    const v1 = xml.slice(xml.indexOf("<video>"), xml.indexOf("</track>", xml.indexOf("<video>")));
    assert.equal(v1.match(/<effectid>basic<\/effectid>/g)?.length, cut.video.length, "every shot moves");
    assert.ok((v1.match(/<parameterid>center<\/parameterid>/g)?.length ?? 0) === cut.video.length);
    assert.match(v1, /<keyframe><when>\d+<\/when><value><horiz>-?[\d.]+<\/horiz><vert>-?[\d.]+<\/vert><\/value><\/keyframe>/);
    assert.match(xml, /A handheld camera on every shot/);
    assert.match(xml, /A quick zoom on the biggest laugh/);
    // Steady scenes are as before: no keyframes on shots without a push-in.
    const steady = timelineXml({ cut, title: "Keys", prefix: "2026-10-01_Keys_p1", media, layers, seconds: cut.seconds, place: "kitchen", lutNote: "No LUT." });
    assert.equal(steady.match(/<effectid>basic<\/effectid>/g), null);
  });

  test("the score comes in slowly, eases down under the dialogue and back up, every move a smooth curve (Guy, Oct 5)", () => {
    const points = duckPoints([[5, 7], [12, 13]], 25, 0);
    const at = (t: number) => points.find(([x]) => Math.abs(x - t) < 0.001)?.[1];
    assert.deepEqual(points[0], [0, -40], "from silence");
    assert.equal(at(SCORE_IN), 0, "fully in after its first seconds");
    assert.equal(at(4), 0, "starts down a second before the line");
    assert.equal(at(4.9), -9, "down as the line starts");
    assert.equal(at(7.4), -9, "and through it");
    assert.equal(at(9.2), 0, "back up about two seconds after");
    assert.deepEqual(points.at(-1), [25, 0]);
    const down = points.filter(([t]) => t >= 4 && t <= 4.9);
    assert.ok(down.length >= 7, "the dip is drawn as a curve, not a step");
    for (let k = 1; k < down.length; k++) assert.ok(down[k][1] <= down[k - 1][1] && down[k - 1][1] - down[k][1] <= 2.5, "no sudden drop");
    assert.ok(Math.abs(down[3][1] + 4.5) < 0.01, "an S-curve: halfway down at its middle");
    // Lines a breath apart keep it down between them; a real pause lets it up.
    assert.ok(speechOnTimeline(cut, DIP_JOIN).length < speechOnTimeline(cut).length);
  });
  test("never the slate: no shot, reaction or alternate starts before its take is clean (Guy, Oct 5)", () => {
    const T = new Map(cut.takes.map((t) => [t.take, t]));
    for (const t of cut.takes) assert.ok(t.cleanFrom > 4 && t.cleanFrom < (t.sceneStart ?? 0), `${t.take}: clean after "Action", before the first line`);
    for (const p of cut.video) {
      assert.ok(p.in >= T.get(p.take)!.cleanFrom - 0.001, `${p.take} at ${p.in}`);
      for (const alt of p.alternates) assert.ok(alt.in >= T.get(alt.take)!.cleanFrom - 0.001, `alternate ${alt.take}`);
    }
  });

  test("every line is heard from a take its speaker is on camera in, with the boom on them (Guy, Oct 5)", () => {
    const T = new Map(cut.takes.map((t) => [t.take, t]));
    for (const edit of cut.audio) {
      const take = T.get(edit.take)!;
      take.matches.forEach((m, j) => {
        if ("start" in m && m.start < edit.out - 0.05 && m.end > edit.in + 0.05) assert.equal(cut.units[j].who, take.setup!.who, `"${cut.units[j].text}" from ${edit.take}`);
      });
    }
  });
});

// A long speech of Ana's, a quick "What?" from Ben in the middle of it, and a take where Ana stops and starts over.
const SPEECH: ScriptLine[] = [
  { kind: "speech", who: "ANA", text: "I went back to the house this morning. The door was open and the lights were on." },
  { kind: "speech", who: "BEN", text: "What?" },
  { kind: "speech", who: "ANA", text: "Somebody had been inside. Every drawer was open and the photographs were gone." },
  { kind: "speech", who: "BEN", text: "Then we call the police and we tell them everything." },
  { kind: "speech", who: "ANA", text: "No police. Not yet. Not until we know who it was." },
];

function speechTake(n: number, setup: Setup, pace: number, restart = false, hold = 1): TakeInput {
  const words: Word[] = [];
  let t = 3;
  const say = (text: string) => {
    for (const w of text.split(" ")) {
      words.push({ w, s: t, e: t + 0.3 * pace, p: 0.95 });
      t += 0.36 * pace;
    }
  };
  say(`Scene four, take ${n}. Mark. Action.`);
  t += 1.5;
  SPEECH.forEach((line, i) => {
    if (line.kind !== "speech") return;
    t += i === 1 || i === 2 ? 0.25 : 0.7;
    say(line.text);
    if (restart && i === 2) {
      t += 1.0;
      say("Sorry. Line? Can we pick it up from then we call the police. Okay. Still rolling. And action.");
      t += 1.2;
    }
  });
  t += hold;
  say("Cut. Great.");
  return { take: `T0${10 + n}`, path: `Raw/A002/CLIP_T0${10 + n}.MOV`, length: t + 2, timecode: "11:00:00:00", setup, words };
}

describe("serving the story (Guy, Oct 5)", () => {
  const takes = [
    speechTake(1, { who: "ANA", framing: "medium" }, 1.0),
    speechTake(2, { who: "ANA", framing: "medium" }, 1.03, true),
    speechTake(3, { who: "BEN", framing: "medium" }, 0.98),
    speechTake(4, { who: "BEN", framing: "medium" }, 1.0),
  ];
  const units = buildUnits(SPEECH);
  const aligned = alignTakes(units, takes);
  const cut = assembleAligned("Break-in", "BEN", ["ANA", "BEN"], units, aligned);
  const who = (take: string) => takes.find((t) => t.take === take)!.setup!.who;
  const lineAt = (c: Cut, j: number) => {
    const b = c.blocks.find((x) => x.first <= j && j <= x.last)!;
    const m = c.takes.find((t) => t.take === b.take)!.matches[j] as { start: number; end: number };
    return [b.audio.recIn + m.start - b.audio.in, b.audio.recIn + m.end - b.audio.in];
  };
  const what = units.findIndex((u) => u.text === "What?");

  test("a quick interjection stays on whoever is talking, heard from its speaker's own take", () => {
    const [s, e] = lineAt(cut, what);
    const onScreen = cut.video.filter((p) => p.recIn < e && p.recOut > s);
    assert.deepEqual([...new Set(onScreen.map((p) => who(p.take)))], ["ANA"], "no flash of Ben");
    const heard = cut.audio.filter((a) => a.recIn < e && a.recOut > s);
    assert.ok(heard.some((a) => who(a.take) === "BEN" && a.recIn <= s + 0.01 && a.recOut >= e - 0.15), "Ben's own take carries his line");
    assert.ok(heard.every((a) => who(a.take) === "BEN" || a.recOut <= s + 0.01 || a.recIn >= e - 0.15), "Ana's take never plays his line");
    for (let i = 1; i < cut.audio.length; i++) assert.ok(Math.abs(cut.audio[i].recIn - cut.audio[i - 1].recOut) < 0.002, "the sound runs on without a gap");
  });

  test("the edit serves the story, not the client: Ben is the client, and Ana's lines are still on Ana", () => {
    for (const b of cut.blocks) {
      const speakers = new Set(units.slice(b.first, b.last + 1).filter((_, k) => !b.patches.length || units[b.first + k].text !== "What?").map((u) => u.who));
      assert.deepEqual([...speakers], [b.onCamera]);
    }
  });

  test("never through a stop and restart: no shot or sound runs across the flubbed line", () => {
    const restart = takes[1];
    const said = restart.words.findIndex((w) => w.w === "Sorry.");
    const [s, e] = [restart.words[said].s, restart.words.findLast((w) => w.w === "action.")!.e];
    for (const piece of [...cut.audio, ...cut.video].filter((p) => p.take === restart.take)) assert.ok(piece.out <= s || piece.in >= e, `${piece.in}-${piece.out}`);
  });

  test("where the scene peaks, the other actor takes it in: a reaction if the speaker goes on, an early cut if they answer", () => {
    const peak = units.findIndex((u) => u.text.startsWith("Every drawer"));
    const read = assembleAligned("Break-in", "BEN", ["ANA", "BEN"], units, aligned, { beats: [peak] });
    const [, said] = lineAt(read, peak);
    const next = read.video.find((p) => p.recIn >= said - 0.25 && p.recIn <= said + 0.3);
    assert.ok(next && who(next.take) === "BEN", "Ben is on screen right after the line");
    const answer = units.findIndex((u) => u.text.startsWith("Then we call"));
    const [heard] = lineAt(read, answer);
    assert.ok(next.recIn < heard - 0.3, "before he answers");
    const block = read.blocks.find((b) => b.last === peak)!;
    assert.equal(block.cutAfter?.kind, "L");
  });

  test("a reaction never leaves a flash of the shot it cuts into, even at the very end (shoot 1039)", () => {
    // Every take held a few seconds before "Cut", so the scene runs on 2.2 s after its last line.
    const held = alignTakes(units, [
      speechTake(1, { who: "ANA", framing: "medium" }, 1.0, false, 4),
      speechTake(2, { who: "ANA", framing: "medium" }, 1.03, false, 4),
      speechTake(3, { who: "BEN", framing: "medium" }, 0.98, false, 4),
      speechTake(4, { who: "BEN", framing: "medium" }, 1.0, false, 4),
    ]);
    const last = units.length - 1;
    const read = assembleAligned("Break-in", "BEN", ["ANA", "BEN"], units, held, { beats: [last] });
    const end = read.video.at(-1)!;
    assert.equal(end.kind, "reaction", "the scene ends on the other actor taking in the last line");
    assert.equal(who(end.take), "BEN");
    for (const p of read.video) assert.ok(p.recOut - p.recIn >= 0.6, `${p.take} ${p.recIn}-${p.recOut}`);
  });

  test("the first line is heard under the end of the establishing shot, then the picture cuts in", () => {
    const tight = assembleAligned("Break-in", "BEN", ["ANA", "BEN"], units, aligned, { tightHead: true });
    const { cut: opened, intro } = overlapIntro(tight, { file: "/tmp/establishing.mp4", seconds: 5, hasAudio: true });
    assert.ok(intro?.overlap && intro.overlap >= 0.8 && intro.overlap <= 2.5, `overlap ${intro?.overlap}`);
    const [said] = lineAt(opened, 0);
    assert.ok(said < intro.overlap - 0.3, "the line starts while the exterior is on screen");
    assert.equal(opened.video[0].recIn, Math.round(intro.overlap * 1000) / 1000);
    assert.equal(opened.audio[0].recIn, 0);
    assert.equal(sceneFrame(intro) + Math.round(intro.overlap * (24000 / 1001)), 120, "the scene's sound starts under the shot; its picture right after it");
    const media = new Map(takes.map((t) => [t.take, { width: 1920, height: 1080, audioChannels: 2, preview: "" }]));
    const layers = { start: 0, musicLength: 30, points: [[0, 0]] as [number, number][], musicGainDb: -6, ambienceGainDb: -20, introGainDb: -8, ambience: true, music: true };
    const xml = timelineXml({ cut: opened, title: "Break-in", prefix: "2026-10-05_Break-in_p1", media, layers, seconds: 30, place: "hallway", lutNote: "No LUT.", intro });
    const starts = (name: RegExp) => [...xml.matchAll(new RegExp(`<name>${name.source}</name>.*?<start>(\\d+)</start>`, "g"))].map((m) => Number(m[1]));
    assert.equal(Math.min(...starts(/CLIP_T01\d\.MOV/)), 120, "the first shot comes in as the establishing shot ends");
    assert.equal(Math.min(...starts(/DIALOGUE \w+ T01\d/)), sceneFrame(intro), "its sound before");
    assert.match(xml, /EXTERIOR SOUND \(AI\)/);
    // A scene that opens on someone coming in cuts in straight, to show it.
    const entrance = buildUnits([{ kind: "action", text: "BEN bursts in, out of breath." }, ...SPEECH]);
    const walkIn = assembleAligned("Break-in", "BEN", ["ANA", "BEN"], entrance, alignTakes(entrance, takes), { tightHead: true });
    assert.equal(overlapIntro(walkIn, { file: "/tmp/establishing.mp4", seconds: 5, hasAudio: true }).intro?.overlap, 0);
  });
});

describe("working the scene out from the takes", () => {
  test("the lines most takes share are the scene, slates and chatter aside", () => {
    const takes = TAKES.slice(0, 5).map((t) => t.words);
    const { sentences: found } = consensusSentences(takes);
    const text = found.map((s) => s.text).join(" ");
    assert.match(text, /^You came back\./);
    assert.match(text, /Now get your keys\.$/);
    assert.doesNotMatch(text, /action|scene one/i);
  });

  // Words as Whisper gives them, half a second apart.
  const said = (text: string, at = 0) => text.split(" ").map((w, i) => ({ w, s: at + i * 0.5, e: at + i * 0.5 + 0.4, p: 0.9 }));
  const startsWith = (text: string) => {
    const words = said(text);
    return words.slice(sceneStart(words)).map((w) => w.w).join(" ");
  };

  test("a take's scene starts after the director's Action, or after its slate (shoots 1030 and 1013, Oct 5)", () => {
    assert.equal(startsWith("Alright, camera rolls. This is one four. Stand by. Camera set. Action. Why are we here? You know why."), "Why are we here? You know why.");
    assert.equal(startsWith("Rolling. One, two. Thank you. Set. Action. Why are we here? You know why."), "Why are we here? You know why.");
    assert.equal(startsWith("Do whatever it is. First blood shot. Two, take one. He had a dove. Why bring a dove?"), "He had a dove. Why bring a dove?", "no Action: after the slate");
    assert.equal(startsWith("This is Keys, shot one, take one. Thank you. He had a dove. Why bring a dove? To a party?"), "He had a dove. Why bring a dove? To a party?");
    assert.equal(startsWith("Why are we here? You know why. I want some action. Now."), "Why are we here? You know why. I want some action. Now.", "a line with action in it is a line");
    assert.equal(startsWith("Okay. Why are we here? You know why. Because you asked."), "Why are we here? You know why. Because you asked.");
    // A director who says "go ahead" instead (shoot 1007, Oct 5), and a line that says it.
    assert.equal(
      startsWith("Camera roll in. Subtle. Shot one, take two. On camera set. Okay, take a breath. And when you're ready, go ahead. I need help understanding something before I sign it."),
      "I need help understanding something before I sign it.",
    );
    assert.equal(
      startsWith("I need help understanding something before I sign my name to it. Whenever you're ready, go ahead. Then don't sign it."),
      "I need help understanding something before I sign my name to it. Whenever you're ready, go ahead. Then don't sign it.",
      "once the scene is under way, it's a line",
    );
    assert.equal(crewSentence("This is filtering, one take two."), true);
    assert.equal(crewSentence("Camera set."), true);
    assert.equal(crewSentence("Take your coat."), false);
  });

  test("slates said on every take aren't lines, and a reworded first line starts where its sentence does", () => {
    const slate = (n: number) => `This is Keys, one take ${["one", "two", "three", "four"][n]}. Stand by. Camera set. Action.`;
    // Half the takes open with a line added on set, worded differently each time.
    const openers = ["", "", "So did you know about the wrong keys?", "So you knew you had the wrong keys?"];
    const takes = openers.map((opener, n) => said(`${slate(n)} ${opener} You came back. I forgot my keys. Then take them.`.replace(/\s+/g, " ")));
    const text = consensusSentences(takes).sentences.map((x) => x.text).join(" ");
    assert.doesNotMatch(text, /this is keys|camera set|stand by|action/i);
    assert.match(text, /You came back\. I forgot my keys\. Then take them\.$/);
    assert.doesNotMatch(text, /^(the wrong keys|wrong keys|keys\?)/i, "never half a sentence first");
  });

  test("speeches from sentences and who says them", () => {
    const lines = scriptFrom(
      [
        { text: "Hi.", words: [] },
        { text: "How are you?", words: [] },
        { text: "Fine.", words: [] },
      ],
      [1, 1, -1],
      -1,
    );
    assert.deepEqual(lines, [
      { kind: "speech", who: "PARTNER", text: "Hi. How are you?" },
      { kind: "speech", who: "CLIENT", text: "Fine." },
    ]);
  });

  test("who says a line no level can decide: the one who was speaking, unless it's a reply (shoots 1053, 1013, 1039)", () => {
    const all = (d: number[]) => d.map(() => true);
    // 1053: A's rant, then a line with no clear evidence said without a breath (0.12 s), then another unclear one
    // after a pause, then B ("Matthew."): the rant carries on.
    const rant = [11, 8, 12, 0.1, 3.4, -14, -8, -10, 12, -10, 14, -7];
    assert.deepEqual(whoSays(rant, all(rant), [null, 0.08, 0.7, 0.12, 0.43, 0.6, 0.2, 0.36, 0.3, 0.3, 0.3, 0.3]), [1, 1, 1, 1, 1, -1, -1, -1, 1, -1, 1, -1]);
    // 1013: between two of B's lines, a quick line leaning A is a reply ("It's over." "Nothing is over.").
    const reply = [11, -10, -9, 1.6, -10, 11, -8, 12, -10];
    assert.deepEqual(whoSays(reply, all(reply), [null, 0.4, 0.2, 0.13, 0.4, 0.3, 0.5, 0.3, 0.3]), [1, -1, -1, 1, -1, 1, -1, 1, -1]);
    // 1039: B's recording plays, then "Turn that off." leaning A, 0.29 s later: a new speaker, so the levels decide.
    const cut = [10, -10, 10, -10, -2.5, 0.5, 2, -10, 10, -8];
    assert.deepEqual(whoSays(cut, all(cut), [null, 0.4, 0.4, 0.4, 0, 0.29, 0.68, 0.28, 0.3, 0.3]), [1, -1, 1, -1, -1, 1, 1, -1, 1, -1]);
    assert.deepEqual(whoSays([null, 5], [false, false], [null, 0.1]), [null, null], "no evidence, no answer");
  });

  test("two groups split where the gap is", () => {
    const split = twoGroups([-11, -9, -10, 0.5, 1, -1, 2, 0]);
    assert.ok(split && split.threshold < -1 && split.threshold > -9);
  });
});

describe("coverage", () => {
  test("a run of takes splits once, where the picture changes", () => {
    // Three alike, then four alike.
    const look = [0, 1, 0.5, 30, 31, 29, 30];
    const d = look.map((a) => look.map((b) => Math.abs(a - b) * 2));
    assert.deepEqual(setupSplits(d), [3]);
    assert.deepEqual(setupSplits([[0, 5], [5, 0]]), []);
  });

  test("each actor's first setup is medium, then close; takes nobody's on don't break a run", () => {
    const sig = (v: number) => new Float32Array(48 * 27).fill(v);
    const framings = framingsFor([
      { who: "A", signature: sig(10) },
      { who: "A", signature: sig(12) },
      { who: null, signature: null },
      { who: "A", signature: sig(60) },
      { who: "B", signature: sig(100) },
      { who: "B", signature: sig(140) },
    ]);
    assert.deepEqual(framings, ["medium", "medium", null, "close", "medium", "close"]);
  });

  test("a take with weak evidence follows its neighbours", () => {
    assert.deepEqual(onCameraSides([10, 0.1, 12, -9, null, -11]), [1, 1, 1, -1, null, -1]);
  });

  test("the vision model's answer is read, and refused if it can't be right", () => {
    const labels = ["T001", "T002", "T003"];
    const seen = parseCoverage('Sure! {"T001": {"who": "A", "framing": "medium"}, "T002": {"who": "b", "framing": "Close"}, "T003": {"who": "insert"}}', labels);
    assert.deepEqual(seen, {
      T001: { who: "A", framing: "medium" },
      T002: { who: "B", framing: "close" },
      T003: { who: "insert", framing: null },
    });
    assert.equal(parseCoverage('{"T001": {"who": "A"}, "T002": {"who": "A"}, "T003": {"who": "A"}}', labels), null);
    assert.equal(parseCoverage("no idea", labels), null);
  });
});

describe("odds and ends", () => {
  test("a word Whisper starts over the silence before it starts where it's heard (shoot 1030, Oct 5)", () => {
    // 20 s of quiet room at 16 kHz, a knock at 15.1 s, and a voice from 17.7 s.
    const rate = 16000;
    const audio = new Float32Array(20 * rate).map((_, i) => 0.0006 * Math.sin(i * 0.37) * Math.sin(i * 0.011));
    const sound = (from: number, to: number, size: number) => {
      for (let i = Math.floor(from * rate); i < to * rate; i++) audio[i] += size * Math.sin(i * 0.13);
    };
    sound(15.1, 15.3, 0.004);
    sound(17.7, 19.9, 0.03);
    const words = [
      { w: "Stand", s: 3.0, e: 3.3 },
      { w: "This", s: 15.14, e: 17.8 },
      { w: "isn't", s: 17.8, e: 18.18 },
      { w: "really", s: 18.18, e: 19.0 },
    ];
    const out = voicedWords(words, audio, rate);
    assert.ok(Math.abs(out[1].s - 17.67) < 0.08, `"This" now starts at ${out[1].s}`);
    assert.equal(out[1].e, 17.8);
    assert.deepEqual(out[0], words[0], "a short word stays");
    assert.deepEqual(out[3], words[3], "a long word in the middle of a phrase stays");
  });

  test("take labels", () => {
    assert.deepEqual(takeLabels(["Raw/A/SHGN1_S001_S001_T003.MOV", "Raw/B/C0042.MP4", "Raw/C/C0042.MP4"]), ["T003", "C0042", "C0042-2"]);
  });

  test("fal's Whisper words", () => {
    assert.deepEqual(
      wordsFrom([
        { timestamp: [1, 1.4], text: " Hello," },
        { timestamp: [1.5, null], text: " there" },
        { timestamp: [2, 2.2], text: " " },
      ]),
      [
        { w: "Hello,", s: 1, e: 1.4, p: 0.9 },
        { w: "there", s: 1.5, e: 1.8, p: 0.9 },
      ],
    );
  });

  test("the scene brief is read, or refused", () => {
    assert.deepEqual(parseBrief('{"place": "diner", "ambience": "Cutlery and murmur. No voices, no music.", "score": "Soft piano. No vocals."}'), {
      place: "diner",
      ambience: "Cutlery and murmur. No voices, no music.",
      score: "Soft piano. No vocals.",
      exterior: null,
      peaks: [],
      laugh: null,
      tone: "drama",
    });
    const full = parseBrief(
      '{"place": "diner", "ambience": "Murmur. No voices, no music.", "score": "Piano. No vocals.", "exterior": {"image": "A small-town diner at dusk, neon sign unlit", "motion": "Slow push in toward the door."}, "tone": "Comedy", "peaks": [7, 2, 7, 40, 3, 5], "laugh": 9}',
      10,
    );
    assert.deepEqual(full?.exterior, { image: "A small-town diner at dusk, neon sign unlit", motion: "Slow push in toward the door." });
    assert.deepEqual(full?.peaks, [6, 1, 2], "1-based to 0-based, in range, no repeats, three at most");
    assert.equal(full?.tone, "comedy");
    assert.equal(full?.laugh, 8);
    assert.equal(parseBrief('{"place": "diner", "ambience": "Murmur. No voices.", "score": "Piano. No vocals.", "tone": "musical", "laugh": 40}', 10)?.tone, "drama", "an unknown tone reads as drama");
    assert.equal(parseBrief('{"place": "diner", "ambience": "Murmur. No voices.", "score": "Piano. No vocals.", "laugh": 40}', 10)?.laugh, null, "a laugh past the last line is ignored");
    assert.equal(parseBrief('{"place": "diner"}'), null);
  });
});

test("the preview plays on phones: its frame rate and H.264 level are set, never left to FFmpeg's guess", () => {
  // Left to guess, Railway's FFmpeg labelled a preview level 6.2, and iPhones refused it (Oct 2).
  const after = (flag: string) => PREVIEW_VIDEO[PREVIEW_VIDEO.indexOf(flag) + 1];
  assert.equal(after("-c:v"), "libx264");
  assert.equal(after("-r"), "24000/1001");
  assert.equal(after("-profile:v"), "high");
  assert.ok(Number(after("-level:v")) <= 4.2, "a level every iPhone plays");
  assert.equal(after("-pix_fmt"), "yuv420p");
});

describe("the handheld camera (comedies)", () => {
  test("comedies and dramedies are shot handheld; dramas and thrillers stay steady", () => {
    assert.deepEqual((["comedy", "dramedy", "drama", "thriller"] as const).map(cameraFor), ["handheld", "handheld", "steady", "steady"]);
  });

  test("the move stays small enough that the zoom hides every edge, and each shot moves its own way", () => {
    const margin = (1 - 1 / HANDHELD_ZOOM) / 2; // how far the frame can drift before an edge would show
    for (const seed of [1, 7919, 15838, 99991]) {
      const shake = shakeFor(seed);
      for (let f = 0; f < 24 * 60; f++) {
        const c = cameraAt(shake, { kind: "none" }, f / 24);
        const turn = (Math.abs(c.roll) * Math.PI) / 180;
        // The roll swings the frame's corners: worst at the far edge (16:9).
        assert.ok(Math.abs(c.x) + turn * (9 / 16) * 0.5 < margin, `sideways at frame ${f}`);
        assert.ok(Math.abs(c.y) + turn * (16 / 9) * 0.5 < margin, `up-down at frame ${f}`);
      }
    }
    assert.deepEqual(shakeFor(5), shakeFor(5), "the same scene moves the same way every time");
    assert.notDeepEqual(shakeFor(5), shakeFor(6));
  });

  test("zooms: slow over the shot, or quick and settled", () => {
    assert.equal(zoomAt({ kind: "slow", to: 1.1, seconds: 4 }, 2), 1.05);
    assert.equal(zoomAt({ kind: "slow", to: 1.1, seconds: 4 }, 9), 1.1);
    const snap = { kind: "snap", to: SNAP_SCALE, at: 1 } as const;
    assert.equal(zoomAt(snap, 0.9), 1);
    assert.ok(Math.abs(zoomAt(snap, 1 + SNAP_FRAMES / 23.976) - SNAP_SCALE) < 1e-9);
    assert.ok(zoomAt(snap, 1 + 2 / 23.976) > 1 + (SNAP_SCALE - 1) / 2, "most of the way there in two frames");
  });

  test("Premiere keyframes every few frames, plus every frame of the quick zoom", () => {
    const keys = handheldKeys(shakeFor(3), { kind: "snap", to: SNAP_SCALE, at: 1 }, 96);
    assert.equal(keys[0].frame, 0);
    assert.equal(keys.at(-1)!.frame, 95);
    const snapStart = Math.round(23.976);
    for (let f = snapStart; f <= snapStart + SNAP_FRAMES; f++) assert.ok(keys.some((k) => k.frame === f), `frame ${f}`);
    assert.equal(keys[0].scale, Math.round(HANDHELD_ZOOM * 1000) / 10);
    assert.ok(Math.abs(keys.at(-1)!.scale - HANDHELD_ZOOM * SNAP_SCALE * 100) < 0.1);
  });

  test("the preview's move is one perspective filter, worked out every frame", () => {
    const vf = handheldFilter(shakeFor(3), { kind: "slow", to: 1.08, seconds: 5 }, 1280, 720);
    assert.match(vf, /^perspective=x0='[^']+':y0='[^']+':x1='[^']+':y1='[^']+':x2='[^']+':y2='[^']+':x3='[^']+':y3='[^']+':interpolation=cubic:eval=frame$/);
    assert.ok(!/[;[\]]/.test(vf), "nothing in it can break the filter graph");
  });
});
