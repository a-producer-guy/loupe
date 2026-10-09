"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CommandBar } from "@/components/room/command-bar";
import { Ingest } from "@/components/room/ingest";
import { Suite, type Scope } from "@/components/room/suite";
import { CUT_STEPS, type CutResult, type CutView, type RoomCut, type Shot } from "@/lib/footage/cut-types";
import type { ClipRow, ShootDetail } from "@/lib/footage/status";
import type { ShootProgress } from "@/lib/upload/manager";
import "@/components/room/room.css";

// The landing page's "how it works", played in the product itself: the real upload screen, the real "Loupe is cutting"
// screen, the real cutting room and the real command bar, fed a scripted stand-in scene (drawn frames in
// public/demo, so no one's footage is used) instead of the server. One clock drives it: the cards go in, the
// proxies make themselves, Loupe cuts the scene, the cut plays, a line's other takes fan out, a note is typed and a
// new version comes back. It pauses off screen; with less motion asked for it opens on the finished cut and waits.

const STILL = (take: string) => `/demo/take-${take}.jpg`;
const GB = 1e9;

// The shoot: two cards, ten takes (a wide, Danny's close-ups, Maya's close-ups).
const CLIPS: { take: string; card: string; gb: number; seconds: number }[] = [
  { take: "1", card: "A001", gb: 2.4, seconds: 52 },
  { take: "2", card: "A001", gb: 2.1, seconds: 46 },
  { take: "3", card: "A001", gb: 1.6, seconds: 35 },
  { take: "4", card: "A001", gb: 1.7, seconds: 38 },
  { take: "5", card: "A001", gb: 1.5, seconds: 33 },
  { take: "6", card: "A001", gb: 1.8, seconds: 40 },
  { take: "7", card: "A002", gb: 1.9, seconds: 41 },
  { take: "8", card: "A002", gb: 1.6, seconds: 36 },
  { take: "9", card: "A002", gb: 2.0, seconds: 44 },
  { take: "10", card: "A002", gb: 1.7, seconds: 37 },
];
const SETUP: Record<string, { who: string; framing: "medium" | "close" } | null> = Object.fromEntries(
  CLIPS.map((c) => [c.take, +c.take <= 2 ? null : { who: +c.take <= 6 ? "DANNY" : "MAYA", framing: "close" as const }]),
);
const pathOf = (c: (typeof CLIPS)[number]) => `${c.card}/A${c.card.slice(1)}_C${c.take.padStart(3, "0")}_0923RT.mov`;

// The clock, in seconds.
const UP = 1.8; // the cards land
const UP_EACH = 1.4;
const UP_GAP = 0.35;
const PROXY = 1.0;
const CUT_AT = 9;
const STEP = 0.85;
const DONE_AT = CUT_AT + CUT_STEPS.length * STEP + 0.2;
const TRAY_AT = DONE_AT + 14.4;
const TRAY_DONE = TRAY_AT + 3.8;
const NOTE_AT = TRAY_DONE + 0.5;
const NOTE = "More tired on this one";
const SEND_AT = NOTE_AT + NOTE.length * 0.05 + 0.5;
const V2_AT = SEND_AT + 3.4;
const LOOP = V2_AT + 6.5;

const CHAPTERS = [
  { at: 0, h: "Drop the cards", p: "Camera cards, sound and the script, in one drag. Every file is checked as it lands." },
  { at: UP + 1.7, h: "Proxies, made for you", p: "Made while it uploads. No Media Encoder, no presets, nothing to babysit." },
  { at: CUT_AT, h: "Loupe cuts the scene", p: "Every take watched and lined up with the script. The best read of every line, picked." },
  { at: DONE_AT, h: "Watch your first cut", p: "Every shot has a reason. The script follows the picture." },
  { at: TRAY_AT, h: "Hear every take", p: "Open any line to see it in every take, side by side, and swap with one click." },
  { at: NOTE_AT, h: "Give a note", p: "Say what you want in plain words. Loupe makes a new version." },
];

const clipAt = (i: number, t: number) => {
  const start = UP + i * UP_GAP;
  const up = Math.min(1, Math.max(0, (t - start) / UP_EACH));
  const proxyStart = start + UP_EACH + 0.2;
  const proxy = Math.min(1, Math.max(0, (t - proxyStart) / PROXY));
  return { started: t >= start, up, uploaded: up >= 1, proxyStarted: t >= proxyStart, proxy };
};

