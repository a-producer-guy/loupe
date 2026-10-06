/* eslint-disable @next/next/no-img-element -- stills come from signed B2 links, not the image optimizer */
"use client";

import { useState } from "react";

// Scenes without a still yet get a quiet gradient of their own, picked from the scene's id so it
// never changes: warm and cool greys, like a booth before the lights come on.
const PALETTES = [
  ["#d9cbb8", "#a9b6c2"],
  ["#c9c3b6", "#d8d2c4"],
  ["#bfc8cf", "#e2d6c4"],
  ["#d4c7c0", "#b8c1b6"],
  ["#cfd3d6", "#c9bba8"],
  ["#d8d0c2", "#b4bdc6"],
];

export function GradientArt({ seed }: { seed: number }) {
  const [a, b] = PALETTES[seed % PALETTES.length];
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `radial-gradient(120% 90% at 88% 8%, ${a} 0%, transparent 60%), radial-gradient(90% 100% at 8% 100%, ${b} 0%, transparent 65%), linear-gradient(160deg, #efefeb, #e4e4df)`,
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
