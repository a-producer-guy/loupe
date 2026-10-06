"use client";

import { CardSim, Check, CloudUpload, Film, FolderInput, RotateCcw, TriangleAlert, WifiOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Bar, Ring } from "@/components/ui/progress";
import { formatBytes, formatTimeLeft, sortCards } from "@/lib/footage/names";
import type { ShootDetail } from "@/lib/footage/status";
import type { ShootProgress } from "@/lib/upload/manager";

/**
 * The one panel the DIT watches: live upload progress while cards go up, then
 * the green "uploaded and checked" the moment every file is checked in storage.
 * That only ever comes from the server's checks. Loupe doesn't promise "safe to wipe cards":
 * customers keep their own copy until they've exported, unless they pay for Keep footage.
 */
export function StatusHero({
  shoot,
  progress,
  onChoose,
  onStopCard,
  onRetryAll,
}: {
  shoot: ShootDetail;
  progress: ShootProgress;
  onChoose: () => void;
  onStopCard: (card: string) => void;
  onRetryAll: () => void;
}) {
  const busy = progress.reading !== null || progress.preparing;
  const uploading = progress.active;
  const files = shoot.files;

  if (!uploading && !busy && files.total === 0) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-dashed border-line-strong bg-surface/40 px-6 py-14 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted">
          <CloudUpload className="size-7" strokeWidth={1.6} />
        </div>
        <h2 className="mt-5 text-[19px] font-semibold">Drop card folders here</h2>
        <p className="mx-auto mt-1.5 max-w-md text-[13.5px] text-muted">
          Drag each card from Finder onto this page. Its folders are kept exactly as they are, and hidden system files are skipped.
        </p>
        <Button variant="secondary" className="mt-5" onClick={onChoose}>
          <FolderInput className="size-4" /> Choose a folder
        </Button>
      </div>
    );
  }

  const pct = progress.bytes ? progress.bytesDone / progress.bytes : 0;
  let visual;
  let title;
  let detail;
  let note = null;

  if (busy) {
    visual = <Ring value={0} size={84} stroke={6} busy />;
    title = progress.reading !== null ? "Reading the card…" : "Getting ready to upload…";
    detail = progress.reading ? `${progress.reading.toLocaleString()} files found so far` : "Checking what's already safely uploaded.";
  } else if (uploading) {
    visual = (
      <Ring value={pct} size={84} stroke={6} busy={progress.bytes === 0}>
        <span className="text-[18px] font-semibold tabular-nums">{progress.bytes ? `${Math.round(pct * 100)}%` : ""}</span>
      </Ring>
    );
    title = (
      <>
        Uploading {formatBytes(progress.bytesDone)} <span className="text-muted">of {formatBytes(progress.bytes)}</span>
      </>
    );
    detail = [
      progress.offline ? "Paused while offline" : progress.secondsLeft ? capitalize(formatTimeLeft(progress.secondsLeft)) : "Starting…",
      progress.bytesPerSecond > 0 ? `${formatBytes(progress.bytesPerSecond)}/s` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    note = progress.offline ? (
      <Note tone="warn" icon={<WifiOff className="size-4" />}>
        The internet dropped. Uploads carry on by themselves when it&apos;s back.
      </Note>
    ) : progress.signedOut ? (
      <Note tone="warn">You&apos;ve been signed out. Sign in again in a new tab (keep this one open) and uploads carry on.</Note>
    ) : progress.retrying > 0 ? (
      <Note tone="warn">
        Connection hiccup on {progress.retrying === 1 ? "one file" : `${progress.retrying} files`}. Retrying by itself.
      </Note>
    ) : (
      <p className="text-[13px] text-faint">Keep this tab open. You can drop more cards any time.</p>
    );
  } else if (shoot.safeToWipe) {
    visual = (
      <div className="grid size-[84px] animate-glow place-items-center rounded-full bg-good-soft">
        <Check className="size-10 animate-pop text-good" strokeWidth={2.5} />
      </div>
    );
    title = `${formatBytes(files.bytesUploaded)} uploaded and checked`;
    detail = `Every file on ${shoot.cards.length === 1 ? "the card" : `all ${shoot.cards.length} cards`} is in storage, and each one's size was checked. Keep your own copy until you've exported.`;
  } else if (files.problems > 0) {
    const cards = shoot.cards.filter((c) => c.files.problems > 0).map((c) => c.card || "loose files");
    visual = (
      <div className="grid size-[84px] place-items-center rounded-full bg-bad-soft">
        <TriangleAlert className="size-9 text-bad" />
      </div>
    );
    title = `${files.problems === 1 ? "1 file" : `${files.problems} files`} couldn't be copied from ${cards.join(", ")}`;
    detail = "Drop the same card again to retry. Everything else on it is already safe.";
  } else {
    visual = (
      <Ring value={files.bytesTotal ? files.bytesUploaded / files.bytesTotal : 0} size={84} stroke={6} tone="warn">
        <span className="text-[16px] font-semibold tabular-nums">
          {files.bytesTotal ? `${Math.round((files.bytesUploaded / files.bytesTotal) * 100)}%` : ""}
        </span>
      </Ring>
    );
    title = `${formatBytes(files.bytesUploaded)} of ${formatBytes(files.bytesTotal)} uploaded`;
    detail = "Not finished. If it stopped, drop the same cards here again and it picks up where it left off.";
  }

  // Cards, from the server's view plus this tab's live progress.
  const names = sortCards([...new Set([...shoot.cards.map((c) => c.card), ...progress.cards.map((c) => c.card)])]);

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
        {visual}
        <div className="min-w-0 flex-1">
          <h2 className="text-[19px] font-semibold leading-snug">{title}</h2>
          <p className="mt-1 text-[13.5px] text-muted">{detail}</p>
          {note && <div className="mt-3">{note}</div>}
        </div>
      </div>

      {names.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4 sm:px-6">
          {names.map((name) => {
            const local = progress.cards.find((c) => c.card === name);
            const server = shoot.cards.find((c) => c.card === name);
            const moving = local && local.filesDone < local.files;
            let tone: "good" | "bad" | "warn" | "pink";
            let text: string;
            if (moving) {
              tone = "pink";
              text = `${Math.round((local.bytesDone / Math.max(1, local.bytes)) * 100)}%`;
            } else if (server?.safeToWipe) {
              tone = "good";
              text = `${formatBytes(server.files.bytesUploaded)} · uploaded`;
            } else if (server && server.files.problems > 0) {
              tone = "bad";
              text = "files missing";
            } else {
              tone = "warn";
              text = server ? `${formatBytes(server.files.bytesUploaded)} of ${formatBytes(server.files.bytesTotal)}` : "waiting";
            }
            const color = { good: "text-good", bad: "text-bad", warn: "text-warn", pink: "text-pink" }[tone];
            return (
              <div key={name} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1.5 pl-2.5 pr-2 text-[13px]">
                {tone === "good" ? <Check className={`size-3.5 ${color}`} strokeWidth={3} /> : tone === "bad" ? <TriangleAlert className={`size-3.5 ${color}`} /> : <CardSim className={`size-3.5 ${color}`} />}
                <span className="font-medium">{name || "Loose files"}</span>
                <span className={`${color} opacity-90`}>{text}</span>
                {moving && (
                  <button
                    type="button"
                    title={`Stop uploading ${name || "the loose files"}`}
                    aria-label={`Stop uploading ${name || "the loose files"}`}
                    onClick={() => onStopCard(name)}
                    className="ml-0.5 grid size-5 place-items-center rounded text-faint hover:bg-surface-3 hover:text-text"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ProxiesRow shoot={shoot} onRetryAll={onRetryAll} />
    </div>
  );
}

function ProxiesRow({ shoot, onRetryAll }: { shoot: ShootDetail; onRetryAll: () => void }) {
  const p = shoot.proxies;
  if (shoot.files.uploaded === 0 || p.videos === 0) return null;
  const finished = p.done + p.skipped;
  return (
    <div className="flex items-center gap-4 border-t border-line px-5 py-4 sm:px-6">
      <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${shoot.proxiesReady ? "bg-good-soft text-good" : "bg-info-soft text-info"}`}>
        {shoot.proxiesReady ? <Check className="size-4" strokeWidth={3} /> : <Film className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[14px] font-medium">
            {shoot.proxiesReady
              ? "Proxies ready for Premiere"
              : shoot.clips.some((c) => c.proxy?.lookUpdating)
                ? `Applying ${shoot.lut ? `the ${shoot.lut.name} LUT` : "the new LUT"} to proxies`
                : "Making proxies"}
          </span>
          <span className="shrink-0 text-[12.5px] text-muted tabular-nums">
            {finished} of {p.videos} {p.videos === 1 ? "clip" : "clips"}
          </span>
        </div>
        {!shoot.proxiesReady && <Bar value={p.progress} tone="info" className="mt-2" />}
      </div>
      {p.failed > 0 && (
        <div className="flex shrink-0 items-center gap-2">
          <Pill tone="bad">{p.failed === 1 ? "1 failed" : `${p.failed} failed`}</Pill>
          <Button size="sm" variant="secondary" onClick={onRetryAll}>
            <RotateCcw className="size-3.5" /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}

function Note({ tone, icon, children }: { tone: "warn" | "bad"; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] ${tone === "bad" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
      {icon}
      <span>{children}</span>
    </p>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
