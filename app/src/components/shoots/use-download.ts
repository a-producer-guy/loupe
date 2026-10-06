"use client";

import { useState, useSyncExternalStore } from "react";

// Downloads a shoot into one folder on this computer, laid out exactly as in
// B2 (Raw/..., Proxies/...), so Premiere relinks proxies with no setup. Files
// go a few at a time; running it again skips files already there, so an
// interrupted download carries on where it stopped. Needs Chrome or Edge.

type Item = { kind: "raw" | "proxy" | "lut"; id: number; path: string; size: number };
type Picker = (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;

export type DownloadState =
  | { step: "idle" }
  | { step: "working"; files: number; filesDone: number; bytes: number; bytesDone: number }
  | { step: "done"; folder: string; files: number; bytes: number }
  | { step: "error"; message: string };

const PARALLEL = 3;
const noSubscription = () => () => {};

export function useShootDownload(shootId: number) {
  const [state, setState] = useState<DownloadState>({ step: "idle" });
  // Drawn as supported on the server; the browser corrects it once the page is live.
  const supported = useSyncExternalStore(noSubscription, () => "showDirectoryPicker" in window, () => true);

  const start = async (): Promise<DownloadState | null> => {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) return null;
    let root: FileSystemDirectoryHandle;
    try {
      root = await picker({ id: "reelarc-footage", mode: "readwrite", startIn: "downloads" });
    } catch {
      return null; // picker closed
    }
    try {
      const response = await fetch(`/api/shoots/${shootId}/downloads`, { cache: "no-store" });
      if (!response.ok) throw new Error("Couldn't get the list of files.");
      const { folder, files } = (await response.json()) as { folder: string; files: Item[] };
      const shootDir = await root.getDirectoryHandle(folder, { create: true });
      const total = files.reduce((sum, f) => sum + f.size, 0);
      let filesDone = 0;
      let bytesDone = 0;
      const report = () => setState({ step: "working", files: files.length, filesDone, bytes: total, bytesDone });
      report();

      const queue = [...files];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const counted = await downloadOne(shootId, shootDir, item, (n) => {
            bytesDone += n;
            report();
          });
          if (counted < item.size) bytesDone += item.size - counted; // already there
          filesDone += 1;
          report();
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      const done: DownloadState = { step: "done", folder, files: files.length, bytes: total };
      setState(done);
      return done;
    } catch (error) {
      const failed: DownloadState = { step: "error", message: error instanceof Error ? error.message : "The download stopped." };
      setState(failed);
      return failed;
    }
  };

  return { state, start, supported };
}

/** Downloads one file into its folder. Returns the bytes it downloaded (0 if it was already there). */
async function downloadOne(
  shootId: number,
  shootDir: FileSystemDirectoryHandle,
  item: Item,
  onBytes: (count: number) => void,
): Promise<number> {
  const parts = item.path.split("/");
  const name = parts.pop()!;
  let dir = shootDir;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  if (item.size > 0 && (await handle.getFile()).size === item.size) return 0;

  for (let attempt = 1; ; attempt++) {
    let received = 0;
    try {
      const link = await fetch(`/api/shoots/${shootId}/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: item.kind, id: item.id }),
      });
      if (!link.ok) throw new Error(`Couldn't get a download link for ${item.path}.`);
      const { url } = (await link.json()) as { url: string };
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Storage wouldn't send ${item.path}.`);
      const writable = await handle.createWritable();
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          onBytes(chunk.byteLength);
          controller.enqueue(chunk);
        },
      });
      await response.body.pipeThrough(counter).pipeTo(writable);
      return received;
    } catch (error) {
      onBytes(-received); // start this file's count over
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}
