"use client";

// Loupe, the character: a small round body on two feet with one camera-aperture eye and a red
// "recording" pupil. He shows how he's doing through the aperture (idle, listening, thinking,
// happy), holds his department's prop (scissors, headphones, paintbrush) and giggles when the
// pointer tickles him. Drawn in SVG on a 40 × 44 grid; the 3D version (loupe-3d.ts) takes over
// on bigger stages once it has drawn, with this drawing as its fallback.

import { useEffect, useId, useRef, useState } from "react";
import type { Loupe3D } from "./loupe-3d";

export type LoupeMood = "idle" | "listen" | "think" | "happy";
export type LoupeDept = "edit" | "sound" | "color" | "preview";

export const DEPT_COLOR: Record<LoupeDept, string> = { edit: "#E2452B", sound: "#3D7BE0", color: "#2E9E6B", preview: "#8A8A84" };

const C = 20;
const R = 5.4;
const VERTS = Array.from({ length: 6 }, (_, i) => [C + R * Math.cos((i * Math.PI) / 3), C + R * Math.sin((i * Math.PI) / 3)] as const);
const HEX = VERTS.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
const BLADES = VERTS.map(([x, y], i) => {
  const [qx, qy] = VERTS[(i + 1) % 6];
  return [x, y, x + (x - qx) * 1.15, y + (y - qy) * 1.15] as const;
});
const GIGGLES = ["hehe", "hee hee", "that tickles!", "hehehe", "stop, that tickles!"];

