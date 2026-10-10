"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CommandBar } from "@/components/room/command-bar";
import { ExportSheet, type FinalState } from "@/components/room/export-sheet";
import type { DownloadState } from "@/components/shoots/use-download";
import { Ingest } from "@/components/room/ingest";
import { Suite, type Scope } from "@/components/room/suite";
import { CUT_STEPS, type CutResult, type CutView, type RoomCut, type Shot } from "@/lib/footage/cut-types";
import type { ClipRow, ShootDetail } from "@/lib/footage/status";
import type { ShootProgress } from "@/lib/upload/manager";
import "@/components/room/room.css";

// The landing page's "how it works", played in the product itself: the real upload screen, the real "Loupe is cutting"
// screen, the real cutting room, command bar and export sheet, fed a scripted scene instead of the server: stills and
// two short cuts of a Reelarc scene shot on Oct 8, 2026, in public/demo (Reelarc holds the rights; Guy, Oct 9), taken
// from Footage through the bridge: the stills and the second cut from its previews, the first cut from the first
// assembly Loupe made of it. One clock
// drives it: the card goes in, the proxies make themselves, Loupe cuts the scene, the cut plays, a line's other takes
// fan out, a note is typed and a new version comes back, then the export (the final, 4K with Topaz, the XML timeline
// for Resolve). It pauses off screen; with less motion asked for it opens on the finished cut and waits.

const STILL = (take: string) => `/demo/take-${take}.jpg`;
const GB = 1e9;

// The shoot: a Reelarc scene shot Oct 8, 2026 (used with Reelarc's rights), its card as it came off the camera: eleven
// clips of Jess (JESS) and Noah (NOAH), medium and close.
const CLIPS: { take: string; code: string; bytes: number; seconds: number }[] = [
  { take: "1", code: "T034", bytes: 1778223104, seconds: 130 },
  { take: "2", code: "T035", bytes: 2672667136, seconds: 177 },
  { take: "3", code: "T036", bytes: 1726151168, seconds: 123 },
  { take: "4", code: "T037", bytes: 1591251456, seconds: 118 },
  { take: "5", code: "T038", bytes: 1679026688, seconds: 117 },
  { take: "6", code: "T039", bytes: 1368974848, seconds: 106 },
  { take: "7", code: "T040", bytes: 1445919744, seconds: 114 },
  { take: "8", code: "T041", bytes: 1576727040, seconds: 127 },
  { take: "9", code: "T042", bytes: 1714672640, seconds: 129 },
  { take: "10", code: "T043", bytes: 1760075776, seconds: 128 },
  { take: "11", code: "T044", bytes: 1914081792, seconds: 142 },
];
const JESS_TAKES = ["1", "2", "3", "4", "5", "6"];
const CLOSE_TAKES = ["4", "5", "6", "9", "10", "11"];
const SETUP: Record<string, { who: string; framing: "medium" | "close" }> = Object.fromEntries(
  CLIPS.map((c) => [c.take, { who: JESS_TAKES.includes(c.take) ? "JESS" : "NOAH", framing: CLOSE_TAKES.includes(c.take) ? "close" : "medium" }]),
);
const pathOf = (c: (typeof CLIPS)[number]) => `A001/SHGN1_S001_S001_${c.code}.MOV`;
const secondsOf = (c: (typeof CLIPS)[number]) => c.seconds;

// The clock, in seconds.
const UP = 1.8; // the cards land
const UP_EACH = 1.4;
const UP_GAP = 0.28;
const PROXY = 1.0;
const CUT_AT = 9;
const STEP = 0.85;
const DONE_AT = CUT_AT + CUT_STEPS.length * STEP + 0.2;
const TRAY_AT = DONE_AT + 20;
const TRAY_DONE = TRAY_AT + 3.8;
const NOTE_AT = TRAY_DONE + 0.5;
const NOTE = "Stay on Jess while he says this";
const SEND_AT = NOTE_AT + NOTE.length * 0.05 + 0.5;
const V2_AT = SEND_AT + 3.4;
const EXPORT_AT = V2_AT + 5.5;
const FINAL_DONE = EXPORT_AT + 2.6;
const TOPAZ_AT = FINAL_DONE + 1.2;
const TOPAZ_DONE = TOPAZ_AT + 2.6;
const XML_AT = TOPAZ_DONE + 1;
const SAVED = XML_AT + 2.2;
const LOOP = SAVED + 5;

