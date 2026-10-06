"use client";

import { CircleAlert, Clock, Film, Palette, Play, RotateCcw } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import { Bar } from "@/components/ui/progress";
import { extensionOf, formatBytes, formatRuntime } from "@/lib/footage/names";
import type { ClipRow } from "@/lib/footage/status";
import { Cover } from "./cover";

// Clips the way Frame.io shows assets: a picture first, the name under it,
// and a small status label only while something is still happening.

type ClipState =
  | { kind: "uploading"; progress: number | null }
  | { kind: "queued" | "retrying"; look?: boolean }
  | { kind: "making"; progress: number; look?: boolean }
  | { kind: "ready" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

export function clipState(clip: ClipRow, inFlight: number | undefined): ClipState {
  if (clip.status !== "uploaded") return { kind: "uploading", progress: inFlight ?? null };
  const job = clip.proxy;
  if (!job) return { kind: "queued" };
  // look: an existing proxy being made again with the shoot's new LUT.
  if (job.status === "queued") return { kind: job.attempts > 0 && !job.lookUpdating ? "retrying" : "queued", look: job.lookUpdating };
  if (job.status === "running") return { kind: "making", progress: job.progress ?? 0, look: job.lookUpdating };
  if (job.status === "done") return { kind: "ready" };
  if (job.status === "skipped") return { kind: "skipped", reason: job.error ?? "No proxy needed." };
  return { kind: "failed", reason: job.error ?? "The proxy couldn't be made." };
}

export function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Where the clip sits on its card, e.g. "PRIVATE/M4ROOT/CLIP". */
function folderOnCard(clip: ClipRow) {
  const inside = clip.path.replace(/^Raw\//, "").replace(clip.card ? `${clip.card}/` : "", "");
  const slash = inside.lastIndexOf("/");
  return slash > 0 ? inside.slice(0, slash) : "";
}

/** e.g. "ProRes 422 HQ · 3840×2160 · 23.976 fps", once the proxy worker has looked at the clip. */
function formatLine(clip: ClipRow) {
  const m = clip.media;
  if (!m) return null;
  return [m.codec, m.width && m.height ? `${m.width}×${m.height}` : null, m.fps ? `${m.fps} fps` : null].filter(Boolean).join(" · ") || null;
}

function StatePill({ state }: { state: ClipState }) {
  switch (state.kind) {
    case "uploading":
      return (
        <Pill overlay dot pulse={state.progress !== null} tone="pink">
          {state.progress !== null ? `Uploading ${Math.round(state.progress * 100)}%` : "Waiting to upload"}
        </Pill>
      );
    case "queued":
      return state.look ? (
        <Pill overlay icon={<Palette className="size-3" />}>Waiting to apply LUT</Pill>
      ) : (
        <Pill overlay icon={<Clock className="size-3" />}>Waiting for proxy</Pill>
      );
    case "retrying":
      return <Pill overlay icon={<Clock className="size-3" />}>Retrying proxy soon</Pill>;
    case "making":
      return (
        <Pill overlay dot pulse tone="info">
          {state.look ? "Applying LUT" : "Making proxy"} {Math.round(state.progress * 100)}%
        </Pill>
      );
    case "skipped":
      return <Pill overlay>No proxy needed</Pill>;
    default:
      return null;
  }
}

export function ClipGrid({
  clips,
  inFlight,
  onRetry,
  onPlay,
}: {
  clips: ClipRow[];
  inFlight: Record<string, number>;
  onRetry: (jobId: number) => void;
  onPlay: (clipId: number) => void;
}) {
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
      {clips.map((clip) => (
        <ClipTile key={clip.id} clip={clip} state={clipState(clip, inFlight[clip.path])} onRetry={onRetry} onPlay={onPlay} />
      ))}
    </div>
  );
}

function ClipTile({
  clip,
  state,
  onRetry,
  onPlay,
}: {
  clip: ClipRow;
  state: ClipState;
  onRetry: (jobId: number) => void;
  onPlay: (clipId: number) => void;
}) {
  const format = formatLine(clip);
  return (
    <div className="group overflow-hidden rounded-lg border border-line bg-surface transition hover:border-line-strong hover:shadow-lift">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Play ${fileName(clip.path)}`}
        onClick={() => onPlay(clip.id)}
        onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), onPlay(clip.id))}
        className="relative aspect-video cursor-pointer overflow-hidden bg-black focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-pink"
      >
        {clip.thumbUrl ? (
          <Cover url={clip.thumbUrl} seed={clip.id} contain />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-surface-2">
            <div className="text-center">
              <Film className="mx-auto size-6 text-surface-3" strokeWidth={1.5} />
              <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{extensionOf(clip.path) || "clip"}</p>
            </div>
          </div>
        )}

        {clip.preview && state.kind !== "failed" && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
            <span className="grid size-11 place-items-center rounded-full bg-black/55 backdrop-blur-md">
              <Play className="size-5 translate-x-px fill-white text-white" />
            </span>
          </span>
        )}

        {state.kind === "failed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 px-4 text-center backdrop-blur-[2px]">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-bad-soft px-2 py-0.5 text-[12px] font-semibold text-bad">
              <CircleAlert className="size-3.5" /> Proxy failed
            </span>
            <p className="line-clamp-2 text-[11.5px] leading-snug text-muted">{state.reason}</p>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (clip.proxy) onRetry(clip.proxy.jobId);
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-white/20"
            >
              <RotateCcw className="size-3.5" /> Retry
            </button>
          </div>
        ) : (
          <div className="absolute left-2 top-2">
            <StatePill state={state} />
          </div>
        )}

        {clip.media?.durationSeconds && state.kind !== "failed" ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
            {formatRuntime(clip.media.durationSeconds)}
          </span>
        ) : null}
        {(state.kind === "uploading" || state.kind === "making") && (
          <div className="absolute inset-x-0 bottom-0">
            <Bar
              thin
              value={state.kind === "uploading" ? (state.progress ?? 0) : state.progress}
              busy={state.kind === "uploading" && state.progress === null}
              tone={state.kind === "uploading" ? "pink" : "info"}
              className="rounded-none bg-black/40"
            />
          </div>
        )}
      </div>
      <div className="px-3 pb-2.5 pt-2">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium" title={clip.path.replace(/^Raw\//, "")}>
            {fileName(clip.path)}
          </p>
          <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{formatBytes(clip.sizeBytes)}</span>
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-faint" title={format ?? undefined}>
          {format ?? (clip.card || "Loose files")}
        </p>
      </div>
    </div>
  );
}

export function ClipTable({
  clips,
  inFlight,
  onRetry,
  onPlay,
}: {
  clips: ClipRow[];
  inFlight: Record<string, number>;
  onRetry: (jobId: number) => void;
  onPlay: (clipId: number) => void;
}) {
  // The card column only earns its space when the clips come from more than one card.
  const showCard = new Set(clips.map((c) => c.card)).size > 1;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[680px] text-left text-[13px]">
        <thead className="border-b border-line bg-surface/60 text-[12px] text-faint">
          <tr className="whitespace-nowrap">
            <th className="px-4 py-2.5 font-medium">Clip</th>
            {showCard && <th className="px-3 py-2.5 font-medium">Card</th>}
            <th className="px-3 py-2.5 font-medium">Format</th>
            <th className="px-3 py-2.5 font-medium">Timecode</th>
            <th className="px-3 py-2.5 text-right font-medium">Length</th>
            <th className="px-3 py-2.5 text-right font-medium">Size</th>
            <th className="px-4 py-2.5 text-right font-medium">Proxy</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {clips.map((clip) => {
            const state = clipState(clip, inFlight[clip.path]);
            const folder = folderOnCard(clip);
            const m = clip.media;
            const picture = m ? [m.width && m.height ? `${m.width}×${m.height}` : null, m.fps ? `${m.fps} fps` : null].filter(Boolean).join(" · ") : "";
            return (
              <tr key={clip.id} className="hover:bg-surface/50">
                <td className="max-w-0 px-4 py-2 [width:40%]">
                  <button type="button" onClick={() => onPlay(clip.id)} className="group flex w-full items-center gap-3 text-left">
                    <div className="relative aspect-video w-16 shrink-0 overflow-hidden rounded bg-black">
                      {clip.thumbUrl ? (
                        <Cover url={clip.thumbUrl} seed={clip.id} contain />
                      ) : (
                        <Film className="absolute inset-0 m-auto size-3.5 text-surface-3" />
                      )}
                      {clip.preview && (
                        <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                          <Play className="size-3.5 fill-white text-white" />
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium group-hover:text-text" title={clip.path.replace(/^Raw\//, "")}>
                        {fileName(clip.path)}
                      </p>
                      {folder && <p className="truncate text-[11.5px] text-faint">{folder}</p>}
                    </div>
                  </button>
                </td>
                {showCard && <td className="whitespace-nowrap px-3 py-2 text-muted">{clip.card || "Loose files"}</td>}
                <td className="whitespace-nowrap px-3 py-2">
                  {m?.codec || picture ? (
                    <>
                      <p className="text-muted">{m?.codec ?? "—"}</p>
                      {picture && <p className="text-[11.5px] text-faint">{picture}</p>}
                    </>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted">{m?.timecode ?? <span className="text-faint">—</span>}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">{formatRuntime(m?.durationSeconds) || <span className="text-faint">—</span>}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">{formatBytes(clip.sizeBytes)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <ProxyCell state={state} onRetry={() => clip.proxy && onRetry(clip.proxy.jobId)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProxyCell({ state, onRetry }: { state: ClipState; onRetry: () => void }) {
  switch (state.kind) {
    case "ready":
      return <Pill tone="good" dot>Ready</Pill>;
    case "failed":
      return (
        <span className="inline-flex items-center gap-2" title={state.reason}>
          <Pill tone="bad">Proxy failed</Pill>
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-[12px] hover:bg-surface-3">
            <RotateCcw className="size-3" /> Retry
          </button>
        </span>
      );
    case "making":
      return <Pill tone="info" dot pulse>{state.look ? "Applying LUT " : ""}{Math.round(state.progress * 100)}%</Pill>;
    case "uploading":
      return <Pill tone="pink" dot>{state.progress !== null ? `Uploading ${Math.round(state.progress * 100)}%` : "Waiting to upload"}</Pill>;
    case "skipped":
      return <Pill>No proxy needed</Pill>;
    default:
      return (
        <Pill icon={state.kind === "queued" && state.look ? <Palette className="size-3" /> : <Clock className="size-3" />}>
          {state.kind === "retrying" ? "Retrying soon" : state.look ? "Waiting to apply LUT" : "Waiting"}
        </Pill>
      );
  }
}
