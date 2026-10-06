"use client";

import { ChevronLeft, ChevronRight, Film, LoaderCircle, Palette, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes, formatRuntime, timecodeAt } from "@/lib/footage/names";
import type { ClipRow } from "@/lib/footage/status";
import { fileName } from "./clip-views";

/**
 * Plays a clip's web preview full screen, Frame.io style: the picture, the
 * clip's own running timecode, its format, and the next and previous clips.
 * Esc closes; the left and right arrow keys move between clips.
 */
export function ClipPlayer({
  shootId,
  clips,
  index,
  lutName,
  onIndex,
  onClose,
}: {
  shootId: number;
  clips: ClipRow[];
  index: number;
  lutName: (card: string) => string | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const clip = clips[index];
  const jobId = clip.proxy?.jobId;
  const [link, setLink] = useState<{ jobId: number; url?: string; error?: string } | null>(null);
  const [time, setTime] = useState<{ clipId: number; seconds: number }>({ clipId: clip.id, seconds: 0 });

  useEffect(() => {
    if (!clip.preview || !jobId) return;
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/shoots/${shootId}/play?job=${jobId}`, { cache: "no-store" }).catch(() => null);
      const data = response ? await response.json().catch(() => ({})) : {};
      if (cancelled) return;
      setLink(response?.ok ? { jobId, url: data.url } : { jobId, error: data.error ?? "Couldn't load the preview. Try again in a moment." });
    })();
    return () => {
      cancelled = true;
    };
  }, [shootId, jobId, clip.preview]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") return onClose();
      // With the video focused, its own controls use the arrow keys to seek.
      if (event.target instanceof HTMLVideoElement) return;
      if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (event.key === "ArrowRight" && index < clips.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, clips.length, onIndex, onClose]);

  const current = link && link.jobId === jobId ? link : null;
  const seconds = time.clipId === clip.id ? time.seconds : 0;
  const m = clip.media;
  const timecode = timecodeAt(m?.timecode, m?.fps, seconds);
  const format = [m?.codec, m?.width && m?.height ? `${m.width}×${m.height}` : null, m?.fps ? `${m.fps} fps` : null].filter(Boolean).join(" · ");
  const lut = lutName(clip.card);

  let body;
  if (clip.preview && current?.url) {
    body = (
      <video
        key={current.url}
        src={current.url}
        poster={clip.thumbUrl ?? undefined}
        controls
        autoPlay
        playsInline
        onTimeUpdate={(event) => setTime({ clipId: clip.id, seconds: event.currentTarget.currentTime })}
        className="max-h-full max-w-full rounded-lg bg-black shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
      />
    );
  } else {
    const working = clip.status !== "uploaded" || clip.proxy?.status === "queued" || clip.proxy?.status === "running";
    const message = current?.error
      ? current.error
      : clip.preview
        ? null
        : working
          ? "The web preview is being made with the proxy. It plays here as soon as it's ready."
          : clip.proxy?.status === "failed"
            ? "This clip's proxy couldn't be made, so there's no web preview."
            : "No web preview for this clip yet. Clips uploaded before previews existed get one when their proxy is made again.";
    body = (
      <div className="relative grid aspect-video w-full max-w-4xl place-items-center overflow-hidden rounded-lg bg-black">
        {clip.thumbUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- signed B2 still
          <img src={clip.thumbUrl} alt="" className="absolute inset-0 size-full object-contain opacity-30" />
        )}
        <div className="relative max-w-md px-6 text-center">
          {message ? (
            <>
              <Film className="mx-auto size-8 text-faint" strokeWidth={1.5} />
              <p className="mt-3 text-[14px] text-muted">{message}</p>
            </>
          ) : (
            <LoaderCircle className="mx-auto size-8 animate-spin text-muted" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={fileName(clip.path)} className="fixed inset-0 z-50 flex flex-col bg-[#07080b]/[0.97] backdrop-blur-sm">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-white/5 px-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium">{fileName(clip.path)}</p>
          <p className="truncate text-[12px] text-faint">{clip.card || "Loose files"}</p>
        </div>
        <span className="shrink-0 text-[12.5px] tabular-nums text-faint">
          {index + 1} of {clips.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close player"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-white/10 hover:text-text"
        >
          <X className="size-5" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 py-4 sm:px-16">
        {body}
        {index > 0 && (
          <button
            type="button"
            aria-label="Previous clip"
            onClick={() => onIndex(index - 1)}
            className="absolute left-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/5 text-muted hover:bg-white/15 hover:text-text sm:left-4"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        {index < clips.length - 1 && (
          <button
            type="button"
            aria-label="Next clip"
            onClick={() => onIndex(index + 1)}
            className="absolute right-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/5 text-muted hover:bg-white/15 hover:text-text sm:right-4"
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/5 px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[18px] tabular-nums tracking-tight text-text">{timecode ?? (formatRuntime(seconds) || "0:00")}</span>
          <span className="text-[11px] uppercase tracking-wider text-faint">{timecode ? "timecode" : "elapsed"}</span>
        </div>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
          {[format, m?.durationSeconds ? formatRuntime(m.durationSeconds) : null, formatBytes(clip.sizeBytes)].filter(Boolean).join(" · ")}
        </span>
        {lut && (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
            <Palette className="size-3.5" /> {lut}
          </span>
        )}
      </footer>
    </div>
  );
}