function shootAt(t: number): { shoot: ShootDetail; progress: ShootProgress; inFlight: Record<string, number> } {
  const landed = t >= UP;
  const rows = CLIPS.map((c, i) => ({ c, i, s: clipAt(i, t) }));
  const clips: ClipRow[] = landed
    ? rows.map(({ c, i, s }) => ({
        id: i + 1,
        card: c.card,
        path: pathOf(c),
        sizeBytes: c.gb * GB,
        status: s.uploaded ? "uploaded" : s.started ? "uploading" : "pending",
        proxy: !s.uploaded
          ? null
          : {
              jobId: i + 1,
              status: !s.proxyStarted ? "queued" : s.proxy < 1 ? "running" : "done",
              progress: s.proxy,
              error: null,
              attempts: 1,
              lookUpdating: false,
            },
        media: null,
        thumbUrl: s.proxyStarted ? STILL(c.take) : null,
        preview: false,
      }))
    : [];
  const inFlight = Object.fromEntries(rows.filter(({ s }) => s.started && !s.uploaded).map(({ c, s }) => [pathOf(c), s.up]));
  const uploaded = clips.filter((c) => c.status === "uploaded");
  const bytesTotal = clips.reduce((n, c) => n + c.sizeBytes, 0);
  const bytesUploaded = uploaded.reduce((n, c) => n + c.sizeBytes, 0);
  const done = clips.filter((c) => c.proxy?.status === "done");
  const counts = { total: clips.length, uploaded: uploaded.length, problems: 0, bytesTotal, bytesUploaded };
  const safe = clips.length > 0 && uploaded.length === clips.length;
  const cards = ["A001", "A002"].map((card) => {
    const mine = clips.filter((c) => c.card === card);
    const up = mine.filter((c) => c.status === "uploaded");
    return {
      card,
      files: { total: mine.length, uploaded: up.length, problems: 0, bytesTotal: mine.reduce((n, c) => n + c.sizeBytes, 0), bytesUploaded: up.reduce((n, c) => n + c.sizeBytes, 0) },
      safeToWipe: mine.length > 0 && up.length === mine.length,
    };
  });
  const shoot: ShootDetail = {
    id: 1,
    name: "The Ring, scene 12",
    shootDate: "2026-09-23",
    storagePrefix: "demo",
    status: safe ? "uploaded" : "uploading",
    files: counts,
    cards: landed ? cards : [],
    proxies: {
      videos: clips.length,
      done: done.length,
      skipped: 0,
      failed: 0,
      running: clips.filter((c) => c.proxy?.status === "running").length,
      queued: clips.filter((c) => !c.proxy || c.proxy.status === "queued").length,
      progress: clips.length ? rows.reduce((n, { s }) => n + s.proxy, 0) / clips.length : 0,
    },
    safeToWipe: safe,
    proxiesReady: clips.length > 0 && done.length === clips.length,
    runtimeSeconds: rows.filter(({ s }) => s.proxy >= 1).reduce((n, { c }) => n + c.seconds, 0),
    coverUrl: null,
    lut: null,
    cardLuts: [],
    clips,
    problems: [],
    otherFiles: landed ? { count: 3, bytes: 0.4 * GB } : { count: 0, bytes: 0 },
  };
  const progress: ShootProgress = {
    shootId: 1,
    name: shoot.name,
    active: landed && !safe,
    reading: null,
    preparing: false,
    files: clips.length,
    filesDone: uploaded.length,
    bytes: bytesTotal,
    bytesDone: bytesUploaded,
    bytesPerSecond: 0,
    secondsLeft: null,
    retrying: 0,
    offline: false,
    signedOut: false,
    failed: [],
    cards: [],
    inFlight: {},
  };
  return { shoot, progress, inFlight };
}

// The script, and the cut Loupe makes of it (and, after the note, of its last line).
const LINES = [
  { who: "DANNY", text: "You kept the ring." },
  { who: "MAYA", text: "I kept the box. The ring’s in the river." },
  { who: "DANNY", text: "Which river?" },
  { who: "MAYA", text: "Does it matter?" },
];

