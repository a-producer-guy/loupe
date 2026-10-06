"use client";

import { useState } from "react";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** What each plan would cost for this many scenes a month. */
function plans(n: number) {
  return [
    { name: "Indie", cost: n * 39, how: `${n} scene${n > 1 ? "s" : ""} at $39` },
    { name: "Pro", cost: 199 + Math.max(0, n - 10) * 39, how: `$199 for 10 scenes${n > 10 ? ` + ${n - 10} at $39` : ""}` },
    { name: "Studio", cost: 1500 + Math.max(0, n - 60) * 25, how: `$1,500 for up to 60 scenes${n > 60 ? ` + ${n - 60} at $25` : ""}` },
  ];
}

/** Scenes a month × what an edit costs today, against the cheapest plan. */
export function Savings() {
  const [scenes, setScenes] = useState(50);
  const [cost, setCost] = useState(60);
  const [hours, setHours] = useState(3);
  const [polish, setPolish] = useState(false);

  const today = scenes * cost;
  const polishCost = polish ? (scenes * cost) / 3 : 0;
  const best = plans(scenes).sort((a, b) => a.cost - b.cost)[0];
  const save = today - best.cost - polishCost;
  const hoursBack = Math.round(scenes * hours * (polish ? 2 / 3 : 1));

  const slider = (id: string, label: string, value: string, input: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id} className="mb-2.5 flex items-baseline justify-between text-[14px] text-muted">
        {label} <b className="text-[22px] font-medium tracking-[-0.02em] text-text tabular-nums">{value}</b>
      </label>
      <input id={id} type="range" className="w-full accent-text" {...input} />
    </div>
  );

  return (
    <div className="grid overflow-hidden rounded-[20px] bg-surface shadow-lift md:grid-cols-2">
      <div className="grid content-start gap-6 p-7">
        {slider("scenes", "Scenes you cut a month", String(scenes), { min: 1, max: 150, value: scenes, onChange: (e) => setScenes(+e.target.value) })}
        {slider("cost", "What an edit costs you now, per scene", `$${cost}`, { min: 20, max: 300, step: 5, value: cost, onChange: (e) => setCost(+e.target.value) })}
        {slider("hours", "Hours each first cut takes by hand", String(hours), { min: 1, max: 8, step: 0.5, value: hours, onChange: (e) => setHours(+e.target.value) })}
        <label className="flex cursor-pointer items-start gap-3 text-[14px] text-muted">
          <input type="checkbox" checked={polish} onChange={(e) => setPolish(e.target.checked)} className="mt-1 accent-text" />
          An editor still polishes each cut. We&apos;ll count a third of today&apos;s cost for that.
        </label>
      </div>
      <div className="grid content-start gap-4 bg-text p-7 text-white" aria-live="polite">
        <div>
          <p className="text-[13px] text-white/55">You&apos;d save every month</p>
          <p className="text-[clamp(46px,5.4vw,70px)] font-light leading-none tracking-[-0.05em] tabular-nums">
            {money(Math.max(0, save))}
            <span className="ml-1.5 text-[16px] tracking-normal text-white/60">a month</span>
          </p>
        </div>
        <div className="grid gap-2 border-t border-white/15 pt-4 text-[14px]">
          {[
            ["Editing today", money(today)],
            ["Loupe", money(best.cost)],
            ["Editor polish", money(polishCost)],
            ["Saved a year", money(Math.max(0, save) * 12)],
            ["Hours back a month", `${hoursBack} h`],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 text-white/70">
              <span>{k}</span>
              <b className="font-medium text-white tabular-nums">{v}</b>
            </div>
          ))}
        </div>
        <p className="text-[13.5px] text-white/75">
          {save > 0 ? (
            <>
              Best plan: <b className="font-medium text-white">{best.name}</b> · {best.how} · about {money(best.cost / scenes)} a scene
            </>
          ) : (
            <>
              At this volume the saving is your time: about {Math.round(scenes * hours)} hours a month. Best plan: <b className="font-medium text-white">{best.name}</b>.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
