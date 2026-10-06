"use client";

import { Check, CloudUpload, FolderInput, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Pill, type Tone } from "@/components/ui/pill";
import { Bar, Ring } from "@/components/ui/progress";
import { useRefreshWhenSettled } from "@/components/shoots/refresh";
import { DropZone } from "@/components/upload/drop-zone";
import { shortDate } from "@/lib/dates";
import { formatBytes, formatRuntime, formatTimeLeft } from "@/lib/footage/names";
import type { ShootSummary } from "@/lib/footage/status";
import { useShootProgress } from "@/lib/hooks";
import { Cover } from "./cover";

type Label = { tone: Tone; text: string; short: string; pulse?: boolean };

/** Where a scene stands, for both the card and the row: server checks plus this tab's live uploads. */
function useShootStatus(shoot: ShootSummary, onChanged: () => void) {
  const progress = useShootProgress(shoot.id);
  useRefreshWhenSettled(progress.active, progress.filesDone, onChanged);

  const busy = progress.reading !== null || progress.preparing;
  const uploading = progress.active;
  const empty = shoot.files.total === 0 && !uploading && !busy;
  const pct = progress.bytes ? progress.bytesDone / progress.bytes : 0;
  const p = shoot.proxies;
  const cards = new Set([...shoot.cards.map((c) => c.card), ...progress.cards.map((c) => c.card)]).size;

  let status: Label | null = null;
  if (progress.reading !== null) status = { tone: "info", text: "Reading card", short: "Reading card", pulse: true };
  else if (progress.preparing) status = { tone: "info", text: "Preparing", short: "Preparing", pulse: true };
  else if (uploading) {
    const text = progress.retrying ? "Reconnecting" : "Uploading";
    status = { tone: "pink", text, short: `${text} ${Math.round(pct * 100)}%`, pulse: true };
  } else if (empty) status = null;
  else if (shoot.safeToWipe) status = { tone: "good", text: "Uploaded", short: "Uploaded" };
  else if (shoot.files.problems > 0) status = { tone: "bad", text: "Files missing", short: "Files missing" };
  else status = { tone: "warn", text: "Incomplete", short: "Incomplete" };

  let proxies: Label | null = null;
  if (shoot.files.uploaded > 0 && p.videos > 0) {
    if (shoot.proxiesReady) proxies = { tone: "good", text: "Proxies ready", short: "Ready" };
    else if (p.failed > 0) {
      const failed = `${p.failed} failed`;
      proxies = { tone: "bad", text: `${p.failed} ${p.failed === 1 ? "proxy" : "proxies"} failed`, short: failed };
    } else proxies = { tone: "info", text: `Proxies ${p.done + p.skipped}/${p.videos}`, short: `${p.done + p.skipped} of ${p.videos}`, pulse: true };
  }

  const left = formatTimeLeft(progress.secondsLeft) || null;
  return { progress, busy, uploading, empty, pct, cards, status, proxies, left, done: shoot.safeToWipe && shoot.proxiesReady && !uploading };
}

/**
 * A scene on Your scenes. The whole card is also where more of that scene's
 * camera cards can be dropped.
 */