function makeShots(lastTake: string, lastWhy: string): Shot[] {
  const plan: [string, number, number, string, Shot["kind"], Shot["cut"]][] = [
    ["1", -1, 2.4, "Opens wide, so we know where we are.", "establishing", null],
    ["5", 0, 2.0, "Take 5. He barely says it, and that’s the scene.", "shot", "straight"],
    ["9", 1, 3.4, "Take 9. She waits a beat before “river”. Take 7 says “lake”, and take 8 is soft.", "shot", "J"],
    ["3", 2, 1.8, "Take 3. Flat, almost a joke: he isn’t ready to ask.", "shot", "straight"],
    [lastTake, 3, 2.2, lastWhy, "shot", "straight"],
    ["5", 3, 2.0, "Danny takes it in. Her line carries over him.", "reaction", "L"],
  ];
  let at = 0;
  return plan.map(([take, line, seconds, why, kind, cut], k) => {
    const setup = SETUP[take];
    const said = line >= 0 ? LINES[line] : null;
    const shot: Shot = {
      n: k + 1,
      at,
      seconds,
      take,
      who: setup?.who ?? "MAYA",
      framing: setup?.framing ?? "medium",
      kind,
      line: said?.text ?? "",
      speaker: said?.who ?? "",
      listening: kind === "reaction",
      why,
      alternates: [],
      cut,
    };
    at += seconds;
    return shot;
  });
}

// When each line is heard in the preview, word by word.
const HEARD: [number, number][] = [
  [2.7, 3.9],
  [4.7, 7.0],
  [8.0, 8.9],
  [9.9, 11.0],
];
const SUBS = LINES.map((l, line) => {
  const [s, e] = HEARD[line];
  const words = l.text.split(" ");
  return { line, s, e, words: words.map((w, k) => ({ t: w, s: s + ((e - s) * k) / words.length })) };
});

const lineIn = (s: number, e: number, said: string, match = 1) => ({ s, e, match, said });
const LINE_TAKES: CutResult["lineTakes"] = {
  "3": { q: 0.82, why: [], complete: 1, performance: 0.8, lines: [lineIn(4, 5.2, "You kept the ring."), null, lineIn(9, 9.9, "Which river?"), null] },
  "4": { q: 0.4, why: [], complete: 1, performance: 0.7, lines: [lineIn(4.2, 5.4, "You kept the ring."), null, lineIn(9.4, 10.3, "Which river?"), null] },
  "5": { q: 0.9, why: [], complete: 1, performance: 0.9, lines: [lineIn(3.8, 5, "You kept the ring."), null, lineIn(8.8, 9.6, "Which river?"), null] },
  "6": { q: 0.7, why: [], complete: 1, performance: 0.6, lines: [lineIn(4.1, 5.2, "You kept the ring."), null, lineIn(9.2, 10, "Which river?"), null] },
  "7": { q: 0.74, why: [], complete: 0.8, performance: 0.85, lines: [null, lineIn(5, 7.3, "I kept the box. The ring’s in the lake.", 0.8), null, lineIn(11, 12, "Does it matter?")] },
  "8": { q: 0.5, why: [], complete: 1, performance: 0.7, lines: [null, lineIn(5.2, 7.4, "I kept the box. The ring’s in the river."), null, lineIn(11.3, 12.2, "Does it matter?")] },
  "9": { q: 0.93, why: [], complete: 1, performance: 0.92, lines: [null, lineIn(4.8, 7.2, "I kept the box. The ring’s in the river."), null, lineIn(10.8, 11.8, "Does it matter?")] },
  "10": { q: 0.88, why: [], complete: 1, performance: 0.86, lines: [null, lineIn(5.1, 7.3, "I kept the box. The ring’s in the river."), null, lineIn(11.1, 12, "Does it matter?")] },
};
const PERFORMANCES: Record<string, string> = {
  "3": "Flat, almost a joke",
  "4": "The boom dips into shot",
  "5": "Quiet, hurt",
  "6": "Too big",
  "7": "The most tired read",
  "8": "Soft focus",
  "9": "Holds the pause before “river”",
  "10": "Soft and steady",
};

function makeResult(version: 1 | 2): CutResult {
  const shots =
    version === 1
      ? makeShots("10", "Take 10, the steadiest read of the line.")
      : makeShots("7", "Take 7: quieter and more tired, as you asked.");
  return {
    title: "The Ring, scene 12",
    fromTakes: false,
    scriptId: 1,
    scriptTitle: "The Ring",
    match: 0.97,
    client: "MAYA",
    partner: "DANNY",
    roles: ["MAYA", "DANNY"],
    seconds: shots.reduce((n, s) => n + s.seconds, 0),
    shots,
    counts: { shots: shots.length, reactions: 1, splits: 0, lines: LINES.length },
    takes: CLIPS.map((c) => ({ take: c.take, path: pathOf(c), found: SETUP[c.take], setup: SETUP[c.take], used: shots.some((s) => s.take === c.take) })),
    lines: LINES,
    subs: SUBS,
    lineTakes: LINE_TAKES,
    dropped: [],
    jumps: [],
    heard: null,
    place: "Diner",
    lut: null,
    performances: PERFORMANCES,
    preview: { path: `v${version}.mp4`, size: 0 },
    files: [],
  };
}

