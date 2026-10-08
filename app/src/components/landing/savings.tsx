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

// What freelance editors charge an hour (Oct 2026 market rates): entry $20–45, mid-level $45–85, senior $85–150.
const RATES = [
  { name: "Entry", rate: 35 },
  { name: "Mid-level", rate: 65 },
  { name: "Senior", rate: 120 },
];

/** Scenes a month × an editor's hours × their rate, against the cheapest plan. */
export function Savings() {
  const [scenes, setScenes] = useState(50);
  const [rate, setRate] = useState(65);
  const [hours, setHours] = useState(3);
  const [polish, setPolish] = useState(false);

  const perScene = rate * hours;
  const today = scenes * perScene;
  const polishCost = polish ? today / 3 : 0;
  const best = plans(scenes).sort((a, b) => a.cost - b.cost)[0];
  const save = Math.max(0, today - best.cost - polishCost);
  const hoursBack = Math.round(scenes * hours * (polish ? 2 / 3 : 1));
  const daysBack = Math.round((hoursBack * 12) / 8);
  // About 230 working days in a year: past that, it's more than one person's time.
  const editors = daysBack / 230;

  const slider = (id: string, label: string, value: string, input: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id} className="mb-2.5 flex items-baseline justify-between gap-3 text-[14px] text-muted">
        {label} <b className="text-[22px] font-medium tracking-[-0.02em] text-text tabular-nums">{value}</b>
      </label>
      <input id={id} type="range" className="w-full rounded-full accent-text outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-text/25" {...input} />
    </div>
  );

  return (
    <div className="grid overflow-hidden rounded-[20px] bg-surface shadow-lift md:grid-cols-2">
      <div className="grid content-start gap-6 p-7">
        {slider("scenes", "Scenes you cut a month", String(scenes), { min: 1, max: 150, value: scenes, onChange: (e) => setScenes(+e.target.value) })}
        <div className="grid gap-2.5">
          {slider("rate", "An editor’s hourly rate (or what your time’s worth)", `$${rate}`, { min: 20, max: 150, step: 5, value: rate, onChange: (e) => setRate(+e.target.value) })}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Typical rates">
            {RATES.map((r) => (
              <button
                key={r.name}
                type="button"
                aria-pressed={rate === r.rate}
                onClick={() => setRate(r.rate)}
                className={`rounded-full px-3 py-1 text-[12.5px] transition ${rate === r.rate ? "bg-text text-white" : "bg-bg text-muted ring-1 ring-line hover:text-text"}`}
              >
                {r.name} ${r.rate}
              </button>
            ))}
          </div>
        </div>
        {slider("hours", "Hours each first cut takes by hand", String(hours), { min: 1, max: 8, step: 0.5, value: hours, onChange: (e) => setHours(+e.target.value) })}
        <label className="flex cursor-pointer items-start gap-3 text-[14px] text-muted">
          <input type="checkbox" checked={polish} onChange={(e) => setPolish(e.target.checked)} className="mt-1 accent-text" />
          An editor still polishes each cut. We&apos;ll count a third of today&apos;s cost for that.
        </label>
        <p className="text-[12.5px] text-faint">
          Freelance editors charge $20–150 an hour: about $20–45 entry-level, $45–85 mid-level, $85–150 senior. A first assembly takes 2–4 hours a scene.
        </p>
      </div>
      <div className="grid content-start gap-5 bg-text p-7 text-white" aria-live="polite">
        <div className="grid gap-5">
          <div>
            <p className="text-[13px] text-white/55">Back in your pocket</p>
            <p className="whitespace-nowrap text-[clamp(44px,5.2vw,68px)] font-light leading-none tracking-[-0.05em] tabular-nums">{money(save * 12)}</p>
            <p className="mt-1 text-[13px] text-white/60">a year · {money(save)} a month</p>
          </div>
          <div>
            <p className="text-[13px] text-white/55">Back on your calendar</p>
            <p className="whitespace-nowrap text-[clamp(44px,5.2vw,68px)] font-light leading-none tracking-[-0.05em] tabular-nums">{daysBack.toLocaleString("en-US")}</p>
            <p className="mt-1 text-[13px] text-white/60">
              working days a year · {editors < 1 ? `${hoursBack.toLocaleString("en-US")} h a month` : editors < 1.5 ? "a full-time editor’s worth" : `${Math.round(editors)} full-time editors’ worth`}
            </p>
          </div>
        </div>
        <div className="grid gap-2 border-t border-white/15 pt-4 text-[14px]">
          {[
            ["One scene by hand", `${money(perScene)}  (${hours} h × $${rate})`],
            ["One scene with Loupe", `about ${money(best.cost / scenes)}`],
            ["Editing today, a month", money(today)],
            ["Loupe, a month", money(best.cost)],
            ...(polish ? [["Editor polish, a month", money(polishCost)]] : []),
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 text-white/70">
              <span>{k}</span>
              <b className="whitespace-pre font-medium text-white tabular-nums">{v}</b>
            </div>
          ))}
        </div>
        <p className="text-[13.5px] text-white/75">
          {save > 0 ? (
            <>
              Best plan: <b className="font-medium text-white">{best.name}</b> · {best.how}
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