export function ShootTile({ shoot, onChanged }: { shoot: ShootSummary; onChanged: () => void }) {
  const { progress, busy, uploading, empty, pct, cards, status, proxies, left, done } = useShootStatus(shoot, onChanged);
  const p = shoot.proxies;

  let meta: string;
  if (uploading) meta = `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytes)}${left ? ` · ${left}` : ""}`;
  else if (empty) meta = "No footage yet";
  else meta = [formatBytes(shoot.files.bytesTotal), p.videos ? `${p.videos} take${p.videos === 1 ? "" : "s"}` : null, `${cards} card${cards === 1 ? "" : "s"}`].filter(Boolean).join(" · ");

  return (
    <DropZone shootId={shoot.id} shootName={shoot.name} className="animate-rise">
      {({ dragging, choose }) => (
        <Link
          href={`/scenes/${shoot.id}`}
          className={`group block overflow-hidden rounded-2xl bg-surface shadow-lift-sm ring-1 transition duration-200 ${
            dragging
              ? "scale-[1.015] ring-2 ring-tally shadow-[0_0_0_6px_var(--tally-soft)]"
              : "ring-line hover:-translate-y-0.5 hover:shadow-lift hover:ring-line-strong"
          }`}
        >
          <div className="relative aspect-video overflow-hidden bg-surface-2">
            {empty ? (
              <div className="absolute inset-3 grid place-items-center rounded-xl border border-dashed border-line-strong transition group-hover:border-faint">
                <div className="text-center">
                  <CloudUpload className="mx-auto size-7 text-faint" strokeWidth={1.6} />
                  <p className="mt-2 text-[13.5px] font-medium text-muted">Drop footage here</p>
                  <ChooseFolder onChoose={choose} className="mt-2" />
                </div>
              </div>
            ) : (
              <>
                <Cover url={shoot.coverUrl} seed={shoot.id} />
                <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent" />
              </>
            )}

            {(uploading || busy) && !dragging && (
              <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[2px]">
                <Ring value={pct} size={76} stroke={5} busy={busy || progress.bytes === 0}>
                  <span className="text-[16px] font-semibold tabular-nums">{busy ? "" : `${Math.round(pct * 100)}%`}</span>
                </Ring>
              </div>
            )}

            {dragging && <DragHint rounded={10} inset={8} />}

            <div className="absolute left-2.5 top-2.5 flex flex-col items-start gap-1.5">
              {status && (
                <Pill overlay dot pulse={status.pulse} tone={status.tone}>
                  {status.text}
                </Pill>
              )}
              {!uploading && !busy && proxies && (
                <Pill overlay dot pulse={proxies.pulse} tone={proxies.tone}>
                  {proxies.text}
                </Pill>
              )}
            </div>
            {shoot.runtimeSeconds > 0 && !uploading && (
              <span className="absolute bottom-2.5 right-2.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11.5px] font-medium tabular-nums text-white backdrop-blur-md">
                {formatRuntime(shoot.runtimeSeconds)}
              </span>
            )}
            {done && (
              <span className="absolute bottom-2.5 left-2.5 grid size-6 place-items-center rounded-full bg-good text-white">
                <Check className="size-3.5" strokeWidth={3} />
              </span>
            )}
          </div>
          <div className="px-3.5 pb-3.5 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="truncate text-[15px] font-semibold">{shoot.name}</h3>
              <span className="shrink-0 text-[12.5px] text-faint">{shortDate(shoot.shootDate)}</span>
            </div>
            <p className="mt-0.5 truncate text-[12.5px] text-muted">{meta}</p>
          </div>
        </Link>
      )}
    </DropZone>
  );
}

export function NewShootTile() {
  return (
    <Link
      href="/scenes/new"
      className="group flex flex-col overflow-hidden rounded-2xl border border-dashed border-line-strong text-left transition hover:border-faint hover:bg-surface/60"
    >
      <div className="grid aspect-video w-full place-items-center">
        <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-muted transition group-hover:bg-pink group-hover:text-white">
          <Plus className="size-5" />
        </span>
      </div>
      <div className="px-3.5 pb-3.5 pt-3">
        <p className="text-[15px] font-semibold text-muted group-hover:text-text">New scene</p>
        <p className="mt-0.5 text-[12.5px] text-faint">Drop the folder from the shoot</p>
      </div>
    </Link>
  );
}

// ---- List view: the same scenes as rows. ----

// On a phone the row is just the scene, with its status in the line under the name.
const COLUMNS =
  "grid grid-cols-1 items-center gap-x-4 md:grid-cols-[minmax(0,2.4fr)_minmax(150px,1.2fr)_minmax(110px,1fr)_64px_72px_80px]";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  pink: "text-pink",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
};

