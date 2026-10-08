"use client";

import { ArrowUp, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEPT_COLOR, Loupe, type LoupeDept, type LoupeMood } from "@/components/loupe/loupe";
import { Still } from "./still";

// The landing page's "then you give notes": Loupe's four hats (3D), and under them the cutting room's command bar
// with a note being typed for each one and the picture changing when Loupe's done: a different take, rain outside,
// a warmer grade, or (Preview) an answer and nothing changed. Plays through the hats by itself; a click on a hat or
// a suggestion plays that one. Pauses off screen; with less motion it shows each result without the typing.

type Hat = { dept: LoupeDept; name: string; key: string; does: string; note: string; scope: string; reply: string; sugs: string[] };

const HATS: Hat[] = [
  {
    dept: "edit",
    name: "Edit",
    key: "⌥1",
    does: "Takes, timing, reactions",
    note: "Different take, more hurt",
    scope: "This line",
    reply: "Swapped to take 4. She’s quieter, and it hurts more. Take 3 is one click away.",
    sugs: ["Different take", "Add a reaction", "Tighter"],
  },
  {
    dept: "sound",
    name: "Sound",
    key: "⌥2",
    does: "Dialogue, room tone, atmosphere",
    note: "Rain outside the window",
    scope: "Whole scene",
    reply: "Rain’s outside the window now, tucked under every line.",
    sugs: ["Rain outside", "Add a score", "Cleaner dialogue"],
  },
  {
    dept: "color",
    name: "Color",
    key: "⌥3",
    does: "Warmth, contrast, matching shots",
    note: "Warmer, deeper shadows",
    scope: "Whole scene",
    reply: "Warmer, with deeper shadows. Skin kept natural. The same grade goes to Premiere.",
    sugs: ["Warmer", "Cooler", "Film look"],
  },
  {
    dept: "preview",
    name: "Preview",
    key: "⌥4",
    does: "Watch and ask. Nothing changes.",
    note: "Why this take?",
    scope: "This line",
    reply: "In take 3 she waits a beat before “river”. Take 1 says “lake” and take 2 is soft. Nothing changed.",
    sugs: ["Why this take?", "Which line is weakest?", "How long is it?"],
  },
];

const TYPE_AT = 0.5;
const PER_CHAR = 0.05;
const WORK = 1.1;
const HOLD = 3.4;
const sentAt = (h: Hat) => TYPE_AT + h.note.length * PER_CHAR + 0.35;
const doneAt = (h: Hat) => sentAt(h) + WORK;
const endAt = (h: Hat) => doneAt(h) + HOLD;

