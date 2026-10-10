"use client";

// Downloads, for the whole app (Guy, Oct 10: "I should be able to see it's still downloading"). A scene's files are
// saved into one folder on this computer, laid out as in Loupe (Raw/, Proxies/, LUTs/, "Loupe Cut/", Final/), so
// Premiere and Resolve relink with no setup. Like uploads, a download keeps going while you move around Loupe; the
// Downloads panel and tray show it from any page, and closing the tab mid-download asks first. Files go a few at a
// time; running it again into the same folder skips files already there, so a stopped download carries on where it
// stopped. Needs Chrome or Edge (it writes to a folder you pick).

export type DownloadKind = "raw" | "proxy" | "lut" | "cut" | "final";
export type DownloadItem = { kind: DownloadKind; id: number; path: string; size: number };
type Picker = (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;

export type DownloadState =
  | { step: "idle" }
  | { step: "working"; files: number; filesDone: number; bytes: number; bytesDone: number }
  | { step: "done"; folder: string; files: number; bytes: number }
  | { step: "error"; message: string };

export type DownloadJob = { sceneId: number; name: string; folder: string; state: DownloadState; finishedAt: number | null };
export type DownloadsOverview = { active: boolean; bytes: number; bytesDone: number; jobs: DownloadJob[] };

const PARALLEL = 3;
const EMPTY: DownloadsOverview = { active: false, bytes: 0, bytesDone: 0, jobs: [] };
const IDLE: DownloadState = { step: "idle" };

class DownloadManager {
  private jobs = new Map<number, DownloadJob>();
  private listeners = new Set<() => void>();
  private snapshot: DownloadsOverview = EMPTY;
  private timer: number | null = null;

  constructor() {
    window.addEventListener("beforeunload", (event) => {
      if (!this.snapshot.active) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  overview = (): DownloadsOverview => this.snapshot;

  view = (sceneId: number): DownloadState => this.jobs.get(sceneId)?.state ?? IDLE;

  /** Forgets finished and failed downloads (the panel's "Clear"). */
  clear() {
    for (const [id, job] of this.jobs) if (job.state.step !== "working") this.jobs.delete(id);
    this.emit();
  }

  /**
   * Saves the scene's files (only these kinds, when given) into a folder the person picks. Must be called straight
   * from a click: the browser only opens its folder picker then.
   */
  async start(sceneId: number, name: string, kinds?: ReadonlySet<DownloadKind>): Promise<DownloadState | null> {
    if (this.jobs.get(sceneId)?.state.step === "working") return this.view(sceneId);
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) return null;
    let root: FileSystemDirectoryHandle;
    try {
      root = await picker({ id: "loupe-export", mode: "readwrite", startIn: "downloads" });
    } catch {
      return null; // picker closed
    }
    const job: DownloadJob = { sceneId, name, folder: "", state: { step: "working", files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, finishedAt: null };
    this.jobs.set(sceneId, job);
    this.emit();
    try {
      const response = await fetch(`/api/shoots/${sceneId}/downloads`, { cache: "no-store" });
      if (!response.ok) throw new Error("Couldn't get the list of files.");
      const listed = (await response.json()) as { folder: string; files: DownloadItem[] };
      const files = kinds ? listed.files.filter((f) => kinds.has(f.kind)) : listed.files;
      job.folder = listed.folder;
      const shootDir = await root.getDirectoryHandle(listed.folder, { create: true });
      const total = files.reduce((sum, f) => sum + f.size, 0);
      let filesDone = 0;
      let bytesDone = 0;
      const report = () => {
        job.state = { step: "working", files: files.length, filesDone, bytes: total, bytesDone };
        this.emitSoon();
      };
      report();
      const queue = [...files];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const counted = await downloadOne(sceneId, shootDir, item, (n) => {
            bytesDone += n;
            report();
          });
          if (counted < item.size) bytesDone += item.size - counted; // already there
          filesDone += 1;
          report();
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      job.state = { step: "done", folder: listed.folder, files: files.length, bytes: total };
    } catch (error) {
      job.state = { step: "error", message: error instanceof Error ? error.message : "The download stopped." };
    }
    job.finishedAt = Date.now();
    this.emit();
    return job.state;
  }

  private emitSoon() {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.emit();
    }, 250);
  }

  private emit() {
    const jobs = [...this.jobs.values()].map((j) => ({ ...j }));
    const working = jobs.filter((j) => j.state.step === "working");
    this.snapshot = {
      active: working.length > 0,
      bytes: working.reduce((n, j) => n + (j.state.step === "working" ? j.state.bytes : 0), 0),
      bytesDone: working.reduce((n, j) => n + (j.state.step === "working" ? j.state.bytesDone : 0), 0),
      jobs,
    };
    for (const listener of this.listeners) listener();
  }
}

/** Downloads one file into its folder. Returns the bytes it downloaded (0 if it was already there). */
async function downloadOne(sceneId: number, shootDir: FileSystemDirectoryHandle, item: DownloadItem, onBytes: (count: number) => void): Promise<number> {
  const parts = item.path.split("/");
  const name = parts.pop()!;
  let dir = shootDir;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  if (item.size > 0 && (await handle.getFile()).size === item.size) return 0;

  for (let attempt = 1; ; attempt++) {
    let received = 0;
    try {
      const link = await fetch(`/api/shoots/${sceneId}/downloads`, {
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

let manager: DownloadManager | undefined;

export function getDownloadManager(): DownloadManager {
  if (!manager) {
    // In development, keeps the manager that's running when a code edit reloads this file.
    const dev = process.env.NODE_ENV === "development" ? (window as unknown as { __loupeDownloads?: DownloadManager }) : null;
    manager = dev?.__loupeDownloads ?? new DownloadManager();
    if (dev) dev.__loupeDownloads = manager;
  }
  return manager;
}

export const NO_DOWNLOADS = EMPTY;
