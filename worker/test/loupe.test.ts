// Loupe's notes (Guy, Oct 6): what a note can change in the cut, and how
// Claude's reading of a note is kept to what exists. Every name is made up.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FalClient } from "../src/ai/fal.js";
import { parseDirection, pendingNote, steerOf } from "../src/assembly/direction.js";
import { alignTakes, assembleAligned, sameLine, type Setup, type TakeInput } from "../src/assembly/engine.js";
import { applyReading, BRAIN_ENDPOINT, BRAIN_MODEL, brainPrompt, readNote, type CutContext } from "../src/assembly/loupe.js";
import { buildUnits, type ScriptLine, type Word } from "../src/assembly/text.js";

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
      t += 0.9 * pace;
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
const units = buildUnits(SCRIPT);
const cutWith = (steer = {}) => assembleAligned("Keys", "ANA", ["ANA", "BEN"], units, alignTakes(units, TAKES), { steer });
const takeFor = (cut: ReturnType<typeof cutWith>, text: string) => {
  const i = cut.units.findIndex((u) => sameLine(u.text, text));
  return cut.blocks.find((b) => b.first <= i && i <= b.last)!.take;
};

describe("a note steering the cut", () => {
  const plain = cutWith();
  const line = "Say it properly this time."; // a line is one sentence of a speech

  test("a take picked for a line plays it", () => {
    const now = takeFor(plain, line);
    const other = ["T001", "T002", "T003", "T004"].find((t) => t !== now)!;
    const picked = cutWith({ picks: [{ line: "say it properly, this time", take: other }] });
    assert.equal(takeFor(picked, line), other);
    assert.deepEqual(picked.jumps, [], "still no jump cuts");
  });

  test("a pick for a line or take that isn't there changes nothing", () => {
    const odd = cutWith({ picks: [{ line: "A line nobody wrote.", take: "T001" }, { line, take: "T099" }] });
    assert.deepEqual(odd.blocks.map((b) => b.take), plain.blocks.map((b) => b.take));
  });

  test("tighter cuts make a shorter scene, looser a longer one", () => {
    assert.ok(cutWith({ pace: "tighter" }).seconds < plain.seconds);
    assert.ok(cutWith({ pace: "looser" }).seconds > plain.seconds);
  });

  test("fewer reactions never means more", () => {
    const count = (c: ReturnType<typeof cutWith>) => c.video.filter((p) => p.kind === "reaction").length;
    assert.ok(count(cutWith({ reactions: "fewer" })) <= count(plain));
    assert.ok(count(cutWith({ reactions: "more" })) >= count(plain));
  });

  test("how a performance plays leans the choice, and says why", () => {
    const now = takeFor(plain, line);
    // The other take of the same setup (the line follows a move, so it wants the medium shot).
    const other = { T001: "T002", T002: "T001", T003: "T004", T004: "T003" }[now]!;
    const leaned = cutWith({ performance: { [other]: { bonus: 0.15, note: "she cracks on the last line" }, [now]: { bonus: -0.15, note: "flat" } } });
    assert.equal(takeFor(leaned, line), other);
    assert.ok(leaned.scores[other].why.includes("she cracks on the last line"));
  });
});

describe("the direction kept with each assembly", () => {
  test("anything unexpected is left out", () => {
    const d = parseDirection({ look: "  warmer ", reactions: "lots", pace: "tighter", picks: [{ line: "x" }, { line: "Hi", take: "T001" }], notes: [{ note: "warmer", reply: null, at: "now" }, { note: "" }], hacked: true });
    assert.deepEqual(d, { look: "warmer", music: null, reactions: null, pace: "tighter", clean: null, picks: [{ line: "Hi", take: "T001" }], notes: [{ note: "warmer", reply: null, at: "now" }] });
    assert.equal(pendingNote(d)?.note, "warmer");
    assert.equal(pendingNote({ notes: [{ note: "a", reply: "Done.", at: "" }] }), null);
    assert.deepEqual(parseDirection(null), { look: null, music: null, reactions: null, pace: null, clean: null });
    assert.deepEqual(steerOf(d), { picks: [{ line: "Hi", take: "T001" }], reactions: undefined, pace: "tighter", performance: undefined });
  });
});