export function DirectDemo() {
  const [index, setIndex] = useState(0);
  const [t, setT] = useState(0);
  const [seen, setSeen] = useState(false);
  const [calm, setCalm] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // One clock: the current hat's time, moving on to the next hat when this one's had its moment (only while
  // playing by itself). Kept in a ref so the timer doesn't restart on every tick.
  const clock = useRef({ t: 0, index: 0, auto: true, calm: false });
  const hat = HATS[index];

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        clock.current.calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
        setCalm(clock.current.calm);
        setSeen(e.isIntersecting);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const c = clock.current;
      c.t += (now - last) / 1000;
      last = now;
      if (c.t >= endAt(HATS[c.index]) + (c.calm ? 2 : 0) && c.auto) {
        c.index = (c.index + 1) % HATS.length;
        c.t = 0;
        setIndex(c.index);
      }
      setT(c.t);
    }, 50);
    return () => clearInterval(timer);
  }, [seen]);

  const play = (i: number) => {
    clock.current = { ...clock.current, t: 0, index: i, auto: false };
    setIndex(i);
    setT(0);
  };

  const now = calm ? endAt(hat) : t;
  const typed = hat.note.slice(0, Math.max(0, Math.floor((now - TYPE_AT) / PER_CHAR)));
  const sent = now >= sentAt(hat);
  const done = now >= doneAt(hat);
  const mood: LoupeMood = done ? "happy" : sent ? "think" : typed ? "listen" : "idle";
  const color = DEPT_COLOR[hat.dept];

  const after = done && hat.dept !== "preview";
  const grade = after && hat.dept === "color" ? "sepia(0.5) saturate(1.6) contrast(1.25) brightness(0.9) hue-rotate(-10deg)" : "none";

  return (
    <div ref={box} className="grid gap-5 [&>*]:min-w-0">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 lg:grid-cols-4">
        {HATS.map((h, i) => (
          <button
            key={h.dept}
            type="button"
            onClick={() => play(i)}
            aria-pressed={i === index}
            className={`grid min-w-0 justify-items-start gap-1.5 rounded-[18px] bg-surface p-4 text-left shadow-lift-sm transition sm:p-5 ${i === index ? "ring-2" : "ring-1 ring-line hover:shadow-lift"}`}
            style={i === index ? { ["--tw-ring-color" as string]: h.dept === "preview" ? "#161614" : DEPT_COLOR[h.dept] } : undefined}
          >
            <Loupe size={76} dept={h.dept} mood={i === index ? mood : "idle"} three label={`Loupe in ${h.name} mode`} />
            <span className="mt-1 flex items-center gap-2 text-[16px] font-semibold">
              {h.name}
              <kbd className="rounded-[5px] bg-bg px-1.5 font-mono text-[11px] font-normal text-faint ring-1 ring-line">{h.key}</kbd>
            </span>
            <span className="text-[13.5px] text-muted">{h.does}</span>
            <span className="break-words font-mono text-[12px] text-faint">“{h.note.toLowerCase()}”</span>
          </button>
        ))}
      </div>

      <div className="rounded-[28px] bg-surface p-4 shadow-lift sm:p-6" aria-hidden="true">
        <div className="relative mx-auto aspect-[2.4/1] max-w-[860px] overflow-hidden rounded-[16px] bg-[#121210] shadow-lift">
          <div className="absolute inset-0 transition-[filter] duration-700" style={{ filter: grade }}>
            <Still key={after && hat.dept === "edit" ? "t4" : "t3"} setup="maya" nudge={after && hat.dept === "edit" ? 5 : -3} className={after && hat.dept === "edit" ? "animate-rise" : ""} />
          </div>
          {after && hat.dept === "color" && <div className="absolute inset-0 animate-rise bg-[#ff9a3c]/10 mix-blend-soft-light" />}
          {after && hat.dept === "sound" && (
            <div className="absolute inset-0 animate-rise bg-[repeating-linear-gradient(104deg,transparent_0_7px,rgba(255,255,255,.45)_7px_8px,transparent_8px_23px)] bg-[length:240px_240px] opacity-25 motion-safe:animate-[rainfall_.55s_linear_infinite]" />
          )}
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[11.5px] text-text shadow-lift-sm">
            <i className="block size-1.5 rounded-full bg-tally" />
            {after && hat.dept === "edit" ? "2B-4 · Maya, close" : "2B-3 · Maya, close"}
          </span>
          {after && (
            <span key={hat.dept} className="absolute right-3 top-3 animate-rise rounded-full px-2.5 py-1 text-[11.5px] font-medium text-white shadow-lift-sm" style={{ background: color }}>
              {hat.dept === "edit" ? "Take 3 → Take 4" : hat.dept === "sound" ? "♪ Rain, outside" : "Graded"}
            </span>
          )}
          <p className="absolute inset-x-[8%] bottom-[9%] text-balance text-center text-[clamp(12px,1.5vw,17px)] font-medium leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,.85)]">
            I kept the box. The ring’s in the river.
          </p>
        </div>

        <div className="mx-auto mt-5 grid max-w-[720px] grid-cols-[minmax(0,1fr)] gap-2">
          <div className="flex min-h-[38px] items-end justify-center">
            {sent && (
              <div key={`${hat.dept}-${done}`} className="flex max-w-full animate-rise flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[12px] bg-text px-3.5 py-2 text-[13px] text-white shadow-lift">
                <b className="font-medium">Loupe</b>
                <span>{done ? hat.reply : `On it… The cut you see stays until the new one’s ready.`}</span>
              </div>
            )}
            {!sent && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {hat.sugs.map((s) => (
                  <span key={s} className="rounded-full bg-surface px-3 py-1.5 text-[12.5px] text-muted shadow-lift-sm ring-1 ring-line">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div
            className="flex items-center gap-2.5 rounded-[16px] bg-white/95 py-2 pl-3 pr-2 shadow-[0_14px_40px_rgba(20,20,18,.13)] ring-1 ring-line transition-shadow sm:gap-3"
            style={typed && !sent ? { boxShadow: `0 0 0 1.5px ${color}, 0 14px 40px rgba(20,20,18,.13)` } : undefined}
          >
            <Loupe size={30} dept={hat.dept} mood={mood} ticklish={false} />
            <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] bg-surface px-2.5 text-[13px] font-medium shadow-[0_0_0_1px_var(--line-strong)]">
              <i className="block size-2 rounded-full" style={{ background: color }} />
              {hat.name}
              <ChevronUp className="size-3 opacity-55" />
            </span>
            <span className={`min-w-0 flex-1 truncate py-2 text-[15px] ${typed && !sent ? "text-text" : "text-faint"}`}>
              {sent ? (hat.dept === "preview" ? "Ask Loupe about the cut…" : "Tell Loupe what to change…") : typed || (hat.dept === "preview" ? "Ask Loupe about the cut…" : "Tell Loupe what to change…")}
              {typed && !sent && <span className="ml-px inline-block h-[1.05em] w-px translate-y-[2px] animate-pulse bg-text" />}
            </span>
            <span className={`hidden h-8 shrink-0 items-center rounded-[10px] px-2.5 text-[12.5px] sm:inline-flex ${hat.scope === "This line" ? "bg-text text-white" : "bg-surface-2 text-muted"}`}>
              {hat.scope}
            </span>
            <span className={`grid size-9 shrink-0 place-items-center rounded-[11px] text-white transition ${typed && !sent ? "bg-text" : "bg-text/30"}`}>
              <ArrowUp className="size-4" />
            </span>
          </div>
          <p className="text-center text-[11.5px] text-faint">/ for commands · ⌥1–4 to switch hats</p>
        </div>
      </div>
    </div>
  );
}
