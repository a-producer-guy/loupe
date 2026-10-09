"use client";

import { useCallback, useEffect, useState } from "react";
import type { DownloadState } from "@/components/shoots/use-download";
import { Ring } from "@/components/ui/progress";
import type { CutResult, FinalView } from "@/lib/footage/cut-types";
import { formatBytes } from "@/lib/footage/names";

// Export (the mockup's "Premiere timeline" sheet): pick the editing app, the scene downloads laid out as it is in
// Loupe (camera files, proxies, and the "Loupe Cut" folder with the timeline, preview and cleaned sound), then the
// steps for that app. The timeline is Final Cut Pro 7 XML, which Premiere Pro and DaVinci Resolve both import.
//
// The apps' own logos are their makers' trademarks: they go in public/brands/ only as the official files, used as
// each brand's rules allow ("works with"). Until then each choice is its name.

type App = "premiere" | "resolve";

const APPS: Record<App, { name: string; maker: string; logo: string | null; steps: (xml: string) => string[] }> = {
  premiere: {
    name: "Premiere Pro",
    maker: "Adobe",
    logo: null,
    steps: (xml) => [
      `In Premiere, File › Import, and pick “Loupe Cut/${xml}” inside the scene's folder.`,
      "If Premiere asks where a clip is, point it at the first one: it finds the rest by itself.",
      "For the proxies: select the clips in the Project panel, right-click › Proxy › Attach Proxies, and pick the Proxies folder. The Toggle Proxies button switches between proxy and full resolution.",
    ],
  },
  resolve: {
    name: "DaVinci Resolve",
    maker: "Blackmagic Design",
    logo: null,
    steps: (xml) => [
      `In Resolve, File › Import › Timeline, and pick “Loupe Cut/${xml}” inside the scene's folder.`,
      "Leave “Automatically import source clips into media pool” on. If clips show as offline, select them in the Media Pool, right-click › Relink Clips, and pick the scene's folder.",
      "For the proxies: select the clips in the Media Pool, right-click › Link Proxy Media, and pick the Proxies folder.",
    ],
  },
};

export function ExportSheet({
  sceneId,
  result,
  state,
  supported,
  onStart,
  onAgain,
  onClose,
  final,
}: {
  sceneId: number;
  /** The final files as given, instead of asked of the server (the landing page's demo). */
  final?: FinalState;
  /** Make the version again (one cut before finals existed). */
  onAgain: () => void;
  result: CutResult;
  state: DownloadState;
  supported: boolean;
  onStart: () => Promise<DownloadState | null>;
  onClose: () => void;
}) {
  const [app, setApp] = useState<App | null>(null);
  const xml = `${result.title} - Loupe cut.xml`;
  const working = state.step === "working";
  const choose = async (a: App) => {
    setApp(a);
    await onStart();
  };
  const tracks: [string, string, string][] = [
    ["V1", "The cut", "on"],
    ["V2–V3", "Alternate takes, stacked above each shot", "off"],
    ["A1", `${cap(result.client)}'s dialogue, cleaned`, "on"],
    ["A2", `${cap(result.partner)}'s dialogue, cleaned`, "on"],
    ["A3", "Alternate dialogue", "off"],
    ["A4–A5", "Camera sound, as shot", "off"],
    ["A6", "Room tone from the takes' own pauses", "on"],
    ...(result.extras?.ambience ? ([["A7–A8", "Ambience", "on"]] as [string, string, string][]) : []),
    ...(result.extras?.score ? ([[result.extras?.ambience ? "A9–A10" : "A7–A8", "Score, dipping under every line", "on"]] as [string, string, string][]) : []),
  ];

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="exportH" onClick={(e) => e.target === e.currentTarget && !working && onClose()}>
      <div className="sheet-card">
        <h2 id="exportH">{state.step === "done" && app ? `Ready for ${APPS[app].name}` : "Export"}</h2>
        <FinalFile sceneId={sceneId} onAgain={onAgain} given={final} />
        <h3 className="sheet-k">Or keep editing</h3>
        <div className="file">{xml}</div>

        {!app || state.step === "idle" || state.step === "error" ? (
          <>
            <div className="apps">
              {(Object.keys(APPS) as App[]).map((a) => (
                <button key={a} type="button" className="app-choice" disabled={!supported} onClick={() => void choose(a)}>
                  <span className="app-mark" aria-hidden="true">
                    {APPS[a].logo ? <img src={APPS[a].logo!} alt="" /> : <span>{APPS[a].name.split(" ").map((w) => w[0]).join("")}</span>}
                  </span>
                  <span>
                    <b>{APPS[a].name}</b>
                    <small>{APPS[a].maker}</small>
                  </span>
                </button>
              ))}
            </div>
            {state.step === "error" && <p className="bad">{state.message} Pick the app again to carry on where it stopped.</p>}
            {!supported && <p>Exporting saves the scene into a folder you choose, which needs Chrome or Edge.</p>}
            <p>You pick a folder; the scene goes into it as it sits in Loupe: the camera files, the proxies, and “Loupe Cut” with the timeline, a preview and the cleaned sound.</p>
          </>
        ) : working ? (
          <div className="exporting">
            <Ring value={state.bytesDone / Math.max(1, state.bytes)} size={22} stroke={3} />
            <span>
              Saving {state.filesDone} of {state.files} files · {formatBytes(state.bytesDone)} of {formatBytes(state.bytes)}
            </span>
          </div>
        ) : state.step === "done" ? (
          <>
            <ol className="steps">
              {APPS[app].steps(xml).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="tracks">
              {tracks.map(([k, what, on]) => (
                <div className="trk" key={k}>
                  <span>{k}</span>
                  <span>{what}</span>
                  <span>{on}</span>
                </div>
              ))}
            </div>
            <p>A marker on every shot says why that take was picked. Everything is in “{state.folder}”.</p>
          </>
        ) : null}

        <button type="button" className="btn" disabled={working} onClick={onClose}>
          {state.step === "done" ? "Done" : "Close"}
        </button>
      </div>
    </div>
  );
}

