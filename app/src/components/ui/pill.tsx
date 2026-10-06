import type { ReactNode } from "react";

export type Tone = "neutral" | "pink" | "good" | "warn" | "bad" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-3 text-muted",
  pink: "bg-pink-soft text-pink",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

const dots: Record<Tone, string> = {
  neutral: "bg-faint",
  pink: "bg-pink",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
};

/** Small tinted status label, like Frame.io's "In Progress". `overlay` sits on top of pictures. */
export function Pill({
  tone = "neutral",
  children,
  dot,
  pulse,
  overlay,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  overlay?: boolean;
  icon?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium whitespace-nowrap ${
        overlay ? "bg-black/60 text-white backdrop-blur-md" : tones[tone]
      }`}
    >
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-70 ${dots[tone]}`} />}
          <span className={`relative inline-flex size-1.5 rounded-full ${dots[tone]}`} />
        </span>
      )}
      {icon}
      {children}
    </span>
  );
}
