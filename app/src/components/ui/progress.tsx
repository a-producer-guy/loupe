import type { ReactNode } from "react";

const strokes = { pink: "var(--pink)", good: "var(--good)", warn: "var(--warn)", info: "var(--info)" } as const;

/** Circular progress, the centerpiece while a card uploads (WeTransfer-style). */
export function Ring({
  value,
  size = 64,
  stroke = 5,
  tone = "pink",
  busy,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: keyof typeof strokes;
  busy?: boolean;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = busy ? 0.25 : Math.max(0, Math.min(1, value));
  return (
    <div className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className={`-rotate-90 ${busy ? "animate-spin" : ""}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={strokes[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: busy ? undefined : "stroke-dashoffset 600ms ease" }}
        />
      </svg>
      {children && <div className="absolute inset-0 grid place-items-center text-center">{children}</div>}
    </div>
  );
}

export function Bar({
  value,
  tone = "pink",
  busy,
  thin,
  className = "",
}: {
  value: number;
  tone?: "pink" | "good" | "warn" | "info" | "bad";
  busy?: boolean;
  thin?: boolean;
  className?: string;
}) {
  const pct = busy ? 100 : Math.max(0, Math.min(100, value * 100));
  const fill = { pink: "bg-pink", good: "bg-good", warn: "bg-warn", info: "bg-info", bad: "bg-bad" }[tone];
  return (
    <div className={`w-full overflow-hidden rounded-full bg-white/[0.08] ${thin ? "h-1" : "h-1.5"} ${className}`}>
      <div
        className={`h-full rounded-full ${fill} ${busy ? "bar-busy opacity-60" : ""}`}
        style={{ width: `${pct}%`, transition: "width 600ms ease" }}
      />
    </div>
  );
}
