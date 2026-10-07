"use client";

import { useRef, useState } from "react";
import { Loupe } from "@/components/loupe/loupe";
import { longDate } from "@/lib/dates";
import type { RoomCut } from "@/lib/footage/cut-types";
import { formatBytes, formatRuntime, sortCards } from "@/lib/footage/names";
import type { ClipRow, ShootDetail } from "@/lib/footage/status";
import type { ShootProgress } from "@/lib/upload/manager";

// Screen 2 of the mockup: the footage coming in. A big, light count of what's uploaded, two thin lines (uploaded,
// proxies), the safe line, the clips as tiles by card, and a quiet side column (the script, the details). Failure
// says what happened and what to do next, in plain words (an editor's favourite part of Footage, Oct 7).

const tileState = (clip: ClipRow, inFlight: number | undefined) =>
  clip.status !== "uploaded"
    ? inFlight !== undefined
      ? "uploading"
      : "queued"
    : !clip.proxy || clip.proxy.status === "queued"
      ? "waiting"
      : clip.proxy.status === "running"
        ? "proxy"
        : "done";

const tileWords = (clip: ClipRow, inFlight: number | undefined) => {
  if (clip.status !== "uploaded") return inFlight !== undefined ? `${Math.round(inFlight * 100)}%` : "Waiting";
  if (!clip.proxy) return "Uploaded";
  if (clip.proxy.status === "running") return `Proxy ${Math.round((clip.proxy.progress ?? 0) * 100)}%`;
  if (clip.proxy.status === "queued") return "Proxy next";
  if (clip.proxy.status === "failed") return "Proxy failed";
  if (clip.proxy.status === "skipped") return "No proxy";
  return "Ready";
};

