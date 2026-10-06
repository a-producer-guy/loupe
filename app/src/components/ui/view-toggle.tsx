"use client";

import { LayoutGrid, List } from "lucide-react";
import { useSyncExternalStore } from "react";

export type ViewMode = "grid" | "list";

const listeners = new Set<() => void>();

function read(key: string): ViewMode {
  try {
    return localStorage.getItem(key) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/** Grid or list, remembered on this computer only (each screen keeps its own). */
export function useViewMode(key: string): [ViewMode, (mode: ViewMode) => void] {
  const view = useSyncExternalStore<ViewMode>(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read(key),
    () => "grid",
  );
  const setView = (mode: ViewMode) => {
    try {
      localStorage.setItem(key, mode);
    } catch {
      // Private window: it just won't be remembered.
    }
    listeners.forEach((listener) => listener());
  };
  return [view, setView];
}

export function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="flex shrink-0 rounded-lg border border-line bg-surface p-0.5">
      {(["grid", "list"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          title={mode === "grid" ? "Grid" : "List"}
          aria-label={mode === "grid" ? "Grid view" : "List view"}
          aria-pressed={view === mode}
          onClick={() => onChange(mode)}
          className={`grid size-7 place-items-center rounded-md transition-colors ${view === mode ? "bg-surface-3 text-text" : "text-faint hover:text-text"}`}
        >
          {mode === "grid" ? <LayoutGrid className="size-3.5" /> : <List className="size-3.5" />}
        </button>
      ))}
    </div>
  );
}
