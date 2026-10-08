"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
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
import { Ingest } from "./ingest";
import { scopeWords, Suite, type Scope } from "./suite";
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
  const download = useShootDownload(shoot.id);
  const [dept, setDept] = useState<Dept>("edit");
  const [scope, setScope] = useState<Scope>({ kind: "scene" });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

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
              {cut.versions > 1 && <span> · version {cut.versions}</span>}
            </div>
            <div className="top-r">
              {phase === "ingest" && shoot.files.total > 0 && (
                <button type="button" className="btn soft" onClick={choose}>
                  Add footage
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
          <main className="flex min-h-0 flex-1 flex-col">
            {phase === "ingest" ? (
              <Ingest shoot={shoot} cut={cut} progress={progress} inFlight={inFlight} onChoose={choose} onRetry={retry} onAgain={() => void post({ action: "again" })} onScript={addScript} />
            ) : (
              <Suite
                cut={cut}
                title={shoot.name}
                stills={shoot.clips.flatMap((c) => (c.thumbUrl ? [c.thumbUrl] : []))}
                dept={dept}
                scope={scope}
                onScope={setScope}
                busy={busy}
                onPick={(line, take) => void post({ action: "pick", line, take })}
                onLead={(role) => void post({ action: "lead", role })}
              />
            )}
          </main>
          {phase === "suite" && (
            <CommandBar
              cut={cut}
              dept={dept}
              onDept={setDept}
              scope={scope}
              onScope={setScope}
              busy={busy}
              onExtra={(extra, on) => post({ action: "extra", extra, on })}
              onSend={(note) => {
                // The mode and the scope, in plain words in front of the note, so Loupe knows what it may change.
                const mode = dept === "sound" ? "About the sound" : dept === "color" ? "About the colour" : dept === "preview" ? "A question, change nothing" : null;
                return post({ action: "note", note, scope: [mode, scopeWords(scope, lines)].filter(Boolean).join(". ") || null });
              }}
            />
          )}
          {exporting && done && (
            <ExportSheet result={done} state={download.state} supported={download.supported} onStart={download.start} onClose={() => setExporting(false)} />
          )}
        </div>
      )}
    </DropZone>
  );
}
