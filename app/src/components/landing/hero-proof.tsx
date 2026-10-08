"use client";

import { useEffect, useRef, useState } from "react";
import { Loupe, type LoupeMood } from "@/components/loupe/loupe";

// The hero's before/after cards, with Loupe getting rid of the "before" himself: he hops onto "3 hours" and squashes
// it, snips "$195" in half with his scissors, and walks across "14 takes" drawing the red line behind him; each time
// the new number pops in. Then he hops back up, waits, and does it again. Runs only while on screen; with less
// motion asked for, it shows the result and Loupe just watches.

type How = "crush" | "cut" | "cross";
const CARDS: { was: string; now: string; what: string; how: How }[] = [
  { was: "3 hours", now: "5–10 min", what: "for a first cut of a 2–3 minute scene. It works while you get a coffee.", how: "crush" },
  { was: "$195", now: "$39", what: "a scene. Three hours of a mid-level editor at $65 an hour, against Loupe. Studios pay $25.", how: "cut" },
  { was: "14 takes", now: "1 click", what: "to hear every take of a line, back to back. No scrubbing.", how: "cross" },
];

const SIZE = 64;
const TALL = Math.round(SIZE * 1.1);
type Stage = "old" | "hit" | "done";
type Spot = { x: number; y: number; hop: boolean; ms: number };

export function HeroProof() {
  const box = useRef<HTMLDivElement>(null);
  const was = useRef<(HTMLSpanElement | null)[]>([]);
  const [stages, setStages] = useState<Stage[]>(["old", "old", "old"]);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [hops, setHops] = useState(0);
  const [mood, setMood] = useState<LoupeMood>("idle");
  const [squash, setSquash] = useState(0);
  const [snip, setSnip] = useState(false);

  useEffect(() => {
    const host = box.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    // Where Loupe stands: on top of a card's old number (left, middle or right of it), or resting top right.
    const at = (i: number | null, where: "left" | "mid" | "right" = "mid"): { x: number; y: number } => {
      const b = host.getBoundingClientRect();
      if (i === null) return { x: b.width - SIZE - 6, y: -TALL - 4 };
      const r = was.current[i]!.getBoundingClientRect();
      const x = where === "left" ? r.left - SIZE * 0.45 : where === "right" ? r.right - SIZE * 0.75 : r.left + r.width / 2 - SIZE / 2;
      return { x: x - b.left, y: r.top - b.top - TALL + 3 };
    };
    const go = (to: { x: number; y: number }, hop: boolean, ms: number) => {
      setSpot({ ...to, hop, ms });
      if (hop) setHops((h) => h + 1);
    };
    const stage = (i: number, s: Stage) => setStages((all) => all.map((x, k) => (k === i ? s : x)));

    // The beats in order, each with how long it plays before the next starts. Each beat is timed from the one
    // before, so a busy moment (the 3D Loupes loading) only delays the act rather than bunching it up.
    const beats: [() => void, number][] = [
      [() => (setStages(["old", "old", "old"]), setSnip(false), setMood("idle"), go(at(null), false, 0)), 900],
    ];
    CARDS.forEach((card, i) => {
      if (card.how === "cross") {
        beats.push([() => (setMood("think"), go(at(i, "left"), true, 650)), 750]);
        beats.push([() => (stage(i, "hit"), go(at(i, "right"), false, 700)), 750]);
      } else {
        beats.push([() => (setMood("think"), go(at(i), true, 650)), 680]);
        beats.push([() => (stage(i, "hit"), card.how === "crush" ? setSquash((n) => n + 1) : setSnip(true)), 450]);
      }
      beats.push([() => (setSnip(false), stage(i, "done"), setMood("happy")), 550]);
    });
    beats.push([() => go(at(null), true, 700), 900]);
    // Rest a while, then do it again.
    beats.push([() => setMood("idle"), 6000]);

    const play = (n: number) => {
      const [beat, ms] = beats[n];
      beat();
      timer = setTimeout(() => play((n + 1) % beats.length), ms);
    };

    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      ([e]) => {
        if (calm) {
          setStages(["done", "done", "done"]);
          setSpot({ ...at(null), hop: false, ms: 0 });
          return io.disconnect();
        }
        if (e.isIntersecting && !running) {
          running = true;
          play(0);
        } else if (!e.isIntersecting && running) {
          running = false;
          clearTimeout(timer);
        }
      },
      { threshold: 0.2 },
    );
    io.observe(host);
    const onResize = () => setSpot((s) => (s ? { ...at(null), hop: false, ms: 0 } : s));
    window.addEventListener("resize", onResize);
    return () => {
      io.disconnect();
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div ref={box} className="relative mt-[84px] md:mt-0">
      <dl className="grid gap-3">
        {CARDS.map((b, i) => {
          const s = stages[i];
          const hit = s !== "old";
          return (
            <div key={b.now} className="rounded-[18px] bg-surface px-5 py-4 shadow-lift-sm ring-1 ring-line">
              <dt className="flex items-baseline gap-2.5">
                <span
                  ref={(el) => {
                    was.current[i] = el;
                  }}
                  className={`relative inline-block text-[15px] transition-colors duration-300 ${hit ? "text-faint" : "text-muted"}`}
                >
                  {b.how === "cut" ? (
                    <>
                      <span className="invisible">{b.was}</span>
                      <span
                        className="absolute inset-0 transition-transform duration-500 [clip-path:inset(0_0_50%_0)]"
                        style={{ transform: hit ? "translate(-2px,-3px) rotate(-6deg)" : "none" }}
                      >
                        {b.was}
                      </span>
                      <span
                        className="absolute inset-0 transition-transform duration-500 [clip-path:inset(50%_0_0_0)]"
                        style={{ transform: hit ? "translate(3px,3px) rotate(5deg)" : "none" }}
                      >
                        {b.was}
                      </span>
                    </>
                  ) : (
                    <span
                      key={b.how === "crush" ? `${s}` : undefined}
                      className={`inline-block origin-bottom ${b.how === "crush" && s === "hit" ? "animate-[squish_450ms_ease-out_both]" : ""}`}
                    >
                      {b.was}
                    </span>
                  )}
                  <span
                    className="absolute left-0 top-[55%] h-[2px] rounded-full bg-tally"
                    style={{
                      width: hit ? "100%" : "0%",
                      transition: hit ? `width ${b.how === "cross" ? 700 : 250}ms ${b.how === "cross" ? "linear" : "ease-out"}` : "none",
                    }}
                  />
                </span>
                <span
                  className={`text-[clamp(30px,3.2vw,40px)] font-light leading-none tracking-[-0.05em] tabular-nums transition-all duration-300 ${s === "done" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
                >
                  {b.now}
                </span>
              </dt>
              <dd className="mt-1.5 text-[13.5px] text-muted">{b.what}</dd>
            </div>
          );
        })}
      </dl>

      {spot && (
        <div
          className="pointer-events-none absolute left-0 top-0 z-10"
          style={{ transform: `translate(${spot.x}px, ${spot.y}px)`, transition: `transform ${spot.ms}ms ${spot.hop ? "cubic-bezier(.4,0,.3,1)" : "linear"}` }}
          aria-hidden="true"
        >
          <div key={`h${hops}`} className={hops ? "animate-[hop_650ms_ease-out_both]" : ""}>
            <div key={`s${squash}`} className={`origin-bottom ${squash ? "animate-[stomp_450ms_ease-out_both]" : ""}`}>
              <div className={`origin-bottom transition-transform duration-150 ${snip ? "rotate-[-8deg] scale-105" : ""}`}>
                <Loupe size={SIZE} mood={mood} dept="edit" three ticklish={false} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
