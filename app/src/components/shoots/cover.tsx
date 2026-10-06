/* eslint-disable @next/next/no-img-element -- stills come from signed B2 links, not the image optimizer */
"use client";

import { useState } from "react";

// Frame.io gives every project a glossy cover. Shoots without a still yet get
// a gradient of their own, picked from the shoot's id so it never changes.
const PALETTES = [
  ["#ff3d8a", "#7c3aed"],
  ["#f472b6", "#2563eb"],
  ["#fb7185", "#f59e0b"],
  ["#a855f7", "#ff3d8a"],
  ["#22d3ee", "#7c3aed"],
  ["#ff3d8a", "#0ea5e9"],
];

export function GradientArt({ seed }: { seed: number }) {
  const [a, b] = PALETTES[seed % PALETTES.length];
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `radial-gradient(120% 90% at 88% 8%, ${a}66 0%, transparent 55%), radial-gradient(90% 100% at 8% 100%, ${b}77 0%, transparent 60%), linear-gradient(160deg, #1a1d29, #0d0f15)`,
      }}
    />
  );
}

/**
 * A still if there is one, the gradient otherwise (also when a still fails to
 * load). Still links are re-signed every hour, so a fresh link gets a fresh try.
 */
export function Cover({ url, seed, contain }: { url: string | null; seed: number; contain?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <GradientArt seed={seed} />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(url)}
      className={`absolute inset-0 size-full ${contain ? "object-contain" : "object-cover"}`}
    />
  );
}
