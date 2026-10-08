"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Loupe, type LoupeMood } from "@/components/loupe/loupe";
import { Still, type Flaw, type Setup } from "./still";

// The landing page's "how it works", played out on a two-person dialogue scene: the takes come in, Loupe hears every
// line in every take, picks the best read of each (and says why), then cuts the scene and plays it. Under it, a
// race: Loupe's few minutes against the three hours the same work takes by hand. Everything runs off one clock, so
// a step can be jumped to; it pauses off screen and waits for a press when the visitor prefers less motion.

type Take = { take: string; setup: Setup; note: string; flaw?: Flaw; pick?: boolean; nudge?: number };
type Line = { who: "MAYA" | "DANNY"; text: string; takes: Take[]; why: string };

const LINES: Line[] = [
  {
    who: "DANNY",
    text: "You kept the ring.",
    takes: [
      { take: "2A-1", setup: "danny", note: "Rushed", nudge: -4 },
      { take: "2A-2", setup: "danny", note: "Boom dips in", flaw: "boom" },
      { take: "2A-3", setup: "danny", note: "Quiet, hurt", pick: true, nudge: 3 },
    ],
    why: "Take 3. He barely says it, and that’s the scene.",
  },
  {
    who: "MAYA",
    text: "I kept the box. The ring’s in the river.",
    takes: [
      { take: "2B-1", setup: "maya", note: "Says “lake”", nudge: 3 },
      { take: "2B-2", setup: "maya", note: "Soft focus", flaw: "soft" },
      { take: "2B-3", setup: "maya", note: "Holds the pause", pick: true, nudge: -3 },
      { take: "2B-4", setup: "maya", note: "Breaks, laughs", nudge: 5 },
    ],
    why: "Take 3. She waits a beat before “river”. Take 1 says “lake”.",
  },
  {
    who: "DANNY",
    text: "Which river?",
    takes: [
      { take: "2A-1", setup: "danny", note: "Flat, almost a joke", pick: true, nudge: -4 },
      { take: "2A-2", setup: "danny", note: "Boom dips in", flaw: "boom" },
      { take: "2A-3", setup: "danny", note: "Too big", nudge: 3 },
    ],
    why: "Take 1. Flat, almost a joke. He isn’t ready to ask.",
  },
  {
    who: "MAYA",
    text: "Does it matter?",
    takes: [
      { take: "2B-1", setup: "maya", note: "Too sharp", nudge: 3 },
      { take: "2B-3", setup: "maya", note: "Steps on his line", nudge: -3 },
      { take: "2B-4", setup: "maya", note: "Soft, tired", pick: true, nudge: 5 },
    ],
    why: "Take 4, the softest. Then we stay on Danny as it lands.",
  },
];

type Shot = { setup: Setup; take: string; line: number; secs: number; why: string; nudge?: number; reaction?: boolean };

const picked = (i: number) => LINES[i].takes.find((t) => t.pick)!;
const SHOTS: Shot[] = [
  { setup: "wide", take: "1-2", line: -1, secs: 2.4, why: "Opens wide, so we know where we are." },
  ...LINES.map((l, i) => ({ setup: picked(i).setup, take: picked(i).take, nudge: picked(i).nudge, line: i, secs: [2, 3.2, 1.8, 2.2][i], why: l.why })),
  { setup: "danny", take: "2A-3", line: -1, secs: 2.2, why: "Danny takes it in. L cut: her line carries over him.", nudge: 3, reaction: true },
];

// Every take in the folder, for the drop.
const FOLDER: { setup: Setup; flaw?: Flaw; nudge?: number }[] = [
  { setup: "wide" }, { setup: "wide", nudge: 3 }, { setup: "danny", nudge: -4 }, { setup: "danny", flaw: "boom" },
  { setup: "danny", nudge: 3 }, { setup: "maya", nudge: 3 }, { setup: "maya", flaw: "soft" }, { setup: "maya", nudge: -3 },
  { setup: "maya", nudge: 5 }, { setup: "wide", nudge: -3 }, { setup: "danny", nudge: 6 }, { setup: "maya", nudge: -6 },
];

const DROP = 3;
const PER_LINE = 2.3;
const DECIDE = 1.35; // into a line, when Loupe settles on a take
const REVIEW_END = DROP + LINES.length * PER_LINE;
const CUT_LEN = SHOTS.reduce((s, x) => s + x.secs, 0);
const CUT_END = REVIEW_END + CUT_LEN;
const LOOP = CUT_END + 3.5;
const HAND_MINUTES = 200;
const LOUPE_MINUTES = 5;