describe("Claude reading a note", () => {
  const cut: CutContext = {
    title: "Keys",
    tone: "drama",
    place: "kitchen",
    seconds: 40,
    client: "ANA",
    partner: "BEN",
    shots: [{ take: "T004", who: "ANA", framing: "close", kind: "shot", line: "You came back.", speaker: "ANA", why: "the director's pick" }],
    takes: [
      { take: "T003", setup: { who: "ANA", framing: "close" }, used: false },
      { take: "T004", setup: { who: "ANA", framing: "close" }, used: true },
      { take: "T009", setup: null, used: false },
    ],
    performances: { T003: "rawer; her voice breaks on the last line" },
    lines: [
      { who: "ANA", text: "You came back. I didn't think you would." },
      { who: "BEN", text: "I forgot my keys." },
    ],
  };

  test("the prompt has the scene, the takes, what's set and the note", () => {
    const p = brainPrompt("find the take where she cracks", cut, { look: "warm" });
    for (const said of ["find the take where she cracks", "1. ANA: You came back.", "T003: ANA, close. Performance: rawer", "T009: not usable", '"look":"warm"', "never \"AI\""])
      assert.ok(p.includes(said), said);
  });

  test("extras are off until a note asks; a note on the music asks for a score (Loupe, Oct 7)", () => {
    assert.equal(parseDirection({}).extras, undefined);
    assert.deepEqual(parseDirection({ extras: { establishing: true, ambience: "yes", score: false, drone: true } }).extras, { establishing: true });
    const on = applyReading(JSON.stringify({ set: { extras: { establishing: true, ambience: true } }, remake: true, reply: "Opened on the outside. Your call." }), cut, {})!;
    assert.deepEqual(on.direction.extras, { establishing: true, ambience: true });
    assert.equal(on.remake, true);
    const score = applyReading(JSON.stringify({ set: { music: "sadder, no piano" }, remake: true, reply: "A sadder score." }), cut, on.direction)!;
    assert.deepEqual(score.direction.extras, { establishing: true, ambience: true, score: true });
    const off = applyReading(JSON.stringify({ set: { extras: { establishing: false, ambience: false } }, remake: true, reply: "Back to the scene alone." }), cut, { extras: { establishing: true, ambience: true } })!;
    assert.equal(off.direction.extras, undefined);
    assert.equal(off.remake, true);
    assert.ok(brainPrompt("add some music", cut, {}).includes('"extras"'));
  });

  test("only real lines and usable takes are picked; settings only from the list", () => {
    const r = applyReading(
      JSON.stringify({
        set: {
          picks: [
            { line: "you came back. i didn't think you would", take: "T003" },
            { line: "A line that isn't there.", take: "T003" },
            { line: "I forgot my keys.", take: "T009" },
          ],
          reactions: "normal",
          pace: "tighter",
          look: "warmer, deeper shadows",
          volume: 11,
        },
        remake: true,
        reply: "Swapped in take 3, where she cracks. Your call.",
      }),
      cut,
      { reactions: "more" },
    )!;
    assert.deepEqual(r.direction.picks, [{ line: "You came back. I didn't think you would.", take: "T003" }]);
    assert.equal(r.direction.reactions, null);
    assert.equal(r.direction.pace, "tighter");
    assert.equal(r.direction.look, "warmer, deeper shadows");
    assert.equal(r.remake, true);
    assert.ok(!("volume" in r.direction));
  });

  test("a question changes nothing and makes nothing again", () => {
    const r = applyReading('{"set": {}, "remake": true, "reply": "Take 4: the director called it."}', cut, {})!;
    assert.equal(r.remake, false, "nothing changed, so nothing to make");
    assert.equal(r.reply, "Take 4: the director called it.");
    assert.equal(applyReading("not json", cut, {}), null);
    assert.equal(applyReading('{"set": {"look": "x"}}', cut, {}), null, "no answer to show");
  });

  test("unpicking gives a line back", () => {
    const r = applyReading('{"set": {"unpick": ["You came back. I didn\'t think you would."]}, "reply": "Back to my pick."}', cut, {
      picks: [{ line: "You came back. I didn't think you would.", take: "T003" }],
    })!;
    assert.equal(r.direction.picks, undefined);
    assert.equal(r.remake, true);
  });

  test("asks Claude Opus 5.5 on fal, text only", async () => {
    const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
    const fal = {
      run: async (endpoint: string, input: Record<string, unknown>) => {
        calls.push({ endpoint, input });
        return { output: '{"set": {"look": "colder"}, "remake": true, "reply": "Colder. Your call."}' };
      },
    } as unknown as FalClient;
    const r = await readNote(fal, "make it colder", cut, {});
    assert.equal(calls[0].endpoint, BRAIN_ENDPOINT);
    assert.equal(calls[0].input.model, BRAIN_MODEL);
    assert.equal(BRAIN_MODEL, "anthropic/claude-opus-5.5");
    assert.equal(calls[0].input.image_urls, undefined, "no pictures or sound go out");
    assert.equal(r?.direction.look, "colder");
  });
});
