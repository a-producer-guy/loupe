"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoupeMark } from "@/components/ui/brand";
import type { ViewerNote, WatchState } from "@/lib/footage/share";
import { usePolling } from "@/lib/hooks";
import "@/components/room/room.css";

// A share link (Guy, Oct 7): the cut to watch, with its subtitles, and notes pinned to moments. Viewers can't change
// anything; their notes go to the people on the scene.

const tc = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const NAME_KEY = "loupe.viewerName";
const noSubscription = () => () => {};
const savedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

export function WatchView({ token, initial }: { token: string; initial: WatchState }) {
  const [state, refresh] = usePolling(`/api/watch/${token}`, "watch", initial, 10_000);
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [subsOn, setSubsOn] = useState(true);
  const remembered = useSyncExternalStore(noSubscription, savedName, () => "");
  const [name, setName] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pinned, setPinned] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const cut = state.cut;
  const who = name ?? remembered;
  const sub = cut?.subs?.find((s) => time >= s.s - 0.15 && time <= s.e + 0.35) ?? null;
  const at = pinned ?? time;

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const seek = (s: number) => {
    if (video.current) video.current.currentTime = s;
    setTime(s);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        toggle();
      } else if (e.key === "c") setSubsOn((on) => !on);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });


  const send = async () => {
    if (!note.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      localStorage.setItem(NAME_KEY, who.trim());
    } catch {
      // Private window: asked again next time.
    }
    const response = await fetch(`/api/watch/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: who, at, note, cutId: cut?.id ?? null }),
    }).catch(() => null);
    setSending(false);
    if (!response?.ok) {
      setError(((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't send that. Check the internet connection and try again.");
      return;
    }
    setNote("");
    setPinned(null);
    void refresh();
  };

  const notes = [...state.notes].sort((a, b) => a.at - b.at);

  return (
    <div className="room watch" style={{ minHeight: "100dvh", background: "var(--bg)" }}>
      <header className="top">
        <span className="mark">
          <LoupeMark className="size-[22px]" />
          Loupe
        </span>
        <div className="scene">
          <b>{state.scene}</b>
        </div>
      </header>
      {!cut ? (
        <p style={{ padding: "40px 24px", color: "var(--ink2)" }}>The cut isn&apos;t ready yet. This page shows it as soon as it is.</p>
      ) : (
        <div className="suite watch-grid">
          <div className="stage">
            <div className={`picture${playing ? "" : " paused"}`}>
              <video
                ref={video}
                src={cut.preview}
                playsInline
                preload="auto"
                onTimeUpdate={() => setTime(video.current?.currentTime ?? 0)}
                onPlay={() => setPlaying(true)}
                // A note lands where the picture stops: on a pause, or wherever it's scrubbed to (Guy, Oct 8).
                onPause={() => (setPlaying(false), setPinned(video.current?.currentTime ?? time))}
                onSeeked={() => setPinned(video.current?.currentTime ?? time)}
                onClick={toggle}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#121210" }}
              />
              {subsOn && sub && (
                <div className="sub">
                  {sub.words.map((w, i) => (
                    <span key={i} className={`w${time >= w.s ? " said" : ""}`}>
                      {w.t}{" "}
                    </span>
                  ))}
                </div>
              )}
              <button type="button" className="pp" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
                <span>
                  {playing ? (
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                      <path d="M5 3h3v12H5zM10 3h3v12h-3z" fill="#161614" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                      <path d="M5 2.5v13l11-6.5z" fill="#161614" />
                    </svg>
                  )}
                </span>
              </button>
              <button type="button" className={`chip cc${subsOn ? " on" : ""}`} aria-pressed={subsOn} title="Subtitles (C)" onClick={() => setSubsOn(!subsOn)}>
                CC
              </button>
            </div>
            <div className="underpic">
              <span className="tc">{tc(time)}</span>
              <span className="now">{cut.title}</span>
              <span className="dur">{tc(cut.seconds)}</span>
            </div>
            <div className="stripwrap">
              <div className="filmstrip watch-strip" aria-label="The cut. Click to jump.">
                {cut.shots.map((s, k) => (
                  <button
                    type="button"
                    key={k}
                    className={`fs ${s.who === cut.lead ? "who-lead" : "who-other"}${s.kind === "reaction" ? " reaction" : ""}`}
                    style={{ width: `${(s.seconds / Math.max(1, cut.seconds)) * 100}%` }}
                    onClick={() => seek(s.at + 0.01)}
                  />
                ))}
                {notes.map((n) => (
                  <i key={n.id} className="note-pin" style={{ left: `${(n.at / Math.max(1, cut.seconds)) * 100}%` }} title={`${n.name}: ${n.note}`} />
                ))}
                <div className="ph" style={{ left: `${(time / Math.max(1, cut.seconds)) * 100}%` }} />
              </div>
            </div>
          </div>

          <aside className="watch-notes">
            <h3>Notes</h3>
            <p className="fine">Pause where something should change and say what. Your notes go to the people on this scene; they decide what to do with them.</p>
            <form
              className="note-form"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input value={who} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={60} aria-label="Your name" />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onFocus={() => {
                  video.current?.pause();
                  setPinned(video.current?.currentTime ?? time);
                }}
                placeholder={`Note at ${tc(at)}…`}
                maxLength={500}
                rows={3}
                aria-label="Your note"
              />
              {error && <p className="bad">{error}</p>}
              <div className="note-send">
                <span>
                  At <b>{tc(at)}</b>
                  <span className="fine"> · pause or scrub to move it</span>
                </span>
                <button type="submit" className="btn" disabled={!note.trim() || !who.trim() || sending}>
                  {sending ? "Sending…" : "Send note"}
                </button>
              </div>
            </form>
            <ol className="note-list">
              {notes.length === 0 && <li className="fine">No notes yet.</li>}
              {notes.map((n) => (
                <NoteRow key={n.id} n={n} onSeek={() => seek(n.at)} />
              ))}
            </ol>
          </aside>
        </div>
      )}
    </div>
  );
}

function NoteRow({ n, onSeek }: { n: ViewerNote; onSeek: () => void }) {
  return (
    <li>
      <button type="button" className="tc" onClick={onSeek}>
        {tc(n.at)}
      </button>
      <div>
        <b>{n.name}</b>
        <p>{n.note}</p>
      </div>
    </li>
  );
}
