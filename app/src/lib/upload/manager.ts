// Runs every upload in this browser tab. It records a drop with the server,
// hands the files to Uppy (which sends them straight to B2 in parts), and
// then keeps things moving on its own: it retries after a dropped connection,
// resumes half-sent files where they stopped, nudges stalled transfers, keeps
// the computer awake, and asks the server to check each finished file.
// Browser only: create it through getUploadManager().

import Uppy from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import { cleanRelativePath } from "@/lib/footage/names";
import type { RegisteredGroup } from "@/lib/footage/register";
import type { PickedGroup } from "./read-drop";

type Meta = { shootId: number; key: string; card: string; relativePath: string };
type Body = Record<string, never>;

const MiB = 1024 * 1024;
const SLICE = 4000; // files per "record this drop" request
const STALL_MS = 2 * 60_000;

type FileState = "waiting" | "uploading" | "checking" | "retrying" | "done" | "failed";

type Tracked = {
  key: string;
  shootId: number;
  card: string;
  path: string;
  size: number;
  sent: number;
  state: FileState;
  message?: string;
  file?: File;
  uppyId?: string;
  failures: number;
  lastProgressAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Sent and checked during this visit (not already safe from an earlier one). */
  uploadedHere?: boolean;
};

type ShootState = {
  name: string;
  reading: number | null;
  preparing: boolean;
  notice?: string;
  error?: string;
  samples: { at: number; bytes: number }[];
  /** Files each card couldn't read, from the server's answer to the drop. */
  problems: Map<string, number>;
  /** Cards already announced as safe, so each gets one toast. */
  announced: Set<string>;
};

export type CardProgress = {
  card: string;
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  /** Files on this card that couldn't be read. */
  problems: number;
};

export type ShootProgress = {
  shootId: number;
  name: string;
  /** Something is happening in this tab for the shoot. */
  active: boolean;
  /** Files found so far while reading a dropped card, or null. */
  reading: number | null;
  preparing: boolean;
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  bytesPerSecond: number;
  secondsLeft: number | null;
  retrying: number;
  offline: boolean;
  signedOut: boolean;
  failed: { path: string; message: string }[];
  cards: CardProgress[];
  /** Upload progress (0-1) of files still on their way, by storage key. */
  inFlight: Record<string, number>;
  notice?: string;
  error?: string;
};

/** Everything this tab is uploading, for the Uploads panel and the rail. */
export type UploadsOverview = {
  shoots: ShootProgress[];
  active: boolean;
  /** When everything this tab was uploading last finished cleanly (for the "all safe" tray). */
  finishedAt: number | null;
  bytes: number;
  bytesDone: number;
  secondsLeft: number | null;
};

export type UploadEvent = { type: "card-safe"; shootId: number; shootName: string; card: string; bytes: number };

export const IDLE: ShootProgress = {
  shootId: 0,
  name: "",
  active: false,
  reading: null,
  preparing: false,
  files: 0,
  filesDone: 0,
  bytes: 0,
  bytesDone: 0,
  bytesPerSecond: 0,
  secondsLeft: null,
  retrying: 0,
  offline: false,
  signedOut: false,
  failed: [],
  cards: [],
  inFlight: {},
};

export const NOTHING: UploadsOverview = { shoots: [], active: false, finishedAt: null, bytes: 0, bytesDone: 0, secondsLeft: null };

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) => Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() / 2);

