"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ShootSummary } from "@/lib/footage/status";
import { getUploadManager, IDLE, NOTHING, type ShootProgress, type UploadsOverview } from "@/lib/upload/manager";

/** This tab's upload progress for one shoot. */
export function useShootProgress(shootId: number): ShootProgress {
  return useSyncExternalStore(
    (listener) => getUploadManager().subscribe(listener),
    () => getUploadManager().view(shootId),
    () => IDLE,
  );
}

/** Everything this tab is uploading, across shoots. */
export function useUploadsOverview(): UploadsOverview {
  return useSyncExternalStore(
    (listener) => getUploadManager().subscribe(listener),
    () => getUploadManager().overview(),
    () => NOTHING,
  );
}

/** Today's date on this computer (YYYY-MM-DD), or null while the page is first drawn on the server. */
export function useToday(): string | null {
  return useSyncExternalStore(
    (listener) => {
      const id = setInterval(listener, 60_000);
      return () => clearInterval(id);
    },
    () => localDay(new Date()),
    () => null,
  );
}

export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Re-fetches one field of a JSON endpoint every few seconds while the tab is visible. */
export function usePolling<T>(url: string, field: string, initial: T, intervalMs = 5_000) {
  const [data, setData] = useState(initial);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) setData(((await response.json()) as Record<string, T>)[field]);
    } catch {
      // Offline for a moment; the next tick tries again.
    }
  }, [url, field]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, intervalMs]);

  return [data, refresh] as const;
}

/**
 * Every shoot matching a search, from any date: the Today screen only loads a
 * month either side, so the server looks through the rest. Null until the
 * answer for this exact search arrives. Kept fresh while the search stays open.
 */
export function useShootSearch(query: string, intervalMs = 5_000): ShootSummary[] | null {
  const q = query.trim();
  const [found, setFound] = useState<{ q: string; shoots: ShootSummary[] } | null>(null);

  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const run = async () => {
      try {
        const response = await fetch(`/api/shoots?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: controller.signal });
        if (response.ok) setFound({ q, shoots: ((await response.json()) as { shoots: ShootSummary[] }).shoots });
      } catch {
        // Replaced by the next keystroke, or offline for a moment.
      }
    };
    const first = setTimeout(run, 150); // wait for a pause in typing
    const again = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, intervalMs);
    return () => {
      controller.abort();
      clearTimeout(first);
      clearInterval(again);
    };
  }, [q, intervalMs]);

  return found && found.q === q ? found.shoots : null;
}
