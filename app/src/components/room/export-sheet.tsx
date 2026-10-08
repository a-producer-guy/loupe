"use client";

import { useState } from "react";
import type { DownloadState } from "@/components/shoots/use-download";
import { Ring } from "@/components/ui/progress";
import type { CutResult } from "@/lib/footage/cut-types";
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
  result,
  state,
  supported,
  onStart,
  onClose,
}: {
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

const cap = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);