const RESULT_1 = makeResult(1);
const RESULT_2 = makeResult(2);
const REPLY = "Swapped Maya’s last line to take 7, the most tired read. Take 10 is one click away.";

const view = (id: number, status: CutView["status"], step: string | null, result: CutResult | null, notes: { note: string; reply: string | null }[] = []): CutView => ({
  id,
  status,
  step,
  error: null,
  createdAt: "2026-09-23T18:00:00Z",
  startedAt: null,
  finishedAt: null,
  scriptId: 1,
  leadRole: null,
  coverage: null,
  direction: notes.length ? { notes: notes.map((n) => ({ ...n, at: "2026-09-23T18:10:00Z" })) } : null,
  result,
});

function cutAt(t: number): RoomCut {
  const base = {
    steps: CUT_STEPS,
    ready: 0,
    script: t >= UP + 1 ? { id: 1, title: "The Ring", roles: ["MAYA", "DANNY"] } : null,
    takes: Object.fromEntries(CLIPS.map((c) => [c.take, { still: STILL(c.take), preview: null, seconds: c.seconds }])),
    heading: "INT. DINER – NIGHT",
  };
  if (t < CUT_AT) return { ...base, latest: null, done: null, working: null, waiting: null, versions: 0, preview: null, previous: null };
  if (t < DONE_AT) {
    const step = CUT_STEPS[Math.min(CUT_STEPS.length - 1, Math.floor((t - CUT_AT) / STEP))].key;
    const making = view(1, "working", step, null);
    return { ...base, latest: making, done: null, working: making, waiting: null, versions: 0, preview: null, previous: null };
  }
  const v1 = view(1, "done", null, RESULT_1);
  if (t < SEND_AT) return { ...base, latest: v1, done: v1, working: null, waiting: null, versions: 1, preview: "/demo/cut-v1.mp4", previous: null };
  if (t < V2_AT) {
    const steps = ["listening", "cutting", "mixing", "packing"];
    const making = view(2, "working", steps[Math.min(steps.length - 1, Math.floor(((t - SEND_AT) / (V2_AT - SEND_AT)) * steps.length))], null, [{ note: NOTE, reply: null }]);
    return { ...base, latest: making, done: v1, working: making, waiting: null, versions: 1, preview: "/demo/cut-v1.mp4", previous: null };
  }
  const v2 = view(2, "done", null, RESULT_2, [{ note: NOTE, reply: REPLY }]);
  return { ...base, latest: v2, done: v2, working: null, waiting: null, versions: 2, preview: "/demo/cut-v2.mp4", previous: "/demo/cut-v1.mp4" };
}

const noop = () => {};
const yes = async () => true;

// The product is laid out for a laptop screen: on wide screens it's drawn at that size and scaled to fit; on narrow
// ones it uses its own phone layout at full size.
const WIDE = { w: 1280, h: 800 };

