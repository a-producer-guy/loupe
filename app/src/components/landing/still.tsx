import { useId } from "react";

// A frame from the landing page's demo scene (INT. DINER, NIGHT), drawn in SVG so no one's footage is used: a wide
// of the booth, and a close-up of each actor in tungsten light with the rainy window behind. Scope (2.4:1), the
// way narrative is shot. A take can carry the faults Loupe catches: the boom dipping in, or soft focus.

export type Setup = "wide" | "maya" | "danny";
export type Flaw = "boom" | "soft";

const SKIN = "#2e1d14";
const DARK = "#0f0b09";
const HAIR = "#120d0a";
const RIM = "#8fb3dc";

export function Still({ setup, flaw, nudge = 0, className = "" }: { setup: Setup; flaw?: Flaw; nudge?: number; className?: string }) {
  const id = useId().replace(/[^\w-]/g, "");
  const u = (k: string) => `url(#${id}${k})`;
  return (
    <svg viewBox="0 0 240 100" preserveAspectRatio="xMidYMid slice" className={`block size-full ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#17120f" />
          <stop offset="1" stopColor="#3a2518" />
        </linearGradient>
        <radialGradient id={`${id}vig`} cx="0.5" cy="0.5" r="0.75">
          <stop offset="0.55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.7" />
        </radialGradient>
        <radialGradient id={`${id}key`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#d99c6c" stopOpacity="0.95" />
          <stop offset="1" stopColor="#d99c6c" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}soft`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        <filter id={`${id}bokeh`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
      </defs>
      <rect width="240" height="100" fill={u("bg")} />
      <g filter={flaw === "soft" ? u("soft") : undefined}>
        {setup === "wide" ? <Wide nudge={nudge} bokeh={u("bokeh")} keyLight={u("key")} /> : <Close who={setup} nudge={nudge} bokeh={u("bokeh")} keyLight={u("key")} />}
      </g>
      {flaw === "boom" && (
        <g>
          <rect x="158" y="-14" width="3" height="16" fill="#3a3834" />
          <rect x="138" y="-3" width="34" height="12" rx="6" fill="#5f5d57" />
          <rect x="138" y="-3" width="34" height="12" rx="6" fill="none" stroke="#7a7871" strokeWidth="0.8" strokeDasharray="1.5 1.5" />
        </g>
      )}
      <rect width="240" height="100" fill={u("vig")} />
    </svg>
  );
}

type Paint = { nudge: number; bokeh: string; keyLight: string };

/** The booth from across the diner: rain on the window, a pendant light over the table, the two of them. */
function Wide({ nudge, bokeh, keyLight }: Paint) {
  return (
    <>
      <rect x="34" y="6" width="172" height="58" fill="#15212c" />
      {Array.from({ length: 22 }, (_, i) => (
        <line key={i} x1={40 + i * 7.6} y1={8 + ((i * 13) % 20)} x2={38.5 + i * 7.6} y2={22 + ((i * 13) % 20)} stroke={RIM} strokeOpacity="0.22" strokeWidth="0.5" />
      ))}
      <g filter={bokeh}>
        <circle cx="62" cy="34" r="4" fill="#f0b35a" opacity="0.5" />
        <circle cx="190" cy="22" r="5" fill="#e2452b" opacity="0.65" />
        <circle cx="176" cy="44" r="3.5" fill="#6f9fd8" opacity="0.5" />
      </g>
      <rect x="20" y="40" width="44" height="40" rx="4" fill="#24150e" />
      <rect x="176" y="40" width="44" height="40" rx="4" fill="#24150e" />
      <line x1="120" y1="0" x2="120" y2="20" stroke="#0c0907" strokeWidth="0.8" />
      <circle cx="120" cy="24" r="22" fill={keyLight} opacity="0.35" />
      <path d="M113 22 h14 l-3 -5 h-8 z" fill="#d8a46e" />
      <Figure hx={88 + nudge} hy={47} scale={0.36} dir={1} long keyLight={keyLight} />
      <Figure hx={152 + nudge} hy={47} scale={0.36} dir={-1} keyLight={keyLight} />
      <rect x="28" y="70" width="184" height="30" fill="#2a1a10" />
      <rect x="28" y="70" width="184" height="1.4" fill="#7a4e2c" />
      <rect x="102" y="64" width="6" height="7" rx="1" fill="#d9d2c6" />
      <rect x="133" y="64" width="6" height="7" rx="1" fill="#d9d2c6" />
    </>
  );
}

/** One actor in close-up, framed on a third, looking across at the other; the window's lights out of focus behind. */
function Close({ who, nudge, bokeh, keyLight }: Paint & { who: "maya" | "danny" }) {
  const maya = who === "maya";
  const side = maya ? 1 : -1;
  const lights = maya
    ? [[176, 26, 9, "#f0b35a", 0.45], [204, 52, 6, "#e2452b", 0.6], [158, 62, 5, "#6f9fd8", 0.45], [222, 18, 4, "#f0b35a", 0.35]]
    : [[60, 30, 8, "#6f9fd8", 0.5], [30, 56, 7, "#f0b35a", 0.4], [84, 64, 4, "#e2452b", 0.55], [18, 20, 4, "#f0b35a", 0.35]];
  return (
    <>
      <rect x={maya ? 120 : 0} y="0" width="120" height="78" fill="#15212c" opacity="0.55" />
      <g filter={bokeh}>
        {lights.map(([x, y, r, c, o], i) => (
          <circle key={i} cx={x as number} cy={y as number} r={r as number} fill={c as string} opacity={o as number} />
        ))}
      </g>
      <Figure hx={(maya ? 78 : 162) + nudge} hy={46} scale={1} dir={side} long={maya} keyLight={keyLight} />
    </>
  );
}

/** Head and shoulders in silhouette: a warm key on the face from the pendant, a cool rim from the window behind. */
function Figure({ hx, hy, scale: s, dir, long = false, keyLight }: { hx: number; hy: number; scale: number; dir: 1 | -1; long?: boolean; keyLight: string }) {
  const w = long ? 54 : 62;
  return (
    <g transform={`translate(${hx} ${hy}) scale(${s})`}>
      <path d={`M${-w} 60 C${-w + 6} 30 ${-26} 25 0 25 C26 25 ${w - 6} 30 ${w} 60 Z`} fill={DARK} />
      <rect x="-8" y="10" width="16" height="18" fill="#22150e" />
      {long && <ellipse cx={-dir * 2} cy="-7" rx="20" ry="21" fill={HAIR} />}
      {long && <path d={`M${-dir * 6} -14 Q${-dir * 28} 4 ${-dir * 23} 36 L${-dir * 7} 36 Q${-dir * 13} 12 ${-dir * 2} -8 Z`} fill={HAIR} />}
      <ellipse cx="0" cy="-2" rx="17" ry="21" fill={SKIN} />
      <ellipse cx={dir * 5} cy="0" rx="12" ry="17" fill={keyLight} opacity="0.85" />
      {long ? (
        <path d={`M${-dir * 19} 2 C${-dir * 21} -28 ${dir * 19} -30 ${dir * 17} -6 C${dir * 8} -20 ${-dir * 6} -16 ${-dir * 19} 2 Z`} fill={HAIR} />
      ) : (
        <path d={`M-17.5 -6 C-18 -27 17 -28 17.5 -7 C12 -15 -11 -17 -17.5 -6 Z`} fill={HAIR} />
      )}
      <path d={`M${-dir * 9} -19.8 A17 21 0 0 ${dir > 0 ? 0 : 1} ${-dir * 9} 15.8`} fill="none" stroke={RIM} strokeOpacity="0.5" strokeWidth="1.1" />
    </g>
  );
}
