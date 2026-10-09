"use client";

import { useState } from "react";
import { DEPT_COLOR, Loupe, type LoupeDept } from "@/components/loupe/loupe";

// Loupe's four hats, the modes of the command bar, each with a note you might give in it. He perks up when you point
// at him.

const HATS: { dept: LoupeDept; name: string; key: string; does: string; say: string }[] = [
  { dept: "edit", name: "Edit", key: "⌥1", does: "Takes, timing, reactions", say: "different take, more hurt" },
  { dept: "sound", name: "Sound", key: "⌥2", does: "Dialogue, room tone, atmosphere", say: "rain outside the window" },
  { dept: "color", name: "Color", key: "⌥3", does: "Warmth, contrast, matching shots", say: "warmer, deeper shadows" },
  { dept: "preview", name: "Preview", key: "⌥4", does: "Watch and ask. Nothing changes.", say: "why this take?" },
];

export function Hats() {
  const [over, setOver] = useState<LoupeDept | null>(null);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 lg:grid-cols-4">
      {HATS.map((h) => (
        <div
          key={h.dept}
          onPointerEnter={() => setOver(h.dept)}
          onPointerLeave={() => setOver(null)}
          className="grid min-w-0 justify-items-start gap-1.5 rounded-[18px] bg-surface p-4 shadow-lift-sm ring-1 ring-line transition hover:shadow-lift sm:p-5"
          style={over === h.dept ? { ["--tw-ring-color" as string]: h.dept === "preview" ? "#161614" : DEPT_COLOR[h.dept] } : undefined}
        >
          <Loupe size={76} dept={h.dept} mood={over === h.dept ? "happy" : "idle"} three label={`Loupe in ${h.name} mode`} />
          <span className="mt-1 flex items-center gap-2 text-[16px] font-semibold">
            {h.name}
            <kbd className="rounded-[5px] bg-bg px-1.5 font-mono text-[11px] font-normal text-faint ring-1 ring-line">{h.key}</kbd>
          </span>
          <span className="text-[13.5px] text-muted">{h.does}</span>
          <span className="break-words font-mono text-[12px] text-faint">“{h.say}”</span>
        </div>
      ))}
    </div>
  );
}