export function ProductDemo() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [seen, setSeen] = useState(false);
  const [scope, setScope] = useState<Scope>({ kind: "scene" });
  const [take, setTake] = useState(0); // remounts the room on a jump, so nothing from before lingers
  const [size, setSize] = useState({ w: WIDE.w, h: WIDE.h, scale: 1 });
  const box = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const clock = useRef({ t: 0, fired: new Set<string>() });

  // Fit the product to the space.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const width = el.clientWidth;
      setSize(matchMedia("(min-width: 980px)").matches ? { w: WIDE.w, h: WIDE.h, scale: width / WIDE.w } : { w: width, h: 660, scale: 1 });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Runs while on screen. With less motion asked for, it opens on the finished cut and waits for a press.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let first = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (first && matchMedia("(prefers-reduced-motion: reduce)").matches) {
          clock.current = { t: DONE_AT + 0.5, fired: new Set(["play"]) };
          setT(DONE_AT + 0.5);
          setPlaying(false);
        }
        first = false;
        setSeen(e.isIntersecting);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The clock, and the few things done to the product by hand at their moment: playing the cut, opening a line's
  // other takes, typing the note and sending it.
  useEffect(() => {
    const video = () => screen.current?.querySelector<HTMLVideoElement>(".picture video") ?? null;
    if (!playing || !seen) {
      video()?.pause();
      return;
    }
    const at = (key: string, when: number, now: number, act: () => void) => {
      if (now >= when && !clock.current.fired.has(key)) {
        clock.current.fired.add(key);
        act();
      }
    };
    const play = (from: number) => {
      const v = video();
      if (!v) return;
      v.muted = true;
      // A version that has just come in is still loading: wait until it knows its length before moving in it.
      const go = () => ((v.currentTime = from), void v.play().catch(() => {}));
      if (v.readyState >= 1) go();
      else v.addEventListener("loadedmetadata", go, { once: true });
    };
    const click = (selector: string) => screen.current?.querySelector<HTMLElement>(selector)?.click();
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const c = clock.current;
      c.t += (now - last) / 1000;
      last = now;
      if (c.t >= LOOP) {
        c.t = 0;
        c.fired = new Set();
        setScope({ kind: "scene" });
        setTake((k) => k + 1);
      }
      const s = c.t;
      at("play", DONE_AT + 0.4, s, () => play(0));
      at("tray", TRAY_AT, s, () => {
        click('.beat[data-li="3"] .ltools button');
        // Bring the takes into view inside the script, never by moving the page.
        setTimeout(() => {
          const col = screen.current?.querySelector<HTMLElement>(".scriptcol");
          col?.scrollTo({ top: col.scrollHeight, behavior: "smooth" });
        }, 120);
      });
      at("tray-done", TRAY_DONE, s, () => click(".tray .tray-k .textlink"));
      if (s >= NOTE_AT && s < SEND_AT) {
        const input = screen.current?.querySelector<HTMLInputElement>(".cmdbar input");
        const text = NOTE.slice(0, Math.floor((s - NOTE_AT) / 0.05));
        if (input && input.value !== text) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      at("send", SEND_AT, s, () => click(".cmdbar .send"));
      at("v2", V2_AT + 0.3, s, () => play(9.3));
      setT(s);
    }, 100);
    return () => clearInterval(timer);
  }, [playing, seen]);

  const jump = (to: number) => {
    // What would already have happened by then counts as done, except playing the cut from the right place.
    const fired = new Set<string>();
    if (to > TRAY_DONE) fired.add("tray").add("tray-done");
    clock.current = { t: to, fired };
    setScope({ kind: "scene" });
    setTake((k) => k + 1);
    setT(to);
    setPlaying(true);
    if (to > DONE_AT + 0.4 && to < V2_AT) setTimeout(() => {
      const v = screen.current?.querySelector<HTMLVideoElement>(".picture video");
      if (v) (v.muted = true), (v.currentTime = Math.min(13, to - DONE_AT)), void v.play().catch(() => {});
      clock.current.fired.add("play");
    }, 150);
  };

  const q = Math.round(t * 10) / 10;
  const { shoot, progress, inFlight } = useMemo(() => shootAt(q), [q]);
  const cut = useMemo(() => cutAt(q), [q]);
  const phase = cut.done ? "suite" : cut.latest ? "cutting" : "ingest";
  const chapter = CHAPTERS.reduce((k, c, i) => (t >= c.at ? i : k), 0);
  const dragging = t > 0.5 && t < UP + 0.2;

  return (
    <div className="grid gap-5">
      <ol className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {CHAPTERS.map((c, i) => (
          <li key={c.h}>
            <button
              type="button"
              onClick={() => jump(c.at + 0.01)}
              aria-current={i === chapter ? "step" : undefined}
              className={`grid w-full gap-1.5 text-left transition-opacity ${i === chapter ? "opacity-100" : "opacity-45 hover:opacity-80"}`}
            >
              <span className="h-[3px] overflow-hidden rounded-full bg-surface-3">
                <span
                  className="block h-full rounded-full bg-text"
                  style={{ width: `${i < chapter ? 100 : i === chapter ? Math.min(100, ((t - c.at) / ((CHAPTERS[i + 1]?.at ?? LOOP) - c.at)) * 100) : 0}%` }}
                />
              </span>
              <span className="text-[14px] font-semibold tracking-[-0.01em]">{c.h}</span>
            </button>
          </li>
        ))}
      </ol>

      <div ref={box} className="overflow-hidden rounded-[18px] bg-surface shadow-lift ring-1 ring-line">
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2.5" aria-hidden="true">
          <i className="block size-2.5 rounded-full bg-surface-3" />
          <i className="block size-2.5 rounded-full bg-surface-3" />
          <i className="block size-2.5 rounded-full bg-surface-3" />
          <span className="mx-auto rounded-md bg-surface-2 px-3 py-0.5 text-[11.5px] text-faint">editloupe.com/scenes/the-ring</span>
          <button
            type="button"
            onClick={() => (t >= LOOP - 0.2 ? jump(0) : setPlaying((p) => !p))}
            className="text-[11.5px] text-muted underline decoration-faint underline-offset-2 hover:text-text"
          >
            {playing ? "Pause" : "Play"}
          </button>
        </div>
        <div className={`relative overflow-hidden${size.scale === 1 ? " [&_.side]:hidden!" : ""}`} style={{ height: size.h * size.scale }} aria-hidden="true" inert>
          <div
            ref={screen}
            key={take}
            className={`room flex flex-col${phase !== "ingest" ? " editing" : ""}`}
            style={{ width: size.w, height: size.h, transform: `scale(${size.scale})`, transformOrigin: "0 0", background: "var(--bg)" }}
          >
            <header className="top">
              <div className="scene">
                <span className="textlink" style={{ textDecoration: "none" }}>
                  Your scenes
                </span>
                {" / "}
                <b>{shoot.name}</b>
              </div>
              <div className="top-r">
                {phase === "suite" && (
                  <>
                    <span className="btn soft">Share</span>
                    <span className="btn">Export</span>
                  </>
                )}
              </div>
            </header>
            <main className="flex min-h-0 flex-1 flex-col">
              {phase === "ingest" ? (
                <Ingest shoot={shoot} cut={cut} progress={progress} inFlight={inFlight} onChoose={noop} onRetry={noop} onAgain={noop} onScript={async () => null} />
              ) : (
                <Suite
                  cut={cut}
                  title={shoot.name}
                  stills={shoot.clips.flatMap((c) => (c.thumbUrl ? [c.thumbUrl] : []))}
                  dept="edit"
                  scope={scope}
                  onScope={setScope}
                  busy={false}
                  onPick={noop}
                  onLead={noop}
                  embedded
                />
              )}
            </main>
            {phase === "suite" && (
              <CommandBar cut={cut} dept="edit" onDept={noop} scope={scope} onScope={setScope} busy={false} onExtra={yes} onSend={yes} embedded />
            )}
            {dragging && <Drop t={t} />}
          </div>
        </div>
      </div>

      <p key={chapter} className="animate-rise text-[15px] text-muted">
        <b className="font-semibold text-text">{CHAPTERS[chapter].h}.</b> {CHAPTERS[chapter].p}
      </p>
      <p className="sr-only">
        A demo of Loupe: the camera cards are dropped in and upload, proxies are made automatically, Loupe cuts the scene, the cut plays with a reason
        for every shot, a line&apos;s other takes are opened, and a note is given that makes a new version.
      </p>
    </div>
  );
}