const STEPS = [
  { h: "Drop the folder", p: "Cards, sound and script. It uploads, checks every file and makes proxies.", at: 0 },
  { h: "It watches every take", p: "Every line, heard in every take, lined up with your script.", at: DROP + 0.01 },
  { h: "Picks the best reads", p: "Flubs, soft focus and boom in shot are out. Every pick has a reason.", at: DROP + DECIDE },
  { h: "Cuts the scene", p: "Reactions, J and L cuts, no jump cuts. Ready to watch, then give notes.", at: REVIEW_END + 0.01 },
];

const SETUP_NAME: Record<Setup, string> = { wide: "Wide", maya: "Maya, close", danny: "Danny, close" };
const WHO_BAR: Record<Setup, string> = { wide: "#97978f", maya: "#C29A6E", danny: "#8399AC" };

function state(t: number) {
  if (t < DROP) return { phase: "drop" as const };
  if (t < REVIEW_END) {
    const line = Math.floor((t - DROP) / PER_LINE);
    return { phase: "review" as const, line, lt: t - DROP - line * PER_LINE };
  }
  if (t < CUT_END) {
    let at = t - REVIEW_END;
    let shot = 0;
    while (shot < SHOTS.length - 1 && at >= SHOTS[shot].secs) at -= SHOTS[shot++].secs;
    return { phase: "cut" as const, shot, into: at };
  }
  return { phase: "done" as const };
}

/** By hand, this far into the same work. */
function handDoing(minutes: number) {
  if (minutes < 2) return "copying the cards";
  if (minutes < 4) return "still copying the cards";
  return "starting on the proxies";
}

