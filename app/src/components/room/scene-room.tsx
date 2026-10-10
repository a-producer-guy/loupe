"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRefreshWhenSettled } from "@/components/shoots/refresh";
import { useShootDownload } from "@/components/shoots/use-download";
import { Ring } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { DropZone } from "@/components/upload/drop-zone";
import type { RoomCut } from "@/lib/footage/cut-types";
import type { ShootDetail } from "@/lib/footage/status";
import { usePolling, useShootProgress } from "@/lib/hooks";
import { CommandBar, type Dept } from "./command-bar";
import { ExportSheet } from "./export-sheet";
import { ShareSheet } from "./share-sheet";
import type { ViewerNote } from "@/lib/footage/share";
import { Ingest } from "./ingest";
import { scopeWords, Suite, type Scope } from "./suite";
import { useVersionActions, VersionsMenu } from "./versions";
import "./room.css";

// A scene in Loupe (the approved mockup, not Footage's shoot page): the footage coming in (screen 2), then the
// suite where you direct the cut (screen 3), with the command bar along the bottom. Footage can always be dropped
// onto the page: more cards, a missing file again, the script.

export function SceneRoom({ initial, initialCut }: { initial: ShootDetail; initialCut: RoomCut }) {
  const [shoot, refresh] = usePolling(`/api/shoots/${initial.id}`, "shoot", initial);
  const [cut, refreshCut] = usePolling(`/api/shoots/${initial.id}/cut`, "cut", initialCut, 4_000);
  const progress = useShootProgress(shoot.id);
  useRefreshWhenSettled(progress.active, progress.filesDone, refresh);
  const toast = useToast();
  const download = useShootDownload(shoot.id, shoot.name);
  const [dept, setDept] = useState<Dept>("edit");
  const [scope, setScope] = useState<Scope>({ kind: "scene" });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [share, refreshShare] = usePolling<{ path: string | null; notes: ViewerNote[] }>(`/api/shoots/${initial.id}/share`, "share", { path: null, notes: [] }, 10_000);
  const shareAction = async (body: object) => {
    setBusy(true);
    const response = await fetch(`/api/shoots/${shoot.id}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!response?.ok) toast({ tone: "bad", title: ((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't do that just now. Try again in a moment." });
    await Promise.all([refreshShare(), refreshCut()]);
  };

  // This tab's live progress for clips still uploading, by their path in the scene.
  const inFlight = useMemo(() => {
    const prefix = `${shoot.storagePrefix}/`;
    return Object.fromEntries(Object.entries(progress.inFlight).map(([key, value]) => [key.slice(prefix.length), value]));
  }, [progress.inFlight, shoot.storagePrefix]);

  const post = useCallback(
    async (body: object): Promise<boolean> => {
      setBusy(true);
      try {
        const response = await fetch(`/api/shoots/${shoot.id}/cut`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) {
          const error = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
          toast({ tone: "bad", title: error ?? "Loupe couldn't take that just now. Try again in a moment." });
        }
        await refreshCut();
        return response.ok;
      } catch {
        toast({ tone: "bad", title: "Couldn't reach Loupe. Check the internet connection and try again." });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [shoot.id, refreshCut, toast],
  );

  const retry = async () => {
    const response = await fetch(`/api/shoots/${shoot.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    toast(response.ok ? { tone: "info", title: "Trying those proxies again" } : { tone: "bad", title: "Couldn't retry right now", detail: "Try again in a moment." });
    void refresh();
  };

  const addScript = async (file: File): Promise<string | null> => {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(`/api/shoots/${shoot.id}/script`, { method: "POST", body: form }).catch(() => null);
    if (!response?.ok) return ((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't read that file. Try the Final Draft file (.fdx).";
    await refreshCut();
    return null;
  };

  const versions = useVersionActions(shoot.id, refreshCut);
  const working = Boolean(cut.working || cut.waiting);
  // ⌘Z / ⌘⇧Z step back and forward through the versions (not while typing: there they undo the typing).
  const { act } = versions;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z" || !cut.done) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      if (!e.repeat) void act({ action: e.shiftKey ? "redo" : "undo" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [act, cut.done]);

  // Back from Stripe's payment page (?paid=…): checked with Stripe, then straight on to exporting.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    if (!paid && !params.get("export")) return;
    window.history.replaceState(null, "", window.location.pathname);
    const settle = async () => {
      if (paid) {
        const response = await fetch("/api/billing/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: paid }) }).catch(() => null);
        const body = (await response?.json().catch(() => null)) as { paid?: boolean; kind?: string } | null;
        if (body?.paid) toast({ tone: "good", title: body.kind === "topaz" ? "Paid. Loupe is making it 4K." : "Paid. The scene is yours to export." });
        else toast({ tone: "info", title: "The payment is still going through.", detail: "Stripe will confirm it in a moment; this page catches up by itself." });
      }
      setExporting(true);
    };
    void settle();
  }, [toast]);

  const done = cut.done?.result;
  const cutting = !done && cut.latest && (cut.latest.status === "waiting" || cut.latest.status === "working");
  const phase = done ? "suite" : cutting ? "cutting" : "ingest";
  const downloading = download.state.step === "working";
  const lines = done?.lines ?? [];

  return (
    <DropZone shootId={shoot.id} shootName={shoot.name} className="flex min-h-0 flex-1 flex-col">
      {({ dragging, choose }) => (
        <div className={`room flex min-h-0 flex-1 flex-col${phase !== "ingest" ? " editing" : ""}${dragging ? " dragging" : ""}`}>
          <header className="top">
            <div className="scene">
              <Link href="/scenes" className="textlink" style={{ textDecoration: "none" }}>
                Your scenes
              </Link>
              {" / "}
              <b>{shoot.name}</b>
            </div>
            {done && <VersionsMenu sceneId={shoot.id} n={cut.versions} working={working} onChanged={refreshCut} />}
            <div className="top-r">
              {phase === "ingest" && shoot.files.total > 0 && (
                <button type="button" className="btn soft" onClick={choose}>
                  Add footage
                </button>
              )}
              {done && (
                <button type="button" className="btn soft" onClick={() => (setSharing(true), void refreshShare())}>
                  {share.path ? "Shared" : "Share"}
                </button>
              )}
              {done && (
                <button type="button" className="btn" onClick={() => setExporting(true)}>
                  {downloading ? (
                    <>
                      <Ring value={download.state.step === "working" ? download.state.bytesDone / Math.max(1, download.state.bytes) : 0} size={14} stroke={2.5} /> Exporting…
                    </>
                  ) : (
                    "Export"
                  )}
                </button>
              )}
            </div>
          </header>
          <FootageNote footage={shoot.footage} onDownload={() => setExporting(true)} />
          <main className="flex min-h-0 flex-1 flex-col">
            {phase === "ingest" ? (
              <Ingest shoot={shoot} cut={cut} progress={progress} inFlight={inFlight} onChoose={choose} onRetry={retry} onAgain={() => void post({ action: "again" })} onScript={addScript} />
            ) : (
              <Suite
                sceneId={shoot.id}
                cut={cut}
                title={shoot.name}
                stills={shoot.clips.flatMap((c) => (c.thumbUrl ? [c.thumbUrl] : []))}
                dept={dept}
                scope={scope}
                onScope={setScope}
                busy={busy}
                onPick={(line, take) => void post({ action: "pick", line, take })}
                onLead={(role) => void post({ action: "lead", role })}
                notes={share.notes}
                onNote={(id, action) => void shareAction({ action, id })}
              />
            )}
          </main>
          {phase === "suite" && (
            <CommandBar
              sceneId={shoot.id}
              cut={cut}
              dept={dept}
              onDept={setDept}
              scope={scope}
              onScope={setScope}
              busy={busy}
              onExtra={(extra, on) => post({ action: "extra", extra, on })}
              onUndo={cut.versions > 1 ? () => void act({ action: "undo" }) : undefined}
              onSend={(note) => {
                // The mode and the scope, in plain words in front of the note, so Loupe knows what it may change.
                const mode = dept === "sound" ? "About the sound" : dept === "color" ? "About the colour" : dept === "preview" ? "A question, change nothing" : null;
                return post({ action: "note", note, scope: [mode, scopeWords(scope, lines)].filter(Boolean).join(". ") || null });
              }}
            />
          )}
          {sharing && <ShareSheet path={share.path} busy={busy} onShare={() => void shareAction({ action: "on" })} onStop={() => void shareAction({ action: "off" })} onClose={() => setSharing(false)} />}
          {exporting && done && (
            <ExportSheet
              sceneId={shoot.id}
              result={done}
              state={download.state}
              supported={download.supported}
              onStart={download.start}
              onAgain={() => (setExporting(false), void post({ action: "again" }))}
              onClose={() => setExporting(false)}
            />
          )}
        </div>
      )}
    </DropZone>
  );
}

const dateWords = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric" });

/**
 * The camera originals' date (the footage cleanup, worker/src/cleanup.ts), from the first warning on: until when
 * they're kept, or that they were removed and how to bring them back. Quiet otherwise.
 */
function FootageNote({ footage, onDownload }: { footage: ShootDetail["footage"]; onDownload: () => void }) {
  if (footage.removedAt)
    return (
      <p className="footage-note">
        The camera files were removed on {dateWords(footage.removedAt)}. Your cuts, timelines and proxies are all here; drop the same cards on this page to bring the originals back.
      </p>
    );
  if (!footage.warned || footage.keep || !footage.until) return null;
  return (
    <p className="footage-note">
      Camera files kept until {dateWords(footage.until)}.{" "}
      <button type="button" className="textlink" onClick={onDownload}>
        Download them
      </button>
    </p>
  );
}

