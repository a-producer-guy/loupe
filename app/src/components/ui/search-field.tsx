"use client";

import { Search, X } from "lucide-react";
import { useEffect, useRef } from "react";

/** A search box. Press / (or ⌘K) anywhere on the page to jump to it, Esc to clear it. */
export function SearchField({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label className={`relative block ${className}`}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
      <input
        ref={input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onChange("");
            event.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        enterKeyHint="search"
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-8 text-[13px] transition placeholder:text-faint focus:border-line-strong focus:bg-surface-2 focus:outline-none"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-faint hover:bg-surface-3 hover:text-text"
        >
          <X className="size-3" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden h-[18px] min-w-[18px] -translate-y-1/2 place-items-center rounded border border-line-strong px-1 font-sans text-[11px] text-faint sm:grid">
          /
        </kbd>
      )}
    </label>
  );
}
