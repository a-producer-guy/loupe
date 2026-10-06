"use client";

import { CardSim, Check, ChevronUp, Clapperboard, CloudUpload, CreditCard, LogOut, Settings, TriangleAlert, Users, WifiOff, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoupeMark } from "@/components/ui/brand";
import { Bar, Ring } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { DropGuard } from "@/components/upload/drop-guard";
import { formatBytes, formatTimeLeft } from "@/lib/footage/names";
import { useUploadsOverview } from "@/lib/hooks";
import { getUploadManager, type ShootProgress, type UploadsOverview } from "@/lib/upload/manager";

/**
 * Loupe's frame: a slim rail (Your scenes, Uploads, Plan, Team, Settings), an Uploads panel that
 * slides out from it, and a small tray that keeps an eye on uploads from any page.
 */
export function AppShell({ email, children }: { email: string; children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const overview = useUploadsOverview();
  const toast = useToast();

  useEffect(
    () =>
      getUploadManager().onEvent((event) => {
        if (event.type !== "card-safe") return;
        toast({
          tone: "good",
          title: `${event.card || "Loose files"} is uploaded`,
          detail: `${formatBytes(event.bytes)} uploaded to ${event.shootName || "the scene"} and checked. Keep your own copy until you've exported.`,
        });
      }),
    [toast],
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <DropGuard />
      <Rail email={email} overview={overview} uploadsOpen={panelOpen} onToggleUploads={() => setPanelOpen((open) => !open)} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {panelOpen && <UploadsPanel overview={overview} onClose={() => setPanelOpen(false)} />}
        {children}
      </div>
      {!panelOpen && <UploadTray overview={overview} onOpen={() => setPanelOpen(true)} />}
    </div>
  );
}

function Rail({
  email,
  overview,
  uploadsOpen,
  onToggleUploads,
}: {
  email: string;
  overview: UploadsOverview;
  uploadsOpen: boolean;
  onToggleUploads: () => void;
}) {
  const pathname = usePathname();
  const progress = overview.bytes ? overview.bytesDone / overview.bytes : 0;
  const item = (active: boolean) =>
    `relative grid size-10 place-items-center rounded-xl transition-colors ${
      active ? "bg-surface-2 text-text" : "text-faint hover:bg-surface-2/60 hover:text-text"
    }`;

  return (
    <aside className="z-50 flex w-[60px] shrink-0 flex-col items-center gap-1.5 border-r border-line bg-rail py-3">
      <Link href="/scenes" aria-label="Loupe: your scenes" className="mb-3 grid size-10 place-items-center rounded-xl hover:bg-surface-2/60">
        <LoupeMark className="size-7 drop-shadow-[0_1px_2px_rgba(20,20,18,0.15)]" />
      </Link>
      <Link href="/scenes" aria-label="Your scenes" title="Your scenes" className={item(pathname.startsWith("/scenes"))}>
        <Clapperboard className="size-[18px]" />
      </Link>
      <button
        type="button"
        onClick={onToggleUploads}
        aria-label="Uploads"
        title="Uploads"
        aria-expanded={uploadsOpen}
        className={item(uploadsOpen)}
      >
        {overview.active ? (
          <Ring value={progress} size={34} stroke={2.5} busy={overview.bytes === 0}>
            <CloudUpload className="size-4 text-tally" />
          </Ring>
        ) : (
          <CloudUpload className="size-[18px]" />
        )}
      </button>
      <div className="flex-1" />
      <Link href="/plan" aria-label="Plan and billing" title="Plan and billing" className={item(pathname === "/plan")}>
        <CreditCard className="size-[18px]" />
      </Link>
      <Link href="/team" aria-label="Team" title="Team" className={item(pathname === "/team")}>
        <Users className="size-[18px]" />
      </Link>
      <Link href="/settings" aria-label="Settings" title="Settings" className={item(pathname === "/settings")}>
        <Settings className="size-[18px]" />
      </Link>
      <div className="h-2" />
      <AccountMenu email={email} />
    </aside>
  );
}

function AccountMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !box.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account"
        className="grid size-9 place-items-center rounded-full bg-[#8a7b6a] text-[13px] font-semibold uppercase text-white ring-2 ring-rail hover:ring-line-strong"
      >
        {email[0]}
      </button>
      {open && (
        <div className="absolute bottom-0 left-12 z-50 w-64 animate-rise rounded-2xl bg-surface p-1.5 shadow-lift ring-1 ring-line">
          <div className="px-3 py-2.5">
            <p className="text-[12px] text-faint">Signed in as</p>
            <p className="truncate text-[13.5px] font-medium">{email}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <form action="/auth/signout" method="post">
            <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] text-bad hover:bg-bad-soft">
              <LogOut className="size-4" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function cardStatus(card: ShootProgress["cards"][number]) {
  if (card.problems > 0 && card.filesDone === card.files) {
    return { text: `${card.problems} couldn't be read`, tone: "bad" as const };
  }
  if (card.filesDone === card.files) return { text: "Uploaded", tone: "good" as const };
  return { text: `${formatBytes(card.bytesDone)} of ${formatBytes(card.bytes)}`, tone: "pink" as const };
}

function UploadsPanel({ overview, onClose }: { overview: UploadsOverview; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="absolute inset-y-0 left-0 z-40 flex w-[340px] max-w-[calc(100vw-60px)] animate-rise flex-col border-r border-line-strong bg-panel shadow-lift">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-[15px] font-semibold">Uploads</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close uploads"
          className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {overview.shoots.length === 0 ? (
          <div className="grid h-full place-items-center px-8 text-center">
            <div>
              <CloudUpload className="mx-auto size-12 text-surface-3" strokeWidth={1.5} />
              <p className="mt-4 font-medium">No uploads yet</p>
              <p className="mt-1 text-[13px] text-muted">Footage you drop on a scene shows up here while it uploads.</p>
            </div>
          </div>
        ) : (
          overview.shoots.map((shoot) => (
            <section key={shoot.shootId} className="border-b border-line px-4 py-4">
              <Link href={`/scenes/${shoot.shootId}`} className="flex items-baseline justify-between gap-3 hover:text-tally">
                <span className="truncate font-medium">{shoot.name || "Scene"}</span>
                <span className="shrink-0 text-[12px] text-muted">
                  {shoot.active && shoot.bytes ? `${Math.round((shoot.bytesDone / shoot.bytes) * 100)}%` : ""}
                </span>
              </Link>
              {shoot.reading !== null && <p className="mt-2 text-[12.5px] text-muted">Reading a card… {shoot.reading || ""}</p>}
              {shoot.preparing && <p className="mt-2 text-[12.5px] text-muted">Getting ready to upload…</p>}
              <ul className="mt-3 space-y-3">
                {shoot.cards.map((card) => {
                  const status = cardStatus(card);
                  return (
                    <li key={card.card} className="flex items-center gap-3">
                      <div
                        className={`grid size-9 shrink-0 place-items-center rounded-lg ${
                          status.tone === "good" ? "bg-good-soft text-good" : status.tone === "bad" ? "bg-bad-soft text-bad" : "bg-surface-2 text-muted"
                        }`}
                      >
                        {status.tone === "good" ? <Check className="size-4" /> : status.tone === "bad" ? <TriangleAlert className="size-4" /> : <CardSim className="size-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13.5px]">{card.card || "Loose files"}</span>
                          <span className={`shrink-0 text-[12px] ${status.tone === "good" ? "text-good" : status.tone === "bad" ? "text-bad" : "text-muted"}`}>
                            {status.text}
                          </span>
                        </div>
                        {status.tone === "pink" && <Bar value={card.bytes ? card.bytesDone / card.bytes : 0} className="mt-1.5" />}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {shoot.offline && (
                <p className="mt-3 flex items-center gap-2 text-[12.5px] text-warn">
                  <WifiOff className="size-3.5" /> Offline. It carries on by itself when the internet is back.
                </p>
              )}
              {shoot.retrying > 0 && !shoot.offline && <p className="mt-3 text-[12.5px] text-warn">Reconnecting on {shoot.retrying} file(s)…</p>}
              {shoot.failed.length > 0 && <p className="mt-3 text-[12.5px] text-bad">{shoot.failed.length} file(s) couldn&apos;t upload.</p>}
              {shoot.error && <p className="mt-3 text-[12.5px] text-bad">{shoot.error}</p>}
            </section>
          ))
        )}
      </div>
      {overview.active && (
        <p className="shrink-0 border-t border-line px-4 py-3 text-[12.5px] text-muted">
          Keep this tab open until every card says <span className="text-good">Uploaded</span>.
        </p>
      )}
    </aside>
  );
}

function UploadTray({ overview, onOpen }: { overview: UploadsOverview; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState<number | null>(null);

  if (overview.finishedAt && overview.finishedAt !== dismissed) {
    return (
      <div className="fixed bottom-5 right-5 z-40 flex animate-rise items-center gap-3 rounded-2xl border border-good/30 bg-surface-2/95 py-3 pl-3.5 pr-2 shadow-lift backdrop-blur-md">
        <div className="grid size-10 animate-glow place-items-center rounded-full bg-good-soft text-good">
          <Check className="size-5 animate-pop" />
        </div>
        <button type="button" onClick={onOpen} className="text-left">
          <p className="text-[13.5px] font-medium">Everything is uploaded</p>
          <p className="text-[12px] text-muted">Every file is in storage and checked.</p>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(overview.finishedAt)}
          className="grid size-7 place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-text"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }
  if (!overview.active) return null;
  const cards = overview.shoots.flatMap((s) => s.cards.filter((c) => c.filesDone < c.files)).length;
  const pct = overview.bytes ? overview.bytesDone / overview.bytes : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fixed bottom-5 right-5 z-40 flex animate-rise items-center gap-3 rounded-2xl border border-line-strong bg-surface-2/95 py-3 pl-3 pr-4 text-left shadow-lift backdrop-blur-md hover:border-pink/40"
    >
      <Ring value={pct} size={40} stroke={3.5} busy={overview.bytes === 0}>
        <span className="text-[10.5px] font-semibold">{overview.bytes ? Math.round(pct * 100) : ""}</span>
      </Ring>
      <div>
        <p className="text-[13.5px] font-medium">
          Uploading {cards > 0 ? `${cards} card${cards === 1 ? "" : "s"}` : "…"}
        </p>
        <p className="text-[12px] text-muted">
          {formatBytes(overview.bytesDone)} of {formatBytes(overview.bytes)}
          {overview.secondsLeft ? ` · ${formatTimeLeft(overview.secondsLeft)}` : ""}
        </p>
      </div>
      <ChevronUp className="size-4 text-faint" />
    </button>
  );
}
