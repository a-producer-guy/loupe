"use client";

import { useSyncExternalStore } from "react";
import { getDownloadManager, NO_DOWNLOADS, type DownloadKind, type DownloadsOverview, type DownloadState } from "@/lib/download/manager";

// A scene's download, as the scene page sees it: the app-wide download manager (lib/download/manager.ts) does the
// work, so it carries on while you move around Loupe.

export type { DownloadKind, DownloadState } from "@/lib/download/manager";

const noSubscription = () => () => {};
const IDLE: DownloadState = { step: "idle" };

export function useShootDownload(shootId: number, name: string) {
  const state = useSyncExternalStore(
    (l) => getDownloadManager().subscribe(l),
    () => getDownloadManager().view(shootId),
    () => IDLE,
  );
  // Drawn as supported on the server; the browser corrects it once the page is live.
  const supported = useSyncExternalStore(noSubscription, () => "showDirectoryPicker" in window, () => true);
  const start = (kinds?: ReadonlySet<DownloadKind>) => getDownloadManager().start(shootId, name, kinds);
  return { state, start, supported };
}

/** Every download in this tab, for the Downloads panel and tray. */
export function useDownloadsOverview(): DownloadsOverview {
  return useSyncExternalStore(
    (l) => getDownloadManager().subscribe(l),
    () => getDownloadManager().overview(),
    () => NO_DOWNLOADS,
  );
}