export function SceneDemo() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [seen, setSeen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Runs only while on screen. With less motion asked for, it starts on the finished cut and waits for Play.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let first = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (first && matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setPlaying(false);
          setT(CUT_END + 0.5);
        }
        first = false;
        setSeen(e.isIntersecting);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !seen) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      setT((x) => (x + dt >= LOOP ? 0 : x + dt));
    }, 50);
    return () => clearInterval(timer);
  }, [playing, seen]);

  const s = state(t);
  const progress = Math.min(1, t / CUT_END);
  const linesDone = s.phase === "drop" ? 0 : s.phase === "review" ? s.line + (s.lt >= DECIDE ? 1 : 0) : LINES.length;
  const step = s.phase === "drop" ? 0 : s.phase === "review" ? (s.lt < DECIDE ? 1 : 2) : 3;

  let mood: LoupeMood = "idle";
  let status = "";
  if (s.phase === "drop") {
    mood = "listen";
    status = "14 takes in, 48 minutes of footage. Every file checked.";
  } else if (s.phase === "review") {
    const take = picked(s.line);
    mood = s.lt < DECIDE ? "think" : "happy";
    status = s.lt < DECIDE ? `Line ${s.line + 1} of ${LINES.length}: hearing it in every take` : `Take ${take.take.split("-")[1]}: ${take.note.toLowerCase()}`;
  } else if (s.phase === "cut") {
    status = "Cutting it together: reactions, J and L cuts, no jump cuts";
  } else {
    mood = "happy";
    status = "First cut ready, with a reason for every shot. Your turn to give notes.";
  }

  // What the picture shows: the folder, the take being heard, or the cut playing.
  let picture: React.ReactNode;
  let chip = "";
  let sub = "";
  if (s.phase === "drop") {
    picture = (
      <div className="absolute inset-0 grid grid-cols-4 grid-rows-3 gap-[3px] p-[3px]">
        {FOLDER.map((f, i) => (
          <div key={i} className={`overflow-hidden rounded-[5px] transition-all duration-500 ${t > i * 0.18 ? "scale-100 opacity-90" : "scale-90 opacity-0"}`}>
            <Still setup={f.setup} flaw={f.flaw} nudge={f.nudge} />
          </div>
        ))}
      </div>
    );
  } else if (s.phase === "review") {
    const takes = LINES[s.line].takes;
    const take = s.lt < DECIDE ? takes[Math.floor(s.lt / 0.32) % takes.length] : picked(s.line);
    picture = <Still key={`${s.line}-${take.take}`} setup={take.setup} flaw={take.flaw} nudge={take.nudge} />;
    chip = `${take.take} · ${SETUP_NAME[take.setup]}`;
    sub = LINES[s.line].text;
  } else {
    const shot = SHOTS[s.phase === "cut" ? s.shot : 2];
    picture = <Still key={shot.take + shot.line + (shot.reaction ? "r" : "")} setup={shot.setup} nudge={shot.nudge} className="animate-drift" />;
    chip = `${shot.take} · ${shot.reaction ? "Reaction" : SETUP_NAME[shot.setup]}`;
    sub = shot.line >= 0 ? LINES[shot.line].text : "";
  }

  const activeLine = s.phase === "review" ? s.line : s.phase === "cut" ? SHOTS[s.shot].line : -1;
  const shotsIn = s.phase === "drop" ? 0 : s.phase === "review" ? 1 + linesDone : SHOTS.length;
  const head = s.phase === "cut" ? (t - REVIEW_END) / CUT_LEN : s.phase === "done" ? 1 : null;

  return (
    <div ref={box} className="rounded-[28px] bg-surface p-4 shadow-lift sm:p-6">
      <p className="sr-only">
        A demo: fourteen takes of a two-person dialogue scene go in. Loupe hears each line in every take, rejects the flubs, the soft focus and the boom in
        shot, picks the best read of each line with a reason, then cuts the scene with reactions and J and L cuts. By hand that work takes about three
        hours; Loupe takes a few minutes.
      </p>
      <div className="mb-4 flex items-center gap-3">
        <Loupe size={34} mood={mood} dept="edit" ticklish={false} />
        <span key={status} className="min-w-0 flex-1 animate-rise truncate text-[14px] text-muted" aria-hidden="true">
          {status}
        </span>
        <button
          type="button"
          onClick={() => (s.phase === "done" ? (setT(0), setPlaying(true)) : setPlaying((p) => !p))}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg text-muted ring-1 ring-line hover:text-text"
          aria-label={s.phase === "done" ? "Play the demo again" : playing ? "Pause the demo" : "Play the demo"}
        >
          {s.phase === "done" ? <RotateCcw className="size-3.5" /> : playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]" aria-hidden="true">
        <div className="grid content-start gap-3">
          <div className="relative aspect-[2.4/1] overflow-hidden rounded-[16px] bg-[#121210] shadow-lift">
            {picture}
            {chip && (
              <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[11.5px] text-text shadow-lift-sm">
                <i className={`block size-1.5 rounded-full ${s.phase === "review" && s.lt < DECIDE ? "bg-faint" : "bg-tally"}`} /> {chip}
              </span>
            )}
            {sub && (
              <p className="absolute inset-x-[8%] bottom-[9%] text-balance text-center text-[clamp(12px,1.5vw,17px)] font-medium leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,.85)]">
                {sub}
              </p>
            )}
            {s.phase === "done" && (
              <div className="absolute inset-0 grid animate-rise place-items-center bg-black/55 text-center text-white">
                <div>
                  <p className="text-[clamp(20px,2.8vw,32px)] font-semibold tracking-[-0.03em]">First cut ready</p>
                  <p className="text-[13px] text-white/70">6 shots · 14 takes heard · 0 slates, flubs or jump cuts</p>
                </div>
              </div>
            )}
          </div>

          <div className="grid min-h-[86px] grid-cols-4 gap-2">
            {s.phase === "review" &&
              LINES[s.line].takes.map((take, k) => {
                const shown = s.lt > 0.15 + k * 0.2;
                const decided = s.lt >= DECIDE;
                return (
                  <div key={s.line + take.take} className={`min-w-0 transition-all duration-300 ${shown ? "opacity-100" : "translate-y-1 opacity-0"} ${decided && !take.pick ? "opacity-40" : ""}`}>
                    <div className={`aspect-[2.4/1] overflow-hidden rounded-[6px] ${decided && take.pick ? "ring-2 ring-tally" : "ring-1 ring-line"}`}>
                      <Still setup={take.setup} flaw={take.flaw} nudge={take.nudge} />
                    </div>
                    <p className="mt-1 truncate text-[11px] text-faint">Take {take.take.split("-")[1]}</p>
                    <p className={`truncate text-[11.5px] ${decided && take.pick ? "font-medium text-good" : "text-muted"}`}>
                      {decided && take.pick ? "✓ " : ""}
                      {take.note}
                    </p>
                  </div>
                );
              })}
            {s.phase === "drop" && <p className="col-span-4 self-center text-[13px] text-faint">Wide, two close-ups, a few takes of each. Dropped in one go.</p>}
            {(s.phase === "cut" || s.phase === "done") && (
              <p key={s.phase === "cut" ? s.shot : "done"} className="col-span-4 animate-rise self-center text-[13.5px] text-muted">
                <span className="text-faint">Why this shot: </span>
                {SHOTS[s.phase === "cut" ? s.shot : SHOTS.length - 1].why}
              </p>
            )}
          </div>

          <div className="relative flex h-11 gap-[2px] overflow-hidden rounded-[10px] bg-surface-2">
            {SHOTS.map((shot, i) => (
              <div
                key={i}
                className={`relative h-full overflow-hidden transition-all duration-500 ${i < shotsIn ? "opacity-100" : "opacity-0"}`}
                style={{ flex: `${shot.secs} 0 0`, boxShadow: `inset 0 -3px 0 ${WHO_BAR[shot.setup]}` }}
              >
                <Still setup={shot.setup} nudge={shot.nudge} />
                {shot.reaction && <span className="absolute inset-x-0 top-0 h-[3px] bg-white/85" />}
              </div>
            ))}
            {head !== null && <span className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-tally shadow-[0_0_0_1px_rgba(255,255,255,.6)]" style={{ left: `${head * 100}%` }} />}
          </div>
          <div className="flex gap-4 text-[11.5px] text-faint">
            {(["maya", "danny"] as const).map((w) => (
              <span key={w} className="flex items-center gap-1.5">
                <i className="block h-[3px] w-3 rounded-full" style={{ background: WHO_BAR[w] }} /> {w === "maya" ? "Maya" : "Danny"}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <i className="block h-[3px] w-3 rounded-full bg-white ring-1 ring-line" /> Reaction
            </span>
            <span className="ml-auto hidden sm:inline">Opens in Premiere, every alternate stacked</span>
          </div>
        </div>

        <div className="font-[family-name:var(--font-script)] text-[13.5px] leading-[1.5] sm:text-[14.5px]">
          <p className="font-bold uppercase">INT. DINER – NIGHT</p>
          <p className="mb-3 mt-2 text-muted">Rain on the window. MAYA turns an empty ring box over in her hands. DANNY watches it.</p>
          <div className="grid gap-1">
            {LINES.map((line, i) => {
              const take = picked(i);
              const done = i < linesDone;
              const on = i === activeLine;
              return (
                <div
                  key={i}
                  className={`grid grid-cols-[64px_minmax(0,1fr)] gap-3 rounded-[12px] p-2 transition-all duration-300 ${on ? "bg-bg" : ""} ${activeLine >= 0 && !on ? "opacity-45" : ""}`}
                >
                  <div className={`transition-all duration-500 ${done ? "opacity-100" : "scale-90 opacity-0"}`}>
                    <div className={`aspect-[2.4/1] overflow-hidden rounded-[4px] ${on && s.phase === "cut" ? "ring-2 ring-tally" : "ring-1 ring-line"}`}>
                      <Still setup={take.setup} nudge={take.nudge} />
                    </div>
                    <p className="mt-0.5 font-sans text-[10px] text-faint">Take {take.take.split("-")[1]}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-center">{line.who}</p>
                    <p className="mx-auto max-w-[30ch]">{line.text}</p>
                    {done && on && <p className="mt-1 animate-rise font-sans text-[12px] leading-snug text-good">{line.why}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <ol className="mt-6 grid gap-x-5 gap-y-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((st, i) => (
          <li key={st.h}>
            <button
              type="button"
              onClick={() => (setT(st.at), setPlaying(true))}
              className={`grid w-full gap-1 text-left transition-opacity ${i === step || s.phase === "done" ? "opacity-100" : "opacity-50 hover:opacity-80"}`}
            >
              <span className="flex items-center gap-2 text-[12.5px] text-faint">
                <span className={`grid size-5 place-items-center rounded-full text-[11px] ${i < step || s.phase === "done" ? "bg-good text-white" : i === step ? "bg-text text-white" : "bg-surface-2"}`}>
                  {i < step || s.phase === "done" ? "✓" : i + 1}
                </span>
              </span>
              <span className="text-[15.5px] font-semibold tracking-[-0.015em]">{st.h}</span>
              <span className="text-[13.5px] text-muted">{st.p}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-3 rounded-[16px] bg-bg p-4 sm:p-5" aria-hidden="true">
        {[
          { who: "Loupe", time: "a few minutes", fill: progress, note: progress >= 1 ? "Done. You were getting a coffee." : "Working…", ink: true },
          {
            who: "By hand",
            time: "about 3 hours 20 minutes",
            fill: (progress * LOUPE_MINUTES) / HAND_MINUTES,
            note: `${Math.round(progress * LOUPE_MINUTES)} min in: ${handDoing(progress * LOUPE_MINUTES)}`,
            ink: false,
          },
        ].map((r) => (
          <div key={r.who} className="grid gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
              <span>
                <b className="font-semibold">{r.who}</b> <span className="text-faint">· {r.time}</span>
              </span>
              <span className={`tabular-nums ${r.ink && progress >= 1 ? "font-medium text-good" : "text-faint"}`}>{r.note}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div className={`h-full rounded-full ${r.ink ? (progress >= 1 ? "bg-good" : "bg-text") : "bg-faint"}`} style={{ width: `${Math.max(r.ink ? 0 : 0.6, r.fill * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
