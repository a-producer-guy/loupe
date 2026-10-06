"use client";

import { CardSim, CloudUpload, Download, Plus, TriangleAlert, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { CardsSidebar, CopyText, type ClipFilter } from "@/components/shoots/cards-sidebar";
import { ClipPlayer } from "@/components/shoots/clip-player";
import { ClipGrid, ClipTable } from "@/components/shoots/clip-views";
import { DpChip, DpDialog } from "@/components/shoots/dp";
import { LutChip, LutDialog } from "@/components/shoots/luts";
import { useRefreshWhenSettled } from "@/components/shoots/refresh";
import { StatusHero } from "@/components/shoots/status-hero";
import { useShootDownload } from "@/components/shoots/use-download";
import { StatusBar, TopBar } from "@/components/shell/top-bar";
import { Button } from "@/components/ui/button";
import { Ring } from "@/components/ui/progress";
import { SearchField } from "@/components/ui/search-field";
import { useToast } from "@/components/ui/toast";
import { useViewMode, ViewToggle } from "@/components/ui/view-toggle";
import { DropZone } from "@/components/upload/drop-zone";
import { longDate } from "@/lib/dates";
import { formatBytes, formatRuntime, sortCards } from "@/lib/footage/names";
import type { ClipRow, ShootDetail } from "@/lib/footage/status";
import { usePolling, useShootProgress } from "@/lib/hooks";
import { getUploadManager } from "@/lib/upload/manager";

/** One section per card when the clips come from more than one; otherwise a single unlabelled group. */
function byCard(clips: ClipRow[]): { card: string | null; clips: ClipRow[] }[] {
  const cards = sortCards([...new Set(clips.map((c) => c.card))]);
  if (cards.length < 2) return [{ card: null, clips }];
  return cards.map((card) => ({ card, clips: clips.filter((c) => c.card === card) }));
}

function matches(clip: ClipRow, filter: ClipFilter, query: string) {
  if (filter.card !== null && clip.card !== filter.card) return false;
  const job = clip.proxy;
  if (filter.proxy === "ready" && !(job?.status === "done" || job?.status === "skipped")) return false;
  if (filter.proxy === "failed" && job?.status !== "failed") return false;
  if (filter.proxy === "working" && !(clip.status !== "uploaded" || !job || job.status === "queued" || job.status === "running")) return false;
  return !query || clip.path.toLowerCase().includes(query.toLowerCase());
}

export function ShootView({ initial }: { initial: ShootDetail }) {
  const [shoot, refresh] = usePolling(`/api/shoots/${initial.id}`, "shoot", initial);
  const progress = useShootProgress(shoot.id);
  useRefreshWhenSettled(progress.active, progress.filesDone, refresh);
  const toast = useToast();
  const download = useShootDownload(shoot.id);
  const [filter, setFilter] = useState<ClipFilter>({ card: null, proxy: null });
  const [query, setQuery] = useState("");
  const [view, setView] = useViewMode("footage.view");
  const [lutOpen, setLutOpen] = useState(false);
  const [dpOpen, setDpOpen] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);

  const retry = useCallback(
    async (jobId?: number) => {
      const response = await fetch(`/api/shoots/${shoot.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jobId ? { jobId } : {}),
      });
      toast(
        response.ok
          ? { tone: "info", title: jobId ? "Trying that proxy again" : "Trying the failed proxies again" }
          : { tone: "bad", title: "Couldn't retry right now", detail: "Try again in a moment." },
      );
      void refresh();
    },
    [shoot.id, refresh, toast],
  );

  const stopCard = async (card: string) => {
    const name = card || "the loose files";
    if (!window.confirm(`Stop uploading ${name}? Files from it that already finished stay safe.`)) return;
    await getUploadManager().stopCard(shoot.id, card);
    toast({ tone: "info", title: `Stopped ${name}` });
    void refresh();
  };

  const forget = async (card: string) => {
    const name = card || "the loose files";
    const ok = window.confirm(
      `Forget the files from ${name} that didn't copy? Only do this if that card's footage is safe somewhere else. Files that did copy stay safe.`,
    );
    if (!ok) return;
    await getUploadManager().stopCard(shoot.id, card);
    void refresh();
  };

  const startDownload = async () => {
    const result = await download.start();
    if (result?.step === "done") {
      toast({ tone: "good", title: "Download finished", detail: `${formatBytes(result.bytes)} is in the folder “${result.folder}”.` });
    } else if (result?.step === "error") {
      toast({ tone: "bad", title: "The download stopped", detail: `${result.message} Click Download again to carry on.` });
    }
  };

  // This tab's live progress for clips still uploading, by their path in the shoot.
  const inFlight = useMemo(() => {
    const prefix = `${shoot.storagePrefix}/`;
    return Object.fromEntries(Object.entries(progress.inFlight).map(([key, value]) => [key.slice(prefix.length), value]));
  }, [progress.inFlight, shoot.storagePrefix]);

  const clips = shoot.clips.filter((clip) => matches(clip, filter, query));
  // The player steps through clips in the order they're on screen.
  const ordered = view === "grid" ? byCard(clips).flatMap((group) => group.clips) : clips;
  const playing = playingId === null ? -1 : ordered.findIndex((clip) => clip.id === playingId);
  const lutName = (card: string) => {
    const own = shoot.cardLuts.find((c) => c.card === card);
    return own ? (own.lut?.name ?? null) : (shoot.lut?.name ?? null);
  };
  const clipBytes = clips.reduce((sum, c) => sum + c.sizeBytes, 0);
  const clipRuntime = clips.reduce((sum, c) => sum + (c.media?.durationSeconds ?? 0), 0);
  const downloading = download.state.step === "working";

  return (
    <DropZone shootId={shoot.id} shootName={shoot.name} className="flex min-h-0 flex-1 flex-col">
      {({ dragging, choose }) => (
        <>
          <TopBar
            crumbs={[{ label: "Today", href: "/" }, { label: shoot.name }]}
            actions={
              <>
                {shoot.files.uploaded > 0 &&
                  (download.supported ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={startDownload}
                      disabled={downloading}
                      title="Download raw and proxies, laid out for Premiere"
                      aria-label="Download"
                    >
                      {downloading ? (
                        <Ring value={download.state.step === "working" ? download.state.bytesDone / Math.max(1, download.state.bytes) : 0} size={16} stroke={2.5} />
                      ) : (
                        <Download className="size-4" />
                      )}
                      <span className="hidden sm:inline">{downloading ? "Downloading…" : "Download"}</span>
                    </Button>
                  ) : (
                    <span className="hidden text-[12.5px] text-faint sm:inline">Downloading needs Chrome or Edge</span>
                  ))}
                <Button size="sm" variant="primary" onClick={choose} aria-label="Add cards">
                  <Plus className="size-4" /> <span className="hidden sm:inline">Add cards</span>
                </Button>
              </>
            }
          />
          <div className="relative flex min-h-0 flex-1">
            <CardsSidebar shoot={shoot} progress={progress} filter={filter} onFilter={setFilter} />
            <main className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-7 sm:px-8">
                <div className="mb-6">
                  <h1 className="text-[30px] font-semibold leading-tight tracking-tight">{shoot.name}</h1>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px] text-muted">
                    <span>{longDate(shoot.shootDate)}</span>
                    <DpChip dpName={shoot.dpName} onClick={() => setDpOpen(true)} />
                    <LutChip shoot={shoot} onClick={() => setLutOpen(true)} />
                    <span className="text-faint lg:hidden">·</span>
                    <span className="lg:hidden">
                      <CopyText text={shoot.storagePrefix} />
                    </span>
                  </div>
                </div>

                <StatusHero shoot={shoot} progress={progress} onChoose={choose} onStopCard={stopCard} onRetryAll={() => retry()} />

                {shoot.problems.length > 0 && <Problems shoot={shoot} onForget={forget} />}

                {shoot.clips.length > 0 && (
                  <>
                    <div className="mb-4 mt-9 flex flex-wrap items-center justify-between gap-3">
                      <p className="text-[13px] text-muted">
                        <span className="font-medium text-text">
                          {clips.length} {clips.length === 1 ? "clip" : "clips"}
                        </span>
                        {" · "}
                        {formatBytes(clipBytes)}
                        {clipRuntime > 0 && ` · ${formatRuntime(clipRuntime)} runtime`}
                        {(filter.card !== null || filter.proxy) && (
                          <button
                            type="button"
                            onClick={() => setFilter({ card: null, proxy: null })}
                            className="ml-2 inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-muted hover:text-text"
                          >
                            {[filter.card !== null ? filter.card || "Loose files" : null, filter.proxy].filter(Boolean).join(" · ")}
                            <X className="size-3" />
                          </button>
                        )}
                      </p>
                      <div className="flex items-center gap-2">
                        <SearchField value={query} onChange={setQuery} placeholder="Search clips" className="w-48" />
                        <ViewToggle view={view} onChange={setView} />
                      </div>
                    </div>

                    <MobileCardFilter shoot={shoot} filter={filter} onFilter={setFilter} />

                    {clips.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-line-strong px-6 py-12 text-center text-[13.5px] text-muted">
                        No clips match{query ? ` “${query}”` : " this filter"}.
                      </p>
                    ) : view === "grid" ? (
                      <div className="space-y-9">
                        {byCard(clips).map((group) => (
                          <section key={group.card ?? "__all"}>
                            {group.card !== null && (
                              <h3 className="mb-3 flex items-center gap-2 text-[13px]">
                                <CardSim className="size-3.5 text-faint" />
                                <span className="font-medium">{group.card || "Loose files"}</span>
                                <span className="text-faint">
                                  {group.clips.length} {group.clips.length === 1 ? "clip" : "clips"} · {formatBytes(group.clips.reduce((sum, c) => sum + c.sizeBytes, 0))}
                                </span>
                              </h3>
                            )}
                            <ClipGrid clips={group.clips} inFlight={inFlight} onRetry={retry} onPlay={setPlayingId} />
                          </section>
                        ))}
                      </div>
                    ) : (
                      <ClipTable clips={clips} inFlight={inFlight} onRetry={retry} onPlay={setPlayingId} />
                    )}
                  </>
                )}
              </div>
            </main>
            {/* Over the visible area, wherever the page is scrolled to. */}
            {dragging && <DropOverlay name={shoot.name} />}
          </div>
          {playing >= 0 && (
            <ClipPlayer
              shootId={shoot.id}
              clips={ordered}
              index={playing}
              lutName={lutName}
              onIndex={(index) => setPlayingId(ordered[index].id)}
              onClose={() => setPlayingId(null)}
            />
          )}
          <DpDialog
            open={dpOpen}
            onClose={() => setDpOpen(false)}
            shootId={shoot.id}
            dpName={shoot.dpName}
            onSaved={(name) => {
              toast(name ? { tone: "good", title: "DP saved", detail: `${name} shot ${shoot.name}.` } : { tone: "info", title: "DP removed" });
              void refresh();
            }}
          />
          <LutDialog
            open={lutOpen}
            onClose={() => setLutOpen(false)}
            shoot={shoot}
            onSaved={(result) => {
              if ("error" in result) {
                toast({ tone: "bad", title: result.error });
                return;
              }
              toast(
                result.remade
                  ? { tone: "info", title: "LUT changed", detail: `Re-making ${result.remade === 1 ? "1 proxy" : `${result.remade} proxies`} with it. The stills update as each one finishes.` }
                  : { tone: "good", title: "LUT saved", detail: "New proxies from this shoot will have it." },
              );
              void refresh();
            }}
          />
          <StatusBar
            right={
              download.state.step === "working" ? (
                <span className="text-muted">
                  Downloading {formatBytes(download.state.bytesDone)} of {formatBytes(download.state.bytes)} · file{" "}
                  {Math.min(download.state.filesDone + 1, download.state.files)} of {download.state.files}
                </span>
              ) : null
            }
          >
            {shoot.clips.length} clips · {shoot.otherFiles.count} other files · {formatBytes(shoot.files.bytesTotal)}
          </StatusBar>
        </>
      )}
    </DropZone>
  );
}

function Problems({ shoot, onForget }: { shoot: ShootDetail; onForget: (card: string) => void }) {
  const shown = shoot.problems.slice(0, 6);
  return (
    <div className="mt-4 rounded-2xl border border-bad/30 bg-bad-soft/60 p-5">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-bad" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-bad">
            {shoot.problems.length === 1 ? "1 file couldn't be copied" : `${shoot.problems.length} files couldn't be copied`}
          </p>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {shown.map((p) => (
              <li key={p.path} className="min-w-0">
                <span className="break-all font-medium">{p.path.replace(/^Raw\/?/, "") || "Loose files"}</span>
                <span className="text-muted"> · {p.problem}</span>
              </li>
            ))}
            {shoot.problems.length > shown.length && <li className="text-muted">and {shoot.problems.length - shown.length} more</li>}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
            {sortCards([...new Set(shoot.problems.map((p) => p.card))]).map((card) => (
              <button key={card} type="button" onClick={() => onForget(card)} className="text-muted underline underline-offset-4 hover:text-text">
                Forget these from {card || "loose files"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileCardFilter({ shoot, filter, onFilter }: { shoot: ShootDetail; filter: ClipFilter; onFilter: (f: ClipFilter) => void }) {
  const cards = sortCards([...new Set(shoot.clips.map((c) => c.card))]);
  if (cards.length < 2) return null;
  return (
    <div className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
      {[null, ...cards].map((card) => (
        <button
          key={card ?? "__all"}
          type="button"
          onClick={() => onFilter({ ...filter, card })}
          className={`h-7 shrink-0 rounded-full px-3 text-[12.5px] ${filter.card === card ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}
        >
          {card === null ? "All clips" : card || "Loose files"}
        </button>
      ))}
    </div>
  );
}

function DropOverlay({ name }: { name: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-bg/80 p-6 backdrop-blur-sm">
      <svg className="absolute inset-4 size-[calc(100%-32px)]" aria-hidden>
        <rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="20" fill="none" stroke="var(--pink)" strokeWidth="2" strokeDasharray="10 8" className="animate-dash" />
      </svg>
      <div className="animate-rise text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-pink text-white shadow-[0_16px_40px_-10px_rgba(255,61,138,0.7)]">
          <CloudUpload className="size-8" />
        </div>
        <p className="mt-5 text-[22px] font-semibold">Drop to upload to {name}</p>
        <p className="mt-1.5 text-[13.5px] text-muted">Card folders keep their structure. Hidden system files are skipped.</p>
      </div>
    </div>
  );
}

