"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import type { Change, VersionView } from "@/lib/footage/cut-types";

// Versions (Guy, Oct 8: "SUPER smart but an easy breezy process"). The "version N" in the top bar opens every
// version, each named by what changed. Going back to one is one click and never loses anything: it just becomes the
// newest. "In this cut" lists the changes the cut carries, each one removable on its own. ⌘Z and ⌘⇧Z step back and
// forward through the changes, anywhere on the page except while typing.

type Versions = { versions: VersionView[]; changes: Change[] };

/** Asks the versions API, and says what happened in plain words. */
export function useVersionActions(sceneId: number, onChanged: () => unknown) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  /** Redo, from the "Undone" note. */
  const redo = useCallback(async () => {
    const response = await fetch(`/api/shoots/${sceneId}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "redo" }) }).catch(() => null);
    toast(response?.ok ? { tone: "info", title: "Redone" } : { tone: "bad", title: ((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't redo just now." });
    await onChanged();
  }, [sceneId, onChanged, toast]);
  const act = useCallback(
    async (body: { action: "undo" } | { action: "redo" } | { action: "restore"; id: number; n?: number } | { action: "remove"; key: string; label: string }): Promise<boolean> => {
      setBusy(true);
      const response = await fetch(`/api/shoots/${sceneId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body.action === "restore" ? { action: "restore", id: body.id } : body.action === "remove" ? { action: "remove", key: body.key } : body),
      }).catch(() => null);
      setBusy(false);
      if (!response?.ok) {
        toast({ tone: "bad", title: ((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't do that just now. Try again in a moment." });
        return false;
      }
      const { instant } = (await response.json()) as { instant: boolean };
      const again = "Loupe is making it again from the same choices: a few minutes.";
      if (body.action === "undo") toast({ tone: "info", title: "Undone", detail: instant ? undefined : again, action: { label: "Redo", onClick: () => void redo() } });
      else if (body.action === "redo") toast({ tone: "info", title: "Redone", detail: instant ? undefined : again });
      else if (body.action === "restore") toast({ tone: "info", title: `Back to version ${body.n ?? ""}`.trim(), detail: instant ? undefined : again });
      else toast({ tone: "info", title: `Taking out: ${body.label}`, detail: "Loupe is making that version, everything else kept." });
      await onChanged();
      return true;
    },
    [sceneId, onChanged, toast, redo],
  );
  return { act, busy };
}

const ago = (iso: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function VersionsMenu({ sceneId, n, working, onChanged }: { sceneId: number; n: number; working: boolean; onChanged: () => unknown }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Versions | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const { act, busy } = useVersionActions(sceneId, onChanged);

  const load = useCallback(async () => {
    const response = await fetch(`/api/shoots/${sceneId}/versions`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) setData((await response.json()) as Versions);
  }, [sceneId]);

  // Fresh whenever it opens, or a version lands while it's open.
  useEffect(() => {
    let alive = true;
    const read = () => alive && open && void load();
    read();
    return () => {
      alive = false;
    };
  }, [open, n, load]);

  // Closes on a click outside or Esc, like every menu in Loupe.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const after = async (ok: boolean) => {
    if (!ok) return;
    setShown(null);
    await load();
  };

  return (
    <div className="vers" ref={wrap}>
      <button type="button" className="vers-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Version {n}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="vers-pop" role="dialog" aria-label="Versions">
          {!data ? (
            <p className="fine">Loading the versions…</p>
          ) : (
            <>
              {data.changes.length > 0 && (
                <div className="vers-in">
                  <div className="smk">In this cut</div>
                  <div className="vers-chips">
                    {data.changes.map((c) => (
                      <span key={c.key} className="vchip">
                        {c.label}
                        <button type="button" aria-label={`Take out: ${c.label}`} title="Take this out, keep everything else" disabled={busy} onClick={() => void act({ action: "remove", key: c.key, label: c.label }).then(after)}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="smk">Every version</div>
              <ol className="vers-list">
                {data.versions.map((v) => (
                  <li key={v.id} className={v.current ? "now" : ""}>
                    <button type="button" className="vers-row" aria-expanded={shown === v.id} onClick={() => setShown(shown === v.id ? null : v.id)}>
                      <span className="vers-n">{v.n}</span>
                      <span className="vers-l">{v.label}</span>
                      <span className="vers-t">{v.current ? "Now" : ago(v.finishedAt)}</span>
                    </button>
                    {shown === v.id && (
                      <div className="vers-x">
                        {v.preview && <video src={v.preview} controls playsInline preload="metadata" />}
                        {v.current ? (
                          <p className="fine">You&apos;re on this one.</p>
                        ) : (
                          <>
                            <button type="button" className="btn" disabled={busy || working} onClick={() => void act({ action: "restore", id: v.id, n: v.n }).then(after)}>
                              Go back to this one
                            </button>
                            <p className="fine">
                              {working
                                ? "Once Loupe finishes what it's working on."
                                : v.whole
                                  ? "Instant. Nothing is lost: it becomes the newest version, and the others stay here."
                                  : "Loupe makes it again from the same choices (a few minutes). Nothing is lost."}
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              <p className="fine vers-tip">⌘Z undoes and ⌘⇧Z redoes. While it plays, hold \ to flip to the version before.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
