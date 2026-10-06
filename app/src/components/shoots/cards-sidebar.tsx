"use client";

import { Check, Copy, Layers } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatBytes, sortCards } from "@/lib/footage/names";
import type { ShootDetail } from "@/lib/footage/status";
import type { ShootProgress } from "@/lib/upload/manager";

export type ClipFilter = { card: string | null; proxy: "ready" | "working" | "failed" | null };

/** Frame.io's left panel, for a shoot: its cards, and quick filters on proxies. */
export function CardsSidebar({
  shoot,
  progress,
  filter,
  onFilter,
}: {
  shoot: ShootDetail;
  progress: ShootProgress;
  filter: ClipFilter;
  onFilter: (filter: ClipFilter) => void;
}) {
  const names = sortCards([...new Set([...shoot.cards.map((c) => c.card), ...progress.cards.map((c) => c.card)])]);
  const counts = {
    ready: shoot.clips.filter((c) => c.proxy?.status === "done" || c.proxy?.status === "skipped").length,
    working: shoot.clips.filter((c) => c.status !== "uploaded" || !c.proxy || c.proxy.status === "queued" || c.proxy.status === "running").length,
    failed: shoot.clips.filter((c) => c.proxy?.status === "failed").length,
  };

  return (
    <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-line bg-panel/50 px-3 py-6 lg:block">
      <Heading>Cards</Heading>
      <nav className="space-y-0.5">
        <Item active={filter.card === null} onClick={() => onFilter({ ...filter, card: null })} count={shoot.clips.length}>
          <Layers className="size-4 text-faint" /> All clips
        </Item>
        {names.map((name) => {
          const local = progress.cards.find((c) => c.card === name);
          const server = shoot.cards.find((c) => c.card === name);
          const dot =
            local && local.filesDone < local.files
              ? "bg-pink animate-pulse"
              : server?.files.problems
                ? "bg-bad"
                : server?.safeToWipe
                  ? "bg-good"
                  : "bg-warn";
          return (
            <Item
              key={name}
              active={filter.card === name}
              onClick={() => onFilter({ ...filter, card: filter.card === name ? null : name })}
              count={shoot.clips.filter((c) => c.card === name).length}
            >
              <span className={`ml-1 mr-0.5 size-2 shrink-0 rounded-full ${dot}`} />
              <span className="truncate">{name || "Loose files"}</span>
            </Item>
          );
        })}
      </nav>

      {shoot.clips.length > 0 && (
        <>
          <Heading className="mt-7">Proxies</Heading>
          <nav className="space-y-0.5">
            <Item active={filter.proxy === "ready"} onClick={() => onFilter({ ...filter, proxy: filter.proxy === "ready" ? null : "ready" })} count={counts.ready}>
              <span className="ml-1 mr-0.5 size-2 rounded-full bg-good" /> Ready
            </Item>
            {counts.working > 0 && (
              <Item active={filter.proxy === "working"} onClick={() => onFilter({ ...filter, proxy: filter.proxy === "working" ? null : "working" })} count={counts.working}>
                <span className="ml-1 mr-0.5 size-2 rounded-full bg-info" /> In progress
              </Item>
            )}
            {counts.failed > 0 && (
              <Item active={filter.proxy === "failed"} onClick={() => onFilter({ ...filter, proxy: filter.proxy === "failed" ? null : "failed" })} count={counts.failed}>
                <span className="ml-1 mr-0.5 size-2 rounded-full bg-bad" /> Failed
              </Item>
            )}
          </nav>
        </>
      )}

      <Heading className="mt-7">Details</Heading>
      <dl className="space-y-3 px-2 text-[12.5px]">
        <div>
          <dt className="text-faint">Folder in storage</dt>
          <dd className="mt-1">
            <CopyText text={shoot.storagePrefix} />
          </dd>
        </div>
        {shoot.otherFiles.count > 0 && (
          <div>
            <dt className="text-faint">Other files</dt>
            <dd className="mt-0.5 text-muted">
              {shoot.otherFiles.count.toLocaleString()} ({formatBytes(shoot.otherFiles.bytes)}): sound, stills and camera sidecar files, kept as they are
            </dd>
          </div>
        )}
      </dl>
    </aside>
  );
}

function Heading({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint ${className}`}>{children}</p>;
}

function Item({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13.5px] transition-colors ${
        active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60 hover:text-text"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      <span className="text-[12px] tabular-nums text-faint">{count}</span>
    </button>
  );
}

export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="group flex max-w-full items-center gap-1.5 rounded-md text-left font-mono text-[11.5px] text-muted hover:text-text"
    >
      <span className="truncate">{text}</span>
      {copied ? <Check className="size-3 shrink-0 text-good" /> : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}
