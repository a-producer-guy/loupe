"use client";

import { useCallback, useEffect, useState } from "react";
import type { DownloadKind, DownloadState } from "@/components/shoots/use-download";
import { Ring } from "@/components/ui/progress";
import { exportable, FINISHING_SOUND, type CutResult, type FinalView } from "@/lib/footage/cut-types";
import type { SceneBilling } from "@/lib/billing";
import { formatBytes } from "@/lib/footage/names";

// Export (the mockup's "Premiere timeline" sheet): the final file, then a download of the parts you want, ticked (Guy,
// Oct 10: "all neat for them"), into one folder laid out as in Loupe (Final/, "Loupe Cut/" with the timeline, preview
// and cleaned sound, LUTs/, Proxies/ and, only if you need them, the camera originals in Raw/), then the steps for
// Premiere or Resolve. The timeline is Final Cut Pro 7 XML, which both import. The download carries on if this
// closes (the Downloads panel shows it).
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
  /** The final files as given, instead of asked of the server (the landing page's demo, which needs no unlocking). */
  final?: FinalState;
  /** Make the version again (one cut before finals existed). */
  onAgain: () => void;
  result: CutResult;
  state: DownloadState;
  supported: boolean;
  onStart: (kinds: ReadonlySet<DownloadKind>) => Promise<DownloadState | null>;
  onClose: () => void;
}) {
  const [app, setApp] = useState<App>("premiere");
  const [asked, setBilling] = useState<SceneBilling | null>(null);
  // The demo has nothing to unlock.
  const billing: SceneBilling | null = final ? { unlocked: true, next: { kind: "pay", cents: 0 } } : asked;
  const loadBilling = useCallback(async () => {
    const response = await fetch(`/api/shoots/${sceneId}/unlock`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) setBilling(((await response.json()) as { billing: SceneBilling }).billing);
  }, [sceneId]);
  useEffect(() => {
    // An effect that only subscribes to the server: what exporting this scene takes (nothing, in the demo).
    if (final) return;
    let alive = true;
    const read = () => alive && void loadBilling();
    read();
    return () => {
      alive = false;
    };
  }, [loadBilling, final]);
  const xml = `${result.title} - Loupe cut.xml`;
  const working = state.step === "working";
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
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="exportH" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-card">
        <h2 id="exportH">Export</h2>
        {!billing ? (
          <p className="fine">One moment…</p>
        ) : !billing.unlocked ? (
          <Unlock sceneId={sceneId} billing={billing} onUnlocked={loadBilling} />
        ) : !exportable(result) ? (
          // Paid for: the free preview is being made again with the studio sound, for the export.
          <div className="final-box">
            <div className="exporting">
              <Ring value={0.5} size={22} stroke={3} />
              <span>{FINISHING_SOUND}</span>
            </div>
            <p className="fine">You can close this; it&apos;s ready here when you come back.</p>
          </div>
        ) : (
          <>
            <FinalFile sceneId={sceneId} onAgain={onAgain} given={final} />
            <h3 className="sheet-k">Download</h3>
            <Download sceneId={sceneId} state={state} supported={supported} onStart={onStart} demo={Boolean(final)} />
            {state.step === "done" && (
              <>
                <div className="segctl" role="group" aria-label="Opening it in">
                  {(Object.keys(APPS) as App[]).map((a) => (
                    <button key={a} type="button" aria-pressed={app === a} onClick={() => setApp(a)}>
                      {APPS[a].name}
                    </button>
                  ))}
                </div>
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
                <p>A marker on every shot says why that take was picked.</p>
              </>
            )}
          </>
        )}

        <button type="button" className="btn soft" onClick={onClose}>
          {state.step === "done" ? "Done" : "Close"}
        </button>
      </div>
    </div>
  );
}

/**
 * Before the first export: unlocking the scene. One of the plan's scenes this month, or paid for on Stripe's page
 * (Loupe never sees the card), and back here unlocked.
 */