/** The scene's folder being dragged in: the cards, the sound and the script, with the pointer. */
function Drop({ t }: { t: number }) {
  const k = Math.min(1, Math.max(0, (t - 0.5) / 1.1));
  const ease = 1 - (1 - k) ** 3;
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" style={{ background: `rgba(246,246,243,${0.55 * ease})` }}>
      <div
        className="grid gap-1.5"
        style={{ transform: `translate(${(1 - ease) * -420}px, ${(1 - ease) * -260}px) rotate(${(1 - ease) * -8}deg)`, opacity: t > UP ? 0 : 1, transition: "opacity .2s" }}
      >
        {["A001", "A002", "Sound", "The Ring.fdx"].map((name, i) => (
          <span
            key={name}
            className="flex items-center gap-2 rounded-[10px] bg-surface px-3.5 py-2 text-[15px] font-medium shadow-lift ring-1 ring-line"
            style={{ transform: `translate(${i * 6}px, ${i * -2}px)` }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M2 4.5h5l1.5 1.5H16v8.5H2z" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            {name}
          </span>
        ))}
        <svg width="22" height="22" viewBox="0 0 22 22" className="ml-24 -mt-3" aria-hidden="true">
          <path d="M4 2l13 9-6 1.4L8 19z" fill="#161614" stroke="#fff" strokeWidth="1.4" />
        </svg>
      </div>
    </div>
  );
}