export function Ingest({
  shoot,
  cut,
  progress,
  inFlight,
  onChoose,
  onRetry,
  onAgain,
  onScript,
}: {
  shoot: ShootDetail;
  cut: RoomCut;
  progress: ShootProgress;
  inFlight: Record<string, number>;
  onChoose: () => void;
  onRetry: () => void;
  onAgain: () => void;
  onScript: (file: File) => Promise<string | null>;
}) {
  const total = shoot.files.bytesTotal;
  // The server's count of what's safely in, plus what this tab has sent of the files still on their way.
  const sending = progress.active ? shoot.clips.reduce((n, c) => (c.status !== "uploaded" && inFlight[c.path] !== undefined ? n + c.sizeBytes * inFlight[c.path] : n), 0) : 0;
  const shownUploaded = Math.min(total, shoot.files.bytesUploaded + sending);
  const videos = shoot.proxies.videos;
  const proxiesDone = shoot.proxies.done + shoot.proxies.skipped;
  const failedProxies = shoot.proxies.failed;
  const everythingIn = shoot.safeToWipe;
  const label = !shoot.files.total
    ? "Nothing here yet"
    : !everythingIn
      ? progress.offline
        ? "Reconnecting"
        : "Uploading"
      : proxiesDone + failedProxies < videos
        ? "Making proxies"
        : cut.latest?.status === "failed"
          ? "Loupe couldn't cut this one yet"
          : "Ready to cut";
  const cards = sortCards([...new Set(shoot.clips.map((c) => c.card))]);
  const failedUploads = progress.failed.length;

  if (!shoot.files.total) {
    return (
      <div className="ingest">
        <div className="ing-main">
          <div className="hello-row">
            <Loupe size={48} mood="listen" dept="edit" label="Loupe" />
            <span>
              Drop the scene&apos;s folder anywhere on this page: camera cards, sound and the script. It uploads and I get to work.
            </span>
          </div>
          <button type="button" className="btn" onClick={onChoose}>
            Choose a folder
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ingest">
      <div className="ing-main">
        <div>
          <div className="ing-k">{label}</div>
          <div className="gb">
            <span>{(shownUploaded / 1e9).toFixed(1)}</span>
            <small>of {(total / 1e9).toFixed(1)} GB</small>
          </div>
        </div>
        <div className="lines">
          <div className="pline">
            <span>Uploaded</span>
            <div className="track">
              <i style={{ width: `${total ? (shownUploaded / total) * 100 : 0}%` }} />
            </div>
            <b>
              {shoot.files.uploaded} of {shoot.files.total} files
            </b>
          </div>
          <div className="pline">
            <span>Proxies</span>
            <div className="track">
              <i style={{ width: `${videos ? (proxiesDone / videos) * 100 : 0}%` }} />
            </div>
            <b>
              {proxiesDone} of {videos}
            </b>
          </div>
        </div>

        {/* What went wrong, and what to do about it: never a riddle. */}
        {progress.offline && everythingIn === false && (
          <div className="notice">The internet dropped. Uploads carry on by themselves as soon as it&apos;s back; keep this tab open.</div>
        )}
        {failedUploads > 0 && (
          <div className="notice">
            {failedUploads === 1 ? "One file" : `${failedUploads} files`} didn&apos;t make it. Drag the same folder in again: only what&apos;s missing goes up, and nothing is doubled.
          </div>
        )}
        {failedProxies > 0 && (
          <div className="notice">
            {failedProxies === 1 ? "One clip's proxy" : `${failedProxies} clips' proxies`} couldn&apos;t be made.{" "}
            <button type="button" className="textlink" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {cut.latest?.status === "failed" && !cut.done && (
          <div className="notice">
            {cut.latest.error ?? "Something went wrong while cutting."}{" "}
            <button type="button" className="textlink" onClick={onAgain}>
              Try again
            </button>
          </div>
        )}

        {everythingIn && (
          <div className="safe">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{formatBytes(total)} uploaded and checked. Keep your own copy until you&apos;ve exported.</span>
          </div>
        )}

        <div>
          {cards.map((card) => {
            const clips = shoot.clips.filter((c) => c.card === card);
            const shown = clips.slice(0, 24);
            return (
              <section key={card || "__loose"}>
                <div className="card-k">
                  <b>{card || "Loose files"}</b>
                  <span>
                    {clips.length} {clips.length === 1 ? "clip" : "clips"} · {formatBytes(clips.reduce((n, c) => n + c.sizeBytes, 0))}
                  </span>
                </div>
                <div className="tiles">
                  {shown.map((clip) => {
                    const flight = inFlight[clip.path];
                    const state = tileState(clip, flight);
                    const bar = clip.status !== "uploaded" ? (flight ?? 0) : clip.proxy?.status === "running" ? (clip.proxy.progress ?? 0) : state === "done" ? 1 : 0;
                    return (
                      <div key={clip.id} className={`tile video ${state}`}>
                        <div className="thumb">{clip.thumbUrl ? <img src={clip.thumbUrl} alt="" loading="lazy" /> : null}</div>
                        <div className="tname">{clip.path.split("/").at(-1)}</div>
                        <div className="tmeta">
                          <span>{formatBytes(clip.sizeBytes)}</span>
                          <span className="st">{tileWords(clip, flight)}</span>
                        </div>
                        <div className="tbar">
                          <i style={{ width: `${Math.round(bar * 100)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {clips.length > shown.length && <div className="more">and {clips.length - shown.length} more</div>}
              </section>
            );
          })}
        </div>
      </div>

      <aside className="side">
        <ScriptBox cut={cut} onScript={onScript} wanted={everythingIn} />
        <div>
          <h3>Details</h3>
          <div className="dl">
            <div>
              <span>Shot</span>
              <b>{longDate(shoot.shootDate)}</b>
            </div>
            <div>
              <span>Cards</span>
              <b>{cards.length}</b>
            </div>
            <div>
              <span>Clips</span>
              <b>{videos}</b>
            </div>
            <div>
              <span>Size</span>
              <b>{formatBytes(total)}</b>
            </div>
            {shoot.runtimeSeconds > 0 && (
              <div>
                <span>Runtime</span>
                <b>{formatRuntime(shoot.runtimeSeconds)}</b>
              </div>
            )}
            {shoot.lut && (
              <div>
                <span>Look</span>
                <b>{shoot.lut.name}</b>
              </div>
            )}
            {shoot.otherFiles.count > 0 && (
              <div>
                <span>Other files</span>
                <b>{shoot.otherFiles.count}</b>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** The script: found in the folder, or a slot to drop it in (it makes the cut sharper). */
function ScriptBox({ cut, onScript, wanted }: { cut: RoomCut; onScript: (file: File) => Promise<string | null>; wanted: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(await onScript(file));
    setBusy(false);
  };
  if (cut.script) {
    return (
      <div>
        <h3>Script</h3>
        <div className="filerow">
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M4 1.5h7l3.5 3.5v11.5H4z" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6.5 8h5M6.5 10.5h5M6.5 13h3" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          {cut.script.title}
        </div>
        <p>{cut.script.roles.slice(0, 2).map((r) => r.charAt(0) + r.slice(1).toLowerCase()).join(" and ")}. Found with the scene.</p>
      </div>
    );
  }
  return (
    <div>
      <h3>Script</h3>
      <button
        type="button"
        className={`slot${wanted || over ? " want" : ""}`}
        style={{ width: "100%" }}
        disabled={busy}
        onClick={() => picker.current?.click()}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void add(e.dataTransfer.files[0]);
        }}
      >
        {busy ? "Reading the script…" : "Drop the script here: Final Draft or PDF."}
      </button>
      <p>{error ?? "Not essential: without it, Loupe works the lines out from the takes."}</p>
      <input
        ref={picker}
        type="file"
        accept=".fdx,.pdf"
        hidden
        onChange={(e) => {
          void add(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