export type FinalState = { cutId: number | null; canMake: boolean; topazCost: number | null; finals: FinalView[] };

/**
 * The final file: the newest version built again from the camera originals at full resolution, with its look and
 * mix. Asked for here; the worker makes it (a few minutes); then it saves straight to the computer.
 */
function FinalFile({ sceneId, onAgain, given }: { sceneId: number; onAgain: () => void; given?: FinalState }) {
  const [asked, setState] = useState<FinalState | null>(null);
  const state = given ?? asked;
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/shoots/${sceneId}/final`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) setState(((await response.json()) as { final: FinalState }).final);
  }, [sceneId]);
  const original = state?.finals.find((f) => f.kind === "original") ?? null;
  const topaz = state?.finals.find((f) => f.kind === "topaz") ?? null;
  const busy = (f: FinalView | null) => Boolean(f && (f.status === "waiting" || f.status === "working"));
  const going = busy(original) || busy(topaz);
  useEffect(() => {
    // An effect that only subscribes to the server: the first read, then every few seconds while it's being made.
    if (given) return;
    let alive = true;
    const tick = () => alive && void load();
    tick();
    const id = setInterval(tick, going ? 3_000 : 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [load, going, given]);
  const make = async (kind: "original" | "topaz" = "original") => {
    if (given) return;
    setAsking(true);
    setError(null);
    const response = await fetch(`/api/shoots/${sceneId}/final`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => null);
    setAsking(false);
    if (!response?.ok) setError(((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't ask for the final. Try again in a moment.");
    else setState(((await response.json()) as { final: FinalState }).final);
  };
  if (!state) return <div className="final-box"><p className="fine">Checking the final…</p></div>;
  return (
    <div className="final-box">
      <div>
        <b>The final file</b>
        <small>Full resolution from your camera files, with the look and the mix. An MP4 to deliver.</small>
      </div>
      {!state.canMake ? (
        <p className="fine">
          This version was cut before finals existed.{" "}
          <button type="button" className="textlink" onClick={onAgain}>
            Make it again
          </button>{" "}
          (a few minutes), then come back here.
        </p>
      ) : original?.status === "done" && original.download ? (
        <a className="btn" href={original.download}>
          Download the final · {original.width}×{original.height}
          {original.sizeBytes ? ` · ${formatBytes(original.sizeBytes)}` : ""}
        </a>
      ) : busy(original) && original ? (
        <div className="exporting">
          <Ring value={original.progress ?? 0} size={22} stroke={3} />
          <span>{original.status === "waiting" ? "In the queue…" : `Building it from the camera files… ${Math.round((original.progress ?? 0) * 100)}%`}</span>
        </div>
      ) : (
        <button type="button" className="btn" disabled={asking} onClick={() => void make()}>
          {original?.status === "failed" ? "Try again" : "Make the final"}
        </button>
      )}
      {original?.status === "failed" && <p className="bad">{original.error ?? "Something went wrong making the final."}</p>}
      {original?.status === "done" && (original.width ?? 0) < 3456 && (
        <div className="topaz">
          <div>
            <b>4K with Topaz</b>
            <small>
              AI sharpening that fills 4K and keeps faces as they are. About ${(state.topazCost ?? 0).toFixed(2)} for this scene, and it takes a while (often 15–40 minutes).
            </small>
          </div>
          {topaz?.status === "done" && topaz.download ? (
            <a className="btn" href={topaz.download}>
              Download the 4K version · {topaz.width}×{topaz.height}
              {topaz.sizeBytes ? ` · ${formatBytes(topaz.sizeBytes)}` : ""}
            </a>
          ) : busy(topaz) && topaz ? (
            <div className="exporting">
              <Ring value={topaz.progress ?? 0} size={22} stroke={3} />
              <span>{topaz.status === "waiting" ? "In the queue…" : (topaz.progress ?? 0) < 0.8 ? "Topaz is working on it… you can close this and come back." : "Almost there…"}</span>
            </div>
          ) : (
            <button type="button" className="btn soft" disabled={asking} onClick={() => void make("topaz")}>
              {topaz?.status === "failed" ? "Try 4K again" : `Make it 4K · about $${(state.topazCost ?? 0).toFixed(2)}`}
            </button>
          )}
          {topaz?.status === "failed" && <p className="bad">{topaz.error ?? "Something went wrong making the 4K version."}</p>}
        </div>
      )}
      {error && <p className="bad">{error}</p>}
    </div>
  );
}

const cap = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);
