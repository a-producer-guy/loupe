"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEPT_COLOR, Loupe, type LoupeDept, type LoupeMood } from "@/components/loupe/loupe";

const HATS: { dept: LoupeDept; name: string }[] = [
  { dept: "edit", name: "Edit" },
  { dept: "sound", name: "Sound" },
  { dept: "color", name: "Color" },
  { dept: "preview", name: "Preview" },
];

/** Loupe trying on his hats: Edit, Sound, Color, Preview. Click one to pick it. */
export function HeroLoupe() {
  const [index, setIndex] = useState(0);
  const [mood, setMood] = useState<LoupeMood>("idle");
  const [auto, setAuto] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(0);

  // Putting on a new hat: a happy hop, then back to watching.
  const wear = useCallback((i: number) => {
    current.current = i;
    setIndex(i);
    setMood("happy");
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setMood("idle"), 700);
  }, []);

  useEffect(() => {
    if (!auto || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => wear((current.current + 1) % HATS.length), 3200);
    return () => clearInterval(timer);
  }, [auto, wear]);

  useEffect(() => () => clearTimeout(idleTimer.current), []);

  return (
    <div className="relative grid min-h-[380px] place-items-center">
      <div className="absolute bottom-[54px] h-[22px] w-[62%] rounded-[50%] bg-[radial-gradient(closest-side,rgba(20,20,18,0.08),transparent)]" />
      <div className="grid justify-items-center gap-3">
        <Loupe size={190} mood={mood} dept={HATS[index].dept} label="Loupe, your assistant editor" />
        <div className="relative z-10 mt-2 flex flex-wrap justify-center gap-1.5" role="group" aria-label="Loupe's modes">
          {HATS.map((hat, i) => (
            <button
              key={hat.dept}
              type="button"
              aria-pressed={i === index}
              onClick={() => {
                setAuto(false);
                wear(i);
              }}
              className={`inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-[12.5px] ${i === index ? "text-text ring-[1.5px] ring-text" : "text-muted ring-1 ring-line"}`}
            >
              <i className="block size-2 rounded-full" style={{ background: DEPT_COLOR[hat.dept] }} />
              {hat.name}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-faint">That&apos;s Loupe, your assistant editor. Hover to say hi.</p>
      </div>
    </div>
  );
}