export function Loupe({
  size = 40,
  mood = "idle",
  dept,
  ticklish = true,
  className = "",
  label,
  three = false,
}: {
  size?: number;
  mood?: LoupeMood;
  dept?: LoupeDept;
  ticklish?: boolean;
  className?: string;
  /** Spoken name for screen readers; decorative (hidden) when left out. */
  label?: string;
  /** The 3D Loupe, for big stages. The drawing stays until 3D has drawn, and returns if it fails. */
  three?: boolean;
}) {
  const pupil = useRef<SVGCircleElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const live = useRef<Loupe3D | null>(null);
  const [threeOn, setThreeOn] = useState(false);
  const latest = useRef({ mood, dept });

  // Keep the 3D Loupe (once loaded) in the same mood and hat as the drawing.
  useEffect(() => {
    latest.current = { mood, dept };
    live.current?.set(mood, dept);
  }, [mood, dept]);

  // The 3D Loupe loads only where asked for, after the page has drawn.
  useEffect(() => {
    if (!three || !host.current) return;
    let gone = false;
    void import("./loupe-3d").then(({ mountLoupe3D }) => {
      if (gone || !host.current) return;
      live.current = mountLoupe3D(host.current, size, () => setThreeOn(true), () => setThreeOn(false));
      live.current?.set(latest.current.mood, latest.current.dept);
    });
    return () => {
      gone = true;
      live.current?.dispose();
      live.current = null;
    };
  }, [three, size]);

  const [giggle, setGiggle] = useState<{ text: string; key: number } | null>(null);
  const lastGiggle = useRef(0);
  const id = useId();

  // Idle Loupes glance around now and then.
  useEffect(() => {
    if (mood !== "idle" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() < 0.35 ? 0 : 2.2;
      if (pupil.current) pupil.current.style.transform = `translate(${(Math.cos(a) * d).toFixed(2)}px,${(Math.sin(a) * d).toFixed(2)}px)`;
    }, 2600);
    return () => clearInterval(timer);
  }, [mood]);

  const tickle = () => {
    if (!ticklish) return;
    live.current?.tickling(true);
    const now = performance.now();
    if (now - lastGiggle.current < 1400) return;
    lastGiggle.current = now;
    setGiggle({ text: GIGGLES[Math.floor(Math.random() * GIGGLES.length)], key: now });
    setTimeout(() => setGiggle((g) => (g && g.key === now ? null : g)), 1300);
  };

  const pupilColor = dept ? DEPT_COLOR[dept] : "#E2452B";
  return (
    <span
      ref={host}
      className={`loupe loupe-${mood} ${ticklish ? "loupe-ticklish" : ""} ${threeOn ? "loupe-3d-on" : ""} ${className}`}
      data-dept={dept}
      style={{ width: size, height: Math.round(size * 1.1) }}
      onPointerEnter={tickle}
      onPointerMove={() => ticklish && live.current?.wiggle()}
      onPointerLeave={() => live.current?.tickling(false)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 40 44" width={size} height={Math.round(size * 1.1)} aria-hidden="true">
        <ellipse cx="14" cy="41" rx="4.2" ry="2.3" fill="#161614" />
        <ellipse cx="26" cy="41" rx="4.2" ry="2.3" fill="#161614" />
        <circle cx="20" cy="20" r="18.5" fill="#FFFFFF" stroke="rgba(22,22,20,.14)" strokeWidth="1" />
        <ellipse cx="8.5" cy="27.5" rx="3" ry="1.8" fill="#E2452B" opacity=".13" />
        <ellipse cx="31.5" cy="27.5" rx="3" ry="1.8" fill="#E2452B" opacity=".13" />
        <g className="loupe-lens">
          <circle cx="20" cy="20" r="11.5" fill="#161614" />
          <g className="loupe-ap">
            <polygon points={HEX} fill="#FFF2EA" />
            <g stroke="#4A4A45" strokeWidth=".9" strokeLinecap="round">
              {BLADES.map(([x1, y1, x2, y2], i) => (
                <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
              ))}
            </g>
          </g>
          <circle ref={pupil} className="loupe-pupil" cx="20" cy="20" r="1.8" fill={pupilColor} />
          <path className="loupe-smile" d="M15 18.6 Q20 25 25 18.6" stroke="#FFF2EA" strokeWidth="2.3" fill="none" strokeLinecap="round" />
          <circle cx="15.8" cy="15.6" r="1.7" fill="#fff" opacity=".5" />
        </g>
        <g className="loupe-prop loupe-prop-sound">
          <path d="M2.4 19.5 A17.8 17.8 0 0 1 37.6 19.5" fill="none" stroke="#161614" strokeWidth="2.4" strokeLinecap="round" />
          <rect x="-0.8" y="15.2" width="5.8" height="11.4" rx="2.9" fill="#161614" />
          <rect x="35" y="15.2" width="5.8" height="11.4" rx="2.9" fill="#161614" />
          <rect x="0.6" y="17.6" width="1.6" height="6.6" rx=".8" fill="#3D7BE0" />
          <rect x="37.8" y="17.6" width="1.6" height="6.6" rx=".8" fill="#3D7BE0" />
        </g>
        <g className="loupe-prop loupe-prop-edit">
          <g transform="translate(33.2 26) rotate(-24) scale(1.18)">
            <path d="M1.6 6.6 L6.2 -5.2 M3.6 6.6 L-1 -5.2" stroke="#8E8E87" strokeWidth="2" strokeLinecap="round" />
            <circle cx="2.6" cy="2.6" r=".75" fill="#161614" />
            <circle cx="0" cy="9" r="2.5" fill="#FFFFFF" stroke="#E2452B" strokeWidth="1.4" />
            <circle cx="5.2" cy="9" r="2.5" fill="#FFFFFF" stroke="#E2452B" strokeWidth="1.4" />
          </g>
        </g>
        <g className="loupe-prop loupe-prop-color">
          <g transform="translate(35.2 31) rotate(28)">
            <rect x="-1.15" y="0" width="2.3" height="10.5" rx="1.15" fill="#161614" />
            <rect x="-1.5" y="-2.8" width="3" height="3" rx=".6" fill="#B9B9B2" />
            <path d="M-1.5 -2.8 Q-1.9 -7.2 0 -9.6 Q1.9 -7.2 1.5 -2.8 Z" fill="#2E9E6B" />
          </g>
        </g>
      </svg>
      {giggle && (
        <span key={giggle.key} className="loupe-giggle" id={`${id}-giggle`}>
          {giggle.text}
        </span>
      )}
    </span>
  );
}
