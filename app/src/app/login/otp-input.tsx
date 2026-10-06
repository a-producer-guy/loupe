"use client";

import { useRef } from "react";

/**
 * Six boxes for the emailed code, like Frame.io's "Confirm your email":
 * typing moves along, backspace moves back, pasting fills them all.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  invalid,
  length = 6,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
  invalid?: boolean;
  length?: number;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  const set = (next: string, focus: number) => {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    boxes.current[Math.min(focus, length - 1)]?.focus();
    if (clean.length === length) onComplete(clean);
  };

  return (
    <div className={`flex gap-2.5 ${invalid ? "animate-shake" : ""}`}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          value={digit}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          maxLength={length}
          autoFocus={i === 0}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, "");
            if (!typed) return set(value.slice(0, i) + value.slice(i + 1), i);
            // Several digits at once: a paste or the browser filling in the code.
            if (typed.length > 1) return set(value.slice(0, i) + typed, i + typed.length);
            set(value.slice(0, i) + typed + value.slice(i + 1), i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digit && i > 0) {
              e.preventDefault();
              set(value.slice(0, i - 1) + value.slice(i), i - 1);
            } else if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
            else if (e.key === "ArrowRight" && i < length - 1) boxes.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            set(e.clipboardData.getData("text"), length - 1);
          }}
          className={`h-14 w-full min-w-0 rounded-none border-0 border-b-2 bg-transparent text-center text-[26px] font-semibold tabular-nums text-text caret-pink outline-none transition-colors placeholder:text-surface-3 focus:border-pink ${
            invalid ? "border-bad" : digit ? "border-text" : "border-line-strong"
          }`}
          placeholder="·"
        />
      ))}
    </div>
  );
}