export class UploadManager {
  private readonly uppy: Uppy<Meta, Body>;
  private readonly tracked = new Map<string, Tracked>();
  private readonly shoots = new Map<number, ShootState>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: UploadEvent) => void>();
  private views = new Map<number, ShootProgress>();
  private overviewSnapshot: UploadsOverview = NOTHING;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private offline = navigator.onLine === false;
  private signedOut = false;
  private wakeLock: WakeLockSentinel | null = null;

  constructor() {
    this.uppy = new Uppy<Meta, Body>({ autoProceed: false, allowMultipleUploadBatches: true });
    this.uppy.use(AwsS3, {
      limit: 6,
      // Big files go in parts, so a dropped connection only loses the part in flight.
      shouldUseMultipart: (file) => (file.size ?? 0) > 64 * MiB,
      // At most 1,000 parts per file, so resuming can list them all in one go.
      getChunkSize: ({ size }) => Math.max(32 * MiB, Math.ceil(size / 1000 / MiB) * MiB),
      generateObjectKey: (file) => String(file.meta.key),
      allowedMetaFields: false,
      signRequest: (request) => this.sign(request),
    });

    this.uppy.on("upload-progress", (file, progress) => {
      const t = file && this.fromUppy(file.id);
      if (!t || typeof progress.bytesUploaded !== "number") return;
      if (progress.bytesUploaded !== t.sent) t.lastProgressAt = Date.now();
      clearTimeout(t.timer);
      t.timer = undefined;
      t.sent = progress.bytesUploaded;
      t.state = "uploading";
      this.emitSoon();
    });
    this.uppy.on("upload-success", (file) => {
      const t = file && this.fromUppy(file.id);
      if (!t) return;
      t.sent = t.size;
      t.state = "checking";
      this.emitSoon();
      void this.confirm(t);
    });
    this.uppy.on("upload-error", (file, error) => {
      const t = file && this.fromUppy(file.id);
      if (t) void this.handleError(t, error);
    });

    window.addEventListener("online", () => {
      this.offline = false;
      this.retryWaiting();
      this.emitSoon();
    });
    window.addEventListener("offline", () => {
      this.offline = true;
      this.emitSoon();
    });
    window.addEventListener("beforeunload", (event) => {
      if (!this.busy()) return;
      event.preventDefault();
      event.returnValue = "";
    });
    document.addEventListener("visibilitychange", () => void this.updateWakeLock());
    setInterval(() => this.kickStalled(), 15_000);
    // Once a minute, try anything still waiting (covers a long sleep or a sign-in in another tab).
    setInterval(() => this.retryWaiting(), 60_000);
  }

  // ── What the screens use ────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  view = (shootId: number): ShootProgress => this.views.get(shootId) ?? IDLE;

  overview = (): UploadsOverview => this.overviewSnapshot;

  onEvent(listener: (event: UploadEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Call right after reading a drop starts; shows "Reading the card…" while the folders are listed. */
  startReading(shootId: number, shootName?: string) {
    const shoot = this.shoot(shootId, shootName);
    shoot.reading = 0;
    shoot.notice = undefined;
    shoot.error = undefined;
    this.emitSoon();
  }

  readProgress(shootId: number, count: number) {
    this.shoot(shootId).reading = count;
    this.emitSoon();
  }

  /** Records the dropped files with the server, then uploads whatever isn't already safe in B2. */
  async add(shootId: number, groups: PickedGroup[], shootName?: string) {
    const shoot = this.shoot(shootId, shootName);
    shoot.reading = null;
    const nonEmpty = groups.filter((g) => g.files.length > 0 || g.unreadable.length > 0);
    if (nonEmpty.length === 0) {
      shoot.notice = "There were no files in what you dropped.";
      this.emitSoon();
      return;
    }
    shoot.preparing = true;
    shoot.error = undefined;
    shoot.notice = undefined;
    this.emitSoon();
    try {
      for (const group of nonEmpty) {
        const slices = group.files.length ? chunk(group.files, SLICE) : [[]];
        for (let i = 0; i < slices.length; i++) {
          const slice = slices[i];
          const { groups: [registered] } = await this.post<{ groups: RegisteredGroup[] }>(
            `/api/shoots/${shootId}/files`,
            {
              groups: [
                {
                  name: group.name,
                  files: slice.map((f) => ({ path: f.path, size: f.file.size, lastModified: f.file.lastModified })),
                  // Sent with the last slice, once every readable file of the card is recorded.
                  unreadable: i === slices.length - 1 ? group.unreadable : [],
                },
              ],
            },
          );
          if (registered.problems.length) {
            shoot.problems.set(registered.card, (shoot.problems.get(registered.card) ?? 0) + registered.problems.length);
          }
          shoot.announced.delete(registered.card);
          const byPath = new Map(slice.map((f) => [cleanRelativePath(f.path) ?? f.path, f.file]));
          for (const file of registered.files) {
            const picked = byPath.get(file.path);
            if (picked) this.track(shootId, registered.card, file, picked);
          }
          if (registered.files.length > 0 && registered.files.every((f) => f.state === "done")) {
            shoot.notice = `Everything on ${registered.card || "those files"} was already uploaded. Nothing new to send.`;
          }
        }
      }
    } catch (error) {
      shoot.error = error instanceof Error ? error.message : "Couldn't start the upload.";
    } finally {
      shoot.preparing = false;
      this.emitSoon();
    }
    this.uppy.upload().catch(() => {
      // Failures arrive per file through "upload-error".
    });
  }

  /** Stops a card dropped on the wrong shoot. Files already safe in B2 stay. */
  async stopCard(shootId: number, card: string) {
    for (const t of [...this.tracked.values()]) {
      if (t.shootId !== shootId || t.card !== card || t.state === "done") continue;
      clearTimeout(t.timer);
      this.tracked.delete(t.key);
      if (t.uppyId && this.uppy.getFile(t.uppyId)) this.uppy.removeFile(t.uppyId);
    }
    this.emitSoon();
    await this.post(`/api/shoots/${shootId}/stop`, { card });
  }

  // ── Keeping each file moving ────────────────────────────────────────────────

  private track(shootId: number, card: string, file: RegisteredGroup["files"][number], data: File) {
    const existing = this.tracked.get(file.key);
    if (existing && existing.state !== "failed" && existing.state !== "done") return; // already on its way
    if (existing?.uppyId && this.uppy.getFile(existing.uppyId)) this.uppy.removeFile(existing.uppyId);
    clearTimeout(existing?.timer);

    const t: Tracked = {
      key: file.key,
      shootId,
      card,
      path: file.path,
      size: file.size,
      sent: file.state === "done" ? file.size : 0,
      state: file.state === "done" ? "done" : "waiting",
      file: file.state === "done" ? undefined : data,
      failures: 0,
      lastProgressAt: Date.now(),
    };
    this.tracked.set(file.key, t);
    if (t.state === "done") return;
    this.addToUppy(t, file.state === "resume" ? file.uploadId : undefined);
  }

  private addToUppy(t: Tracked, resumeUploadId?: string) {
    if (!t.file) return;
    t.uppyId = this.uppy.addFile({
      name: t.file.name,
      type: t.file.type || "application/octet-stream",
      data: t.file,
      source: "footage",
      meta: { shootId: t.shootId, key: t.key, card: t.card, relativePath: t.key },
    });
    // Picks up a multipart upload a previous visit left half-finished.
    if (resumeUploadId) this.setMultipart(t.uppyId, { uploadId: resumeUploadId, key: t.key });
  }

  private setMultipart(uppyId: string, state: { uploadId: string; key: string } | undefined) {
    this.uppy.setFileState(uppyId, { s3Multipart: state } as never);
  }

  private fromUppy(uppyId: string): Tracked | undefined {
    const key = this.uppy.getFile(uppyId)?.meta.key;
    const t = key ? this.tracked.get(key) : undefined;
    return t?.uppyId === uppyId ? t : undefined;
  }

  private async confirm(t: Tracked, attempt = 0): Promise<void> {
    try {
      const result = await this.post<{ ok: boolean; reason?: string; message?: string }>("/api/uploads/confirm", {
        key: t.key,
      });
      if (result.ok) {
        t.state = "done";
        t.uploadedHere = true;
        t.sent = t.size;
        t.file = undefined;
        if (t.uppyId && this.uppy.getFile(t.uppyId)) this.uppy.removeFile(t.uppyId);
        t.uppyId = undefined;
      } else if (result.reason === "wrong-size" || result.reason === "missing") {
        this.startOver(t);
      } else {
        t.state = "failed";
        t.message = result.message ?? "This file couldn't be checked.";
      }
    } catch {
      // The file is in B2; only the check didn't get through. Check again later.
      t.state = "checking";
      t.timer = setTimeout(() => void this.confirm(t, attempt + 1), backoff(attempt));
    }
    this.emitSoon();
  }

  private async handleError(t: Tracked, error: unknown) {
    const err = error as { name?: string; status?: number; code?: string; serviceCode?: string; message?: string };
    const status = err.status ?? 0;

    if (err.name === "ApiError") {
      if (err.code === "already-uploaded") return this.confirm(t);
      if (err.code === "gone") {
        this.tracked.delete(t.key);
        if (t.uppyId && this.uppy.getFile(t.uppyId)) this.uppy.removeFile(t.uppyId);
        return this.emitSoon();
      }
      if (status === 401) this.signedOut = true;
      else if (status === 403 || err.code === "unreadable") {
        t.state = "failed";
        t.message = err.message ?? "This file wasn't allowed to upload.";
        return this.emitSoon();
      }
    } else if (err.name === "S3ServiceError") {
      // The half-finished upload B2 was holding is gone (finished, or expired).
      if (status === 404) {
        const done = await this.post<{ ok: boolean }>("/api/uploads/confirm", { key: t.key }).catch(() => null);
        if (done?.ok) return this.confirm(t);
        return this.startOver(t);
      }
      if (status === 400 && /InvalidPart|EntityTooSmall|MalformedXML/.test(err.serviceCode ?? "")) {
        return this.startOver(t);
      }
    }

    // Anything else is a hiccup (network, timeouts, B2 busy): wait and pick up where it stopped.
    t.failures += 1;
    t.state = "retrying";
    t.message = this.offline ? "Waiting for the internet to come back." : "Connection hiccup, retrying.";
    clearTimeout(t.timer);
    if (!this.offline) t.timer = setTimeout(() => this.retry(t), backoff(t.failures));
    this.emitSoon();
  }

  private retry(t: Tracked) {
    clearTimeout(t.timer);
    t.timer = undefined;
    if (t.state !== "retrying") return;
    t.state = "waiting";
    t.lastProgressAt = Date.now();
    const current = t.uppyId ? this.uppy.getFile(t.uppyId) : undefined;
    if (current && !current.error) {
      // Uppy already picked it up again (a new drop retries everything that failed).
    } else if (!current) {
      this.addToUppy(t);
      this.uppy.upload().catch(() => {});
    } else {
      // Resumes: Uppy asks B2 which parts it already has and sends the rest.
      this.uppy.retryUpload(current.id).catch(() => {});
    }
    this.emitSoon();
  }

  /** Sends the whole file again from the start. */
  private startOver(t: Tracked) {
    clearTimeout(t.timer);
    if (t.uppyId && this.uppy.getFile(t.uppyId)) this.uppy.removeFile(t.uppyId);
    t.uppyId = undefined;
    t.sent = 0;
    t.state = "retrying";
    t.failures += 1;
    t.timer = setTimeout(() => this.retry(t), 1_000);
    this.emitSoon();
  }

  private retryWaiting() {
    if (this.offline) return;
    for (const t of this.tracked.values()) if (t.state === "retrying") this.retry(t);
  }

  /** A transfer with no progress for two minutes is restarted from its last finished part. */
  private kickStalled() {
    if (this.offline) return;
    const now = Date.now();
    for (const t of this.tracked.values()) {
      if (t.state !== "uploading" || !t.uppyId || now - t.lastProgressAt < STALL_MS) continue;
      t.lastProgressAt = now;
      this.uppy.pauseResume(t.uppyId);
      this.uppy.pauseResume(t.uppyId);
    }
  }

  // ── Talking to the app's server ─────────────────────────────────────────────

  private async sign(request: { method: string; key: string; uploadId?: string; partNumber?: number }) {
    return this.post<{ url: string }>("/api/uploads/sign", {
      method: request.method,
      key: request.key,
      uploadId: request.uploadId,
      partNumber: request.partNumber,
    });
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        if (attempt < 4) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ApiError("Couldn't reach Reelarc Footage. Check the internet connection.", 0, "network");
      }
      const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
      if (response.ok) {
        this.signedOut = false;
        return data;
      }
      // A sign-in refresh racing another request clears up on a second try.
      const worthRetrying = response.status >= 500 || (response.status === 401 && attempt === 0);
      if (worthRetrying && attempt < 4) {
        await sleep(response.status === 401 ? 1_500 : backoff(attempt));
        continue;
      }
      throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status, data.code);
    }
  }

  // ── Screen updates ──────────────────────────────────────────────────────────

  private shoot(shootId: number, name?: string): ShootState {
    let shoot = this.shoots.get(shootId);
    if (!shoot) {
      shoot = { name: name ?? "", reading: null, preparing: false, samples: [], problems: new Map(), announced: new Set() };
      this.shoots.set(shootId, shoot);
    }
    if (name) shoot.name = name;
    return shoot;
  }

  private busy(): boolean {
    for (const shoot of this.shoots.values()) if (shoot.reading !== null || shoot.preparing) return true;
    for (const t of this.tracked.values()) if (t.state !== "done" && t.state !== "failed") return true;
    return false;
  }

  private emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.rebuildViews();
      for (const listener of this.listeners) listener();
      void this.updateWakeLock();
    }, 250);
  }

  private rebuildViews() {
    const now = Date.now();
    const views = new Map<number, ShootProgress>();
    for (const [shootId, shoot] of this.shoots) {
      const files = [...this.tracked.values()].filter((t) => t.shootId === shootId);
      const cards = new Map<string, CardProgress>();
      const inFlight: Record<string, number> = {};
      let bytes = 0;
      let bytesDone = 0;
      let filesDone = 0;
      let retrying = 0;
      let moving = false;
      const failed: ShootProgress["failed"] = [];
      for (const t of files) {
        const card = cards.get(t.card) ?? {
          card: t.card,
          files: 0,
          filesDone: 0,
          bytes: 0,
          bytesDone: 0,
          problems: shoot.problems.get(t.card) ?? 0,
        };
        card.files += 1;
        card.bytes += t.size;
        card.bytesDone += Math.min(t.sent, t.size);
        bytes += t.size;
        bytesDone += Math.min(t.sent, t.size);
        if (t.state === "done") {
          filesDone += 1;
          card.filesDone += 1;
        } else if (t.state === "failed") {
          failed.push({ path: t.path, message: t.message ?? "Couldn't upload." });
        } else {
          moving = true;
          if (t.state === "retrying") retrying += 1;
          inFlight[t.key] = t.size ? Math.min(1, t.sent / t.size) : 0;
        }
        cards.set(t.card, card);
      }
      // A card whose every file is checked in B2 gets announced once.
      for (const card of cards.values()) {
        if (card.files > 0 && card.filesDone === card.files && !card.problems && !shoot.announced.has(card.card)) {
          shoot.announced.add(card.card);
          if (files.some((t) => t.card === card.card && t.uploadedHere)) {
            const event: UploadEvent = { type: "card-safe", shootId, shootName: shoot.name, card: card.card, bytes: card.bytes };
            queueMicrotask(() => this.eventListeners.forEach((listener) => listener(event)));
          }
        }
      }

      shoot.samples.push({ at: now, bytes: bytesDone });
      shoot.samples = shoot.samples.filter((s) => now - s.at <= 30_000);
      const first = shoot.samples[0];
      const span = (now - first.at) / 1000;
      const bytesPerSecond = moving && span >= 3 ? Math.max(0, (bytesDone - first.bytes) / span) : 0;

      views.set(shootId, {
        shootId,
        name: shoot.name,
        active: moving || shoot.reading !== null || shoot.preparing,
        reading: shoot.reading,
        preparing: shoot.preparing,
        files: files.length,
        filesDone,
        bytes,
        bytesDone,
        bytesPerSecond,
        secondsLeft: bytesPerSecond > 0 ? (bytes - bytesDone) / bytesPerSecond : null,
        retrying,
        offline: this.offline,
        signedOut: this.signedOut,
        failed,
        cards: [...cards.values()],
        inFlight,
        notice: shoot.notice,
        error: shoot.error,
      });
    }
    this.views = views;

    const shoots = [...views.values()].filter((v) => v.files > 0 || v.active || v.error || v.notice);
    const active = shoots.some((v) => v.active);
    const bytes = shoots.reduce((sum, v) => sum + (v.active ? v.bytes : 0), 0);
    const bytesDone = shoots.reduce((sum, v) => sum + (v.active ? v.bytesDone : 0), 0);
    const speed = shoots.reduce((sum, v) => sum + v.bytesPerSecond, 0);
    const before = this.overviewSnapshot;
    const allGood = shoots.every((v) => v.failed.length === 0 && v.cards.every((c) => c.filesDone === c.files && !c.problems));
    const finishedAt = active ? null : before.active ? (allGood ? Date.now() : null) : before.finishedAt;
    this.overviewSnapshot = { shoots, active, finishedAt, bytes, bytesDone, secondsLeft: speed > 0 ? (bytes - bytesDone) / speed : null };
  }

  /** Keeps the screen (and so the computer) awake while anything is uploading. */
  private async updateWakeLock() {
    const busy = this.busy();
    try {
      if (busy && !this.wakeLock && document.visibilityState === "visible" && "wakeLock" in navigator) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
      } else if (!busy && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      // Not every browser allows it; uploads still work, the screen may just sleep.
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

let manager: UploadManager | undefined;

export function getUploadManager(): UploadManager {
  if (!manager) {
    // In development: lets local tests hand files to the uploader directly, and
    // keeps the uploader that's already running when a code edit reloads this
    // file (otherwise a second one would start the same uploads again).
    const dev = process.env.NODE_ENV === "development" ? (window as unknown as { __footageUploads?: UploadManager }) : null;
    manager = dev?.__footageUploads ?? new UploadManager();
    if (dev) dev.__footageUploads = manager;
  }
  return manager;
}