function Unlock({ sceneId, billing, onUnlocked }: { sceneId: number; billing: SceneBilling; onUnlocked: () => unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = billing.next;
  const go = async () => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shoots/${sceneId}/unlock`, { method: "POST" }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { unlocked?: boolean; url?: string; error?: string } | null;
    if (response?.ok && body?.url) {
      window.location.assign(body.url);
      return;
    }
    setBusy(false);
    if (!response?.ok || !body?.unlocked) setError(body?.error ?? "Couldn't unlock the scene just now. Try again in a moment.");
    else await onUnlocked();
  };
  return (
    <div className="final-box unlock">
      <div>
        <b>{next.kind === "plan" ? `Included in ${next.plan === "pro" ? "Pro" : "Studio"}` : `Export this scene · $${next.cents / 100}`}</b>
        <small>
          {next.kind === "plan"
              ? `${next.left} of your ${next.plan === "pro" ? 10 : 60} scenes left this month. The final file, and the timeline for Premiere Pro or DaVinci Resolve.`
              : "Once, for this scene: the final file from your camera originals, and the timeline for Premiere Pro or DaVinci Resolve. Make new versions and export again any time."}
        </small>
      </div>
      <button type="button" className="btn" disabled={busy} onClick={() => void go()}>
        {busy ? (next.kind === "pay" ? "Opening the payment page…" : "Unlocking…") : next.kind === "pay" ? `Pay $${next.cents / 100} and export` : "Export this scene"}
      </button>
      {next.kind === "pay" && <p className="fine">Paid securely on Stripe&apos;s page. Card, Apple Pay or Google Pay.</p>}
      {error && <p className="bad">{error}</p>}
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
    if (!response?.ok) {
      setAsking(false);
      setError(((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't ask for the final. Try again in a moment.");
      return;
    }
    const body = (await response.json()) as { final?: FinalState; checkout?: string };
    // 4K is paid for on Stripe's page; it starts once that's done.
    if (body.checkout) return window.location.assign(body.checkout);
    setAsking(false);
    if (body.final) setState(body.final);
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
              AI sharpening that fills 4K and keeps faces as they are. ${state.topazCost ?? 0} for this scene, paid on Stripe&apos;s page. It takes a while (often 15–40 minutes).
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
              {topaz?.status === "failed" ? "Try 4K again" : `Make it 4K · $${state.topazCost ?? 0}`}
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

type Part = "final" | "timeline" | "proxies" | "raw";
const PARTS: { part: Part; kinds: DownloadKind[]; name: string; what: string }[] = [
  { part: "final", kinds: ["final"], name: "The final file", what: "The MP4 to deliver, and its 4K version if you made one." },
  { part: "timeline", kinds: ["cut", "lut"], name: "Timeline for Premiere and Resolve", what: "The XML, a preview, the cleaned sound and the LUTs." },
  { part: "proxies", kinds: ["proxy"], name: "Proxies", what: "Small copies that play smoothly while you edit." },
  { part: "raw", kinds: ["raw"], name: "Camera originals", what: "Only if you don't have the cards any more. The timeline finds your own copies when you point it at them." },
];

/**
 * What to download, ticked (the camera originals only if you need them), with each part's size; then one folder.
 * The download is the app's (lib/download/manager.ts): closing this leaves it going.
 */
function Download({
  sceneId,
  state,
  supported,
  onStart,
  demo,
}: {
  sceneId: number;
  state: DownloadState;
  supported: boolean;
  onStart: (kinds: ReadonlySet<DownloadKind>) => Promise<DownloadState | null>;
  demo: boolean;
}) {
  const [sizes, setSizes] = useState<Record<Part, number> | null>(null);
  const [picked, setPicked] = useState<Set<Part>>(() => new Set(["final", "timeline", "proxies"]));
  const working = state.step === "working";
  const load = useCallback(async () => {
    const response = await fetch(`/api/shoots/${sceneId}/downloads`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const { files } = (await response.json()) as { files: { kind: DownloadKind; size: number }[] };
    const of = (kinds: DownloadKind[]) => files.filter((f) => kinds.includes(f.kind)).reduce((n, f) => n + f.size, 0);
    setSizes(Object.fromEntries(PARTS.map((p) => [p.part, of(p.kinds)])) as Record<Part, number>);
  }, [sceneId]);
  useEffect(() => {
    // An effect that only subscribes to the server: what there is to download (the final appears once it's made).
    if (demo) return;
    let alive = true;
    const read = () => alive && void load();
    read();
    const id = setInterval(read, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [load, demo]);
  const available = (p: Part) => (sizes ? sizes[p] > 0 : true);
  const chosen = PARTS.filter((p) => picked.has(p.part) && available(p.part));
  const total = sizes ? chosen.reduce((n, p) => n + sizes[p.part], 0) : null;
  const toggle = (p: Part) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  return (
    <div className="parts">
      {PARTS.map((p) => (
        <label key={p.part} className={`part${available(p.part) ? "" : " off"}`}>
          <input type="checkbox" checked={picked.has(p.part) && available(p.part)} disabled={!available(p.part) || working} onChange={() => toggle(p.part)} />
          <span>
            <b>{p.name}</b>
            <small>{available(p.part) ? p.what : p.part === "final" ? "Make the final above first." : "Not here: drop the cards on the scene to bring them back."}</small>
          </span>
          <span className="size">{sizes && available(p.part) ? formatBytes(sizes[p.part]) : ""}</span>
        </label>
      ))}
      {working ? (
        <div className="exporting">
          <Ring value={state.bytesDone / Math.max(1, state.bytes)} size={22} stroke={3} />
          <span>
            Saving {state.filesDone} of {state.files} files · {formatBytes(state.bytesDone)} of {formatBytes(state.bytes)}
          </span>
        </div>
      ) : (
        <button type="button" className="btn" disabled={!supported || chosen.length === 0 || demo} onClick={() => void onStart(new Set(chosen.flatMap((p) => p.kinds)))}>
          {state.step === "done" ? "Download again" : "Download to a folder"}
          {total ? ` · ${formatBytes(total)}` : ""}
        </button>
      )}
      {working && <p className="fine">You can close this: it keeps going, and Downloads in the sidebar shows it. Keep this tab open.</p>}
      {state.step === "done" && <p className="fine">Saved in “{state.folder}”. Downloading again skips what&apos;s already there.</p>}
      {state.step === "error" && <p className="bad">{state.message} Download again into the same folder to carry on where it stopped.</p>}
      {!supported && <p className="fine">Saving to a folder needs Chrome or Edge. The final file can still be downloaded above.</p>}
    </div>
  );
}