/** The list's frame: column titles, then the rows (and group headings) inside. */
export function ShootList({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-surface shadow-lift-sm ring-1 ring-line">
      <div className={`${COLUMNS} border-b border-line bg-panel px-4 py-2.5 text-[12px] font-medium text-faint`}>
        <span>Scene</span>
        <span className="hidden md:block">Status</span>
        <span className="hidden md:block">Proxies</span>
        <span className="hidden text-right md:block">Takes</span>
        <span className="hidden text-right md:block">Runtime</span>
        <span className="hidden text-right md:block">Size</span>
      </div>
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

/** A divider inside the list. */
export function ShootListGroup({ title, count, first }: { title: string; count: number; first?: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 bg-bg/60 px-4 pb-2 text-[13px] font-semibold ${first ? "pt-3" : "pt-6"}`}>
      {title} <span className="text-[12px] font-normal text-faint">{count}</span>
    </div>
  );
}

export function ShootRow({ shoot, onChanged }: { shoot: ShootSummary; onChanged: () => void }) {
  const { progress, busy, uploading, empty, pct, cards, status, proxies, left, done } = useShootStatus(shoot, onChanged);
  const p = shoot.proxies;

  return (
    <DropZone shootId={shoot.id} shootName={shoot.name} className="animate-rise">
      {({ dragging, choose }) => (
        <Link
          href={`/scenes/${shoot.id}`}
          className={`${COLUMNS} relative px-4 py-2.5 transition-colors ${dragging ? "bg-tally-soft shadow-[inset_0_0_0_2px_var(--tally)]" : "hover:bg-surface-2/60"}`}
        >
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="relative aspect-video w-[72px] shrink-0 overflow-hidden rounded-md bg-surface-2 md:w-[88px]">
              {empty ? (
                <div className="absolute inset-0 grid place-items-center rounded-md border border-dashed border-line-strong">
                  <CloudUpload className="size-4 text-faint" strokeWidth={1.8} />
                </div>
              ) : (
                <Cover url={shoot.coverUrl} seed={shoot.id} />
              )}
              {(uploading || busy) && (
                <div className="absolute inset-0 grid place-items-center bg-black/55">
                  <Ring value={pct} size={26} stroke={3} busy={busy || progress.bytes === 0} />
                </div>
              )}
              {done && (
                <span className="absolute bottom-1 left-1 grid size-4 place-items-center rounded-full bg-good text-white">
                  <Check className="size-2.5" strokeWidth={3.5} />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold">{shoot.name}</p>
              <p className="truncate text-[12.5px] text-faint">
                {status && <span className={`font-medium md:hidden ${TONE_TEXT[status.tone]}`}>{status.short} · </span>}
                {shortDate(shoot.shootDate)}
                {cards > 0 && ` · ${cards} card${cards === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>

          <div className="hidden min-w-0 flex-col items-start gap-1 md:flex">
            {dragging ? (
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-tally">
                <CloudUpload className="size-4" /> Drop to upload
              </span>
            ) : empty ? (
              <ChooseFolder onChoose={choose} />
            ) : (
              status && (
                <>
                  <Pill dot pulse={status.pulse} tone={status.tone}>
                    {status.short}
                  </Pill>
                  {uploading && left && <span className="text-[11.5px] text-faint">{left}</span>}
                </>
              )
            )}
          </div>

          <div className="hidden md:block">
            {proxies && !uploading ? (
              <Pill dot pulse={proxies.pulse} tone={proxies.tone}>
                {proxies.short}
              </Pill>
            ) : (
              <span className="text-[13px] text-faint">—</span>
            )}
          </div>
          <span className="hidden text-right text-[13px] tabular-nums text-muted md:block">{p.videos || <span className="text-faint">—</span>}</span>
          <span className="hidden text-right text-[13px] tabular-nums text-muted md:block">
            {formatRuntime(shoot.runtimeSeconds) || <span className="text-faint">—</span>}
          </span>
          <span className="hidden text-right text-[13px] tabular-nums text-muted md:block">
            {uploading ? formatBytes(progress.bytes) : shoot.files.total ? formatBytes(shoot.files.bytesTotal) : <span className="text-faint">—</span>}
          </span>

          {uploading && (
            <div className="absolute inset-x-0 bottom-0">
              <Bar thin value={pct} tone="pink" className="rounded-none bg-transparent" />
            </div>
          )}
        </Link>
      )}
    </DropZone>
  );
}

export function NewShootRow() {
  return (
    <Link href="/scenes/new" className="group flex w-full items-center gap-3.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2/60">
      <span className="grid aspect-video w-[72px] shrink-0 place-items-center rounded-md border border-dashed border-line-strong transition group-hover:border-pink/50 md:w-[88px]">
        <span className="grid size-6 place-items-center rounded-full bg-surface-2 text-muted transition group-hover:bg-pink group-hover:text-white">
          <Plus className="size-3.5" />
        </span>
      </span>
      <span className="text-[14px] font-medium text-muted group-hover:text-text">New scene</span>
    </Link>
  );
}

function ChooseFolder({ onChoose, className = "" }: { onChoose: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // Inside a link: pick a folder without opening the scene.
        event.preventDefault();
        event.stopPropagation();
        onChoose();
      }}
      className={`inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-[12px] text-muted hover:bg-surface-3 hover:text-text ${className}`}
    >
      <FolderInput className="size-3.5" /> Choose folder
    </button>
  );
}

function DragHint({ rounded, inset }: { rounded: number; inset: number }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/45 backdrop-blur-[1px]">
      <svg className="absolute" style={{ inset, width: `calc(100% - ${inset * 2}px)`, height: `calc(100% - ${inset * 2}px)` }} aria-hidden>
        <rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx={rounded} fill="none" stroke="var(--tally)" strokeWidth="2" strokeDasharray="8 6" className="animate-dash" />
      </svg>
      <p className="flex items-center gap-2 text-[15px] font-semibold text-white">
        <CloudUpload className="size-5" /> Drop to upload
      </p>
    </div>
  );
}
