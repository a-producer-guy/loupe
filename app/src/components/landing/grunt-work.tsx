"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Snip } from "./snip";

// Everything an assistant editor does by hand before the creative part starts, and how long it takes, snipped off
// one by one as the list comes into view: the time adds up, then goes to nothing.

const CHORES: { by: string; mins: number; loupe: string }[] = [
  { by: "Babysit the upload, re-copy what failed", mins: 15, loupe: "Picks up where it left off. Drop the folder again and only what’s missing goes up." },
  { by: "Make proxies in Media Encoder so it plays smoothly", mins: 20, loupe: "Made while it uploads. No Media Encoder, no presets." },
  { by: "Log every take, label every setup", mins: 20, loupe: "Every take sorted by shot" },
  { by: "Find each line in every take", mins: 30, loupe: "Lined up with your script" },
  { by: "Watch every take, pick the best read", mins: 45, loupe: "Picked, with a reason you can read" },
  { by: "Cut out slates, restarts and flubs", mins: 10, loupe: "Never in the cut" },
  { by: "Build the scene: reactions, J and L cuts, no jump cuts", mins: 30, loupe: "Cut the way an editor would" },
  { by: "Clean the dialogue, lay room tone", mins: 20, loupe: "Clean and even, with the room under it" },
  { by: "Stack the alternates in Premiere for your editor", mins: 10, loupe: "Every alternate one track up" },
];

const TOTAL = CHORES.reduce((s, c) => s + c.mins, 0);
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${m} min`);
const STEP = 260;

export function GruntWork() {
  const [on, setOn] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setOn(true), io.disconnect()), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={box} className="overflow-hidden rounded-[20px] bg-surface shadow-lift">
      <ul className="grid">
        {CHORES.map((c, i) => (
          <li key={c.by} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 border-b border-line px-5 py-3.5 sm:px-6">
            <span className={`text-[15px] transition-colors duration-500 motion-reduce:transition-none ${on ? "text-faint" : "text-text"}`} style={{ transitionDelay: `${i * STEP}ms` }}>
              {c.by}
            </span>
            <span
              className={`text-right text-[13.5px] tabular-nums transition-colors duration-500 motion-reduce:transition-none ${on ? "text-faint" : "text-muted"}`}
              style={{ transitionDelay: `${i * STEP}ms` }}
            >
              <Snip cut={on} delay={i * STEP} seed={i}>
                {hm(c.mins)}
              </Snip>
            </span>
            <span
              className={`col-span-2 flex items-start gap-1.5 text-[13.5px] font-medium text-good transition-all duration-500 motion-reduce:transition-none ${on ? "opacity-100" : "-translate-y-1 opacity-0"}`}
              style={{ transitionDelay: `${i * STEP + 150}ms` }}
            >
              <Check className="mt-0.5 size-3.5 shrink-0" /> {c.loupe}
            </span>
          </li>
        ))}
      </ul>
      <div className="grid gap-1 bg-text px-5 py-5 text-white sm:px-6">
        <div className="flex items-baseline justify-between gap-4 text-[14px] text-white/60">
          <span>By hand, every scene</span>
          <span className="tabular-nums">
            <Snip cut={on} delay={CHORES.length * STEP} seed={CHORES.length}>
              {hm(TOTAL)}
            </Snip>
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[17px] font-semibold">Grunt work left for you</span>
          <span
            className={`text-[clamp(30px,3.6vw,44px)] font-light leading-none tracking-[-0.04em] tabular-nums transition-opacity duration-700 motion-reduce:transition-none ${on ? "opacity-100" : "opacity-0"}`}
            style={{ transitionDelay: `${CHORES.length * STEP}ms` }}
          >
            0 min
          </span>
        </div>
      </div>
    </div>
  );
}