const CHAPTERS = [
  { at: 0, h: "Drop the footage", p: "Camera cards, sound and the script, in one drag. Every file is checked as it lands." },
  { at: UP + 1.7, h: "Proxies, made for you", p: "Made while it uploads. No Media Encoder, no presets, nothing to babysit." },
  { at: CUT_AT, h: "Loupe cuts the scene", p: "Every take watched and lined up with the script. The best read of every line, picked." },
  { at: DONE_AT, h: "Watch your first cut", p: "Every shot has a reason. The script follows the picture." },
  { at: TRAY_AT, h: "Hear every take", p: "Open any line to see it in every take, side by side, and swap with one click." },
  { at: NOTE_AT, h: "Give a note", p: "Say what you want in plain words. Loupe makes a new version." },
  {
    at: EXPORT_AT,
    h: "Export",
    p: "Download the finished scene at full resolution, sharpen it to 4K with Topaz, or take an XML timeline into Premiere Pro or DaVinci Resolve and keep editing.",
  },
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
        card: "A001",
        path: pathOf(c),
        sizeBytes: c.bytes,
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
  const cards = ["A001"].map((card) => {
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
    name: "Just Felt Right",
    shootDate: "2026-10-08",
    storagePrefix: "demo",
    status: safe ? "uploaded" : "uploading",
    footage: { until: null, warned: false, keep: false, removedAt: null },
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
    runtimeSeconds: rows.filter(({ s }) => s.proxy >= 1).reduce((n, { c }) => n + secondsOf(c), 0),
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

// The script's first six lines, and the cut Loupe makes of them (and, after the note, of Noah's Marissa line). Times
// are the scene's own, frame for frame from the first assembly.
const LINES = [
  { who: "JESS", text: "You can ask, you know." },
  { who: "NOAH", text: "Ask what?" },
  { who: "JESS", text: "Whatever’s making you stare at me like that." },
  { who: "NOAH", text: "I just don’t understand why you let Marissa get to you so much." },
  { who: "JESS", text: "Well, we were friends." },
  { who: "NOAH", text: "What happened?" },
];

type Plan = [take: string, line: number, seconds: number, why: string, kind: Shot["kind"], cut: Shot["cut"]];
const F = 1001 / 24000;
const FIRST: Plan[] = [
  ["3", 0, 47 * F, "Take 3, the last before moving on. She starts it without looking up.", "shot", null],
  ["8", 1, 25 * F, "Take 8. The director said “awesome” after this one.", "shot", "L"],
  ["3", 2, 124 * F, "Take 3 again, so her two lines play as one thought.", "shot", "J"],
  ["8", 3, 106 * F, "Take 8. He says it gently, which is what makes it land.", "shot", "J"],
  ["6", 4, 102 * F, "Take 6, close. We move in as she starts to open up.", "shot", "straight"],
  ["10", 5, 52 * F, "Take 10, close. The director said “awesome” after it.", "shot", "L"],
];
const AFTER_NOTE: Plan[] = [
  ...FIRST.slice(0, 3),
  ["8", 3, 49 * F, "Take 8. He says it gently, which is what makes it land.", "shot", "J"],
  ["6", 3, 57 * F, "Jess takes it in (take 6). His line carries over her, as you asked.", "reaction", "L"],
  ...FIRST.slice(4),
];

function makeShots(plan: Plan[]): Shot[] {
  let at = 0;
  return plan.map(([take, line, seconds, why, kind, cut], k) => {
    const shot: Shot = {
      n: k + 1,
      at,
      seconds,
      take,
      who: SETUP[take].who,
      framing: SETUP[take].framing,
      kind,
      line: LINES[line].text,
      speaker: LINES[line].who,
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
  [0.1, 1.95],
  [2.05, 3.3],
  [3.45, 7.8],
  [7.95, 12.1],
  [12.2, 16.8],
  [16.9, 18.9],
];
const SUBS = LINES.map((l, line) => {
  const [s, e] = HEARD[line];
  const words = l.text.split(" ");
  return { line, s, e, words: words.map((w, k) => ({ t: w, s: s + ((e - s) * k) / words.length })) };
});

// Every line in every take of its speaker, and how each one plays.
const LINE_TAKES: CutResult["lineTakes"] = Object.fromEntries(
  CLIPS.map((c, k) => {
    const who = SETUP[c.take].who;
    const lines = LINES.map((l, j) => {
      if (l.who !== who) return null;
      const [s, e] = HEARD[j];
      const match = c.take === "9" && j === 3 ? 0.8 : 1;
      return { s: s + 2 + (k % 3) * 0.3, e: e + 2 + (k % 3) * 0.3, match, said: match < 1 ? "I just don’t understand why you let Marissa get to you." : l.text };
    });
    return [c.take, { q: 0.6 + ((k * 7) % 10) / 30, why: [], complete: 1, performance: 0.7, lines }];
  }),
);
const PERFORMANCES: Record<string, string> = {
  "7": "First pass, a little quick",
  "8": "Gentle; the director said “awesome”",
  "9": "Drops “so much”",
  "10": "Looks away on “Marissa”",
  "11": "Lighter, almost teasing",
};

function makeResult(version: 1 | 2): CutResult {
  const shots = makeShots(version === 1 ? FIRST : AFTER_NOTE);
  return {
    title: "Just Felt Right",
    fromTakes: false,
    scriptId: 1,
    scriptTitle: "Just Felt Right",
    match: 0.98,
    client: "JESS",
    partner: "NOAH",
    roles: ["JESS", "NOAH"],
    seconds: shots.reduce((n, s) => n + s.seconds, 0),
    shots,
    counts: { shots: shots.length, reactions: version === 1 ? 0 : 1, splits: 0, lines: LINES.length },
    takes: CLIPS.map((c) => ({ take: c.take, path: pathOf(c), found: SETUP[c.take], setup: SETUP[c.take], used: shots.some((s) => s.take === c.take) })),
    lines: LINES,
    subs: SUBS,
    lineTakes: LINE_TAKES,
    dropped: [],
    jumps: [],
    heard: null,
    place: "Bedroom",
    lut: "Vision_Burano_G1_33x",
    performances: PERFORMANCES,
    preview: { path: `v${version}.mp4`, size: 0 },
    files: [],
  };
}

const RESULT_1 = makeResult(1);
const RESULT_2 = makeResult(2);
const REPLY = "Cut to Jess halfway through Noah’s line, so we watch it land on her. His take stays the same.";

const view = (id: number, status: CutView["status"], step: string | null, result: CutResult | null, notes: { note: string; reply: string | null }[] = []): CutView => ({
  id,
  status,
  step,
  error: null,
  createdAt: "2026-10-08T22:00:00Z",
  startedAt: null,
  finishedAt: null,
  scriptId: 1,
  leadRole: null,
  coverage: null,
  direction: notes.length ? { notes: notes.map((n) => ({ ...n, at: "2026-10-08T22:10:00Z" })) } : null,
  result,
});

function cutAt(t: number): RoomCut {
  const base = {
    steps: CUT_STEPS,
    ready: 0,
    script: t >= UP + 1 ? { id: 1, title: "Just Felt Right", roles: ["JESS", "NOAH"] } : null,
    takes: Object.fromEntries(CLIPS.map((c) => [c.take, { still: STILL(c.take), preview: null, seconds: secondsOf(c) }])),
    heading: "INT. JESS’S ROOM – NIGHT",
    fundWait: false,
    changes: { used: t >= SEND_AT ? 1 : 0, limit: 3, plan: "indie" as const },
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

// The export: the final built from the camera files, then 4K with Topaz, then the timeline saved for Resolve.
function finalAt(t: number): FinalState {
  const base = { id: 1, cutId: 2, error: null, download: "#" };
  const finals: FinalState["finals"] = [
    t < FINAL_DONE
      ? { ...base, kind: "original", status: "working", progress: (t - EXPORT_AT) / (FINAL_DONE - EXPORT_AT), width: null, height: null, sizeBytes: null, download: null }
      : { ...base, kind: "original", status: "done", progress: 1, width: 1920, height: 1080, sizeBytes: 1.4 * GB },
  ];
  if (t >= TOPAZ_AT)
    finals.push(
      t < TOPAZ_DONE
        ? { ...base, id: 2, kind: "topaz", status: "working", progress: ((t - TOPAZ_AT) / (TOPAZ_DONE - TOPAZ_AT)) * 0.9, width: null, height: null, sizeBytes: null, download: null }
        : { ...base, id: 2, kind: "topaz", status: "done", progress: 1, width: 3840, height: 2160, sizeBytes: 4.8 * GB },
    );
  return { cutId: 2, canMake: true, topazCost: 3.2, finals };
}

function savingAt(t: number): DownloadState {
  if (t < XML_AT) return { step: "idle" };
  const files = 24;
  const bytes = 20.4 * GB;
  if (t < SAVED) {
    const k = (t - XML_AT) / (SAVED - XML_AT);
    return { step: "working", files, filesDone: Math.floor(files * k), bytes, bytesDone: bytes * k };
  }
  return { step: "done", folder: "Just Felt Right", files, bytes };
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
          const beat = col?.querySelector<HTMLElement>('.beat[data-li="3"]');
          if (!col || !beat) return;
          const k = col.getBoundingClientRect().width / col.offsetWidth || 1;
          const top = col.scrollTop + (beat.getBoundingClientRect().top - col.getBoundingClientRect().top) / k - 24;
          col.scrollTo({ top, behavior: "smooth" });
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
      at("v2", V2_AT + 0.3, s, () => play(7.6));
      // The export sheet scrolls itself, inside its own card.
      const sheet = () => {
        const card = screen.current?.querySelector<HTMLElement>(".sheet-card");
        card?.scrollTo({ top: card.scrollHeight, behavior: "smooth" });
      };
      at("xml", XML_AT, s, () => (click(".sheet .app-choice:nth-child(2)"), setTimeout(sheet, 150)));
      at("saved", SAVED + 0.1, s, () => setTimeout(sheet, 150));
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
      if (v) (v.muted = true), (v.currentTime = Math.min(18, to - DONE_AT)), void v.play().catch(() => {});
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
      <ol className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
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
          <span className="mx-auto rounded-md bg-surface-2 px-3 py-0.5 text-[11.5px] text-faint">editloupe.com/scenes/just-felt-right</span>
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
                  sceneId={1}
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
              <CommandBar sceneId={1} cut={cut} dept="edit" onDept={noop} scope={scope} onScope={setScope} busy={false} onExtra={yes} onSend={yes} embedded />
            )}
            {t >= EXPORT_AT && cut.done?.result && (
              <ExportSheet
                sceneId={1}
                result={cut.done.result}
                state={savingAt(q)}
                supported
                onStart={async () => null}
                onAgain={noop}
                onClose={noop}
                final={finalAt(q)}
              />
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
        for every shot, a line&apos;s other takes are opened, and a note is given that makes a new version, and the scene is exported: the full-resolution final, a 4K version made with Topaz,
        and an XML timeline for DaVinci Resolve.
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
        {["A001", "Sound", "Just Felt Right.pdf"].map((name, i) => (
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
