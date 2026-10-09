"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loupe } from "@/components/loupe/loupe";
import type { LineInTake, RoomCut, Shot } from "@/lib/footage/cut-types";
import type { ViewerNote } from "@/lib/footage/share";

// Screen 3 of the mockup, the suite: the cut on the left with its filmstrip, and the script on the right as the
// editing surface. Each line carries its shot, the reason for it, and on hover the tools for that line; "Other takes"
// fans out every take of the line, each playing just that line in its own card (Guy, Oct 7), while the picture stays
// on the cut. Subtitles follow the voices word by word, and the script follows the playback.

export type Scope = { kind: "scene" } | { kind: "line"; line: number } | { kind: "from"; line: number } | { kind: "who"; who: string };

const cap = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);
const tc = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const quote = (text: string) => {
  const w = text.split(/\s+/);
  return `“${w.length > 5 ? `${w.slice(0, 5).join(" ")}…` : w.join(" ")}”`;
};
export const scopeLabel = (scope: Scope, lines: { who: string; text: string }[]) =>
  scope.kind === "line"
    ? `This line · ${cap(lines[scope.line]?.who ?? "")}`
    : scope.kind === "from"
      ? "From here on"
      : scope.kind === "who"
        ? `${cap(scope.who)}’s lines`
        : "Whole scene";
/** The scope in words, put in front of the note so Loupe knows what it may change. */
export const scopeWords = (scope: Scope, lines: { who: string; text: string }[]) =>
  scope.kind === "line"
    ? `Only on ${cap(lines[scope.line]?.who ?? "")}'s line "${lines[scope.line]?.text ?? ""}"`
    : scope.kind === "from"
      ? `From the line "${lines[scope.line]?.text ?? ""}" to the end`
      : scope.kind === "who"
        ? `Only on ${cap(scope.who)}'s lines`
        : null;
export const inScope = (scope: Scope, j: number, who: string) =>
  scope.kind === "scene" || (scope.kind === "line" ? j === scope.line : scope.kind === "from" ? j >= scope.line : who === scope.who);

// Subtitles on or off, remembered on this computer.
const SUBS_KEY = "loupe.subtitles";
const subsListeners = new Set<() => void>();
const readSubs = () => {
  try {
    return localStorage.getItem(SUBS_KEY) !== "off";
  } catch {
    return true;
  }
};
const writeSubs = (on: boolean) => {
  try {
    localStorage.setItem(SUBS_KEY, on ? "on" : "off");
  } catch {
    // Private window: just for now.
  }
  subsListeners.forEach((l) => l());
};
function useSubtitles(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => (subsListeners.add(l), () => subsListeners.delete(l)),
    readSubs,
    () => true,
  );
  return [on, writeSubs];
}

export function Suite({
  cut,
  title,
  stills,
  dept,
  scope,
  onScope,
  onPick,
  onLead,
  notes = [],
  onNote,
  busy,
  embedded = false,
}: {
  cut: RoomCut;
  /** Notes viewers left on the share link, and what to do with one (pass it to Loupe, or put it aside). */
  notes?: ViewerNote[];
  onNote?: (id: number, action: "send" | "done") => void;
  /** The scene's name, until the cut has the script's own heading. */
  title: string;
  /** The scene's clip stills, for the mosaic while the first cut is made. */
  stills: string[];
  dept: "edit" | "sound" | "color" | "preview";
  scope: Scope;
  onScope: (scope: Scope) => void;
  onPick: (line: number, take: string) => void;
  onLead: (role: string | null) => void;
  busy: boolean;
  /** Shown inside another page (the landing page's demo): no keyboard shortcuts, and it never scrolls the page. */
  embedded?: boolean;
}) {
  const result = cut.done?.result ?? null;
  const working = cut.latest && (cut.latest.status === "waiting" || cut.latest.status === "working");
  const video = useRef<HTMLVideoElement>(null);
  // The version before, under the picture: holding \ flips to it at the same moment, to see and hear what changed.
  const before = useRef<HTMLVideoElement>(null);
  const [comparing, setComparing] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tray, setTray] = useState<number | null>(null);
  const [subsOn, setSubsOn] = useSubtitles();

  const lines = useMemo(() => result?.lines ?? [], [result]);
  const shots = useMemo(() => (result?.shots ?? []).filter((s) => s.kind !== "establishing" || s.seconds > 0), [result]);
  const lineOf = useCallback(
    (s: Shot) => {
      const exact = lines.findIndex((l) => l.text === s.line && l.who === s.speaker);
      return exact >= 0 ? exact : lines.findIndex((l) => l.text === s.line);
    },
    [lines],
  );
  const duration = result?.seconds ?? 0;
  const current = shots.findIndex((s) => time >= s.at && time < s.at + s.seconds);
  const shot = current >= 0 ? shots[current] : null;
  // The line being heard (cuts from Oct 7 evening know it word by word); before that, the shot's line.
  const sub = result?.subs?.find((s) => time >= s.s - 0.15 && time <= s.e + 0.35) ?? null;
  const activeLine = result?.subs ? (sub?.line ?? -1) : shot ? lineOf(shot) : -1;
  const lead = result?.client ?? "";
  const whoClass = (who: string) => (who === lead ? "who-lead" : "who-other");
  const still = (take: string) => cut.takes[take]?.still ?? null;
  const setupOf = (take: string) => result?.takes.find((t) => t.take === take)?.setup ?? null;

  // The script follows the playback: the line being heard stays in view.
  useEffect(() => {
    if (!playing || activeLine < 0 || embedded) return;
    const beat = page.current?.querySelector<HTMLElement>(`.beat[data-li="${activeLine}"]`);
    beat?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [activeLine, playing, embedded]);

  const seek = (seconds: number) => {
    const v = video.current;
    if (v) v.currentTime = Math.max(0, Math.min(duration - 0.05, seconds));
    setTime(seconds);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const compare = (on: boolean) => {
    const v = video.current;
    const b = before.current;
    if (!v || !b) return;
    if (on) {
      b.currentTime = Math.min(v.currentTime, Math.max(0, (b.duration || Infinity) - 0.05));
      if (!v.paused) void b.play().catch(() => {});
      b.muted = false;
      v.muted = true;
    } else {
      b.pause();
      b.muted = true;
      v.muted = false;
    }
    setComparing(on);
  };
  useEffect(() => {
    if (embedded) return;
    const up = (e: KeyboardEvent) => e.code === "Backslash" && compare(false);
    const away = () => compare(false);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", away);
    };
  });

  // J K L and the arrows, like an editing room, C for subtitles, and \ held to compare (not while typing a note).
  useEffect(() => {
    if (embedded) return;
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = video.current;
      if (!v || !result) return;
      if (e.code === "Backslash") {
        e.preventDefault();
        if (!e.repeat && cut.previous) compare(true);
      } else if (e.key === "k" || e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "l") void v.play().catch(() => {});
      else if (e.key === "j") seek(v.currentTime - 2);
      else if (e.key === "c") setSubsOn(!subsOn);
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const k = Math.max(0, Math.min(shots.length - 1, (current < 0 ? 0 : current) + (e.key === "ArrowRight" ? 1 : -1)));
        if (shots[k]) seek(shots[k].at + 0.01);
      } else if (e.key === "Escape") {
        if (tray !== null) setTray(null);
        else if (scope.kind !== "scene") onScope({ kind: "scene" });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const select = (j: number) => onScope({ kind: "line", line: j });
  const takesFor = (j: number) => {
    const who = lines[j]?.who;
    return Object.entries(result?.lineTakes ?? {})
      .filter(([take, x]) => x.lines[j] && setupOf(take)?.who === who)
      .sort((a, b) => b[1].lines[j]!.match - a[1].lines[j]!.match || (b[1].q ?? 0) - (a[1].q ?? 0))
      .map(([take]) => take);
  };
  const shotsByLine = useMemo(() => {
    const map = new Map<number, Shot[]>();
    for (const s of shots) {
      if (s.kind === "establishing") continue;
      const j = lineOf(s);
      if (j >= 0) map.set(j, [...(map.get(j) ?? []), s]);
    }
    return map;
  }, [shots, lineOf]);
  const scoped = scope.kind !== "scene";
  const showMarks = dept !== "preview";

  if (!result) return <Cutting cut={cut} stills={stills} title={title} />;

  const subtitle = !subsOn ? null : sub ? (
    <div className="sub">
      {sub.words.map((w, i) => (
        <span key={i} className={`w${time >= w.s ? " said" : ""}`}>
          {w.t}{" "}
        </span>
      ))}
    </div>
  ) : !result.subs && shot && shot.kind !== "establishing" ? (
    <div className="sub">{shot.line}</div>
  ) : null;

  return (
    <div className="suite">
      <div className="stage">
        <div className={`picture${playing ? "" : " paused"}`}>
          {cut.preview ? (
            <video
              ref={video}
              src={cut.preview}
              poster={still(shots[0]?.take ?? "") ?? undefined}
              playsInline
              preload="auto"
              onTimeUpdate={() => setTime(video.current?.currentTime ?? 0)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={toggle}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#121210" }}
            />
          ) : null}
          {cut.previous && cut.preview ? (
            <video
              ref={before}
              src={cut.previous}
              playsInline
              muted
              preload="auto"
              aria-hidden="true"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#121210", opacity: comparing ? 1 : 0, pointerEvents: "none" }}
            />
          ) : null}
          {comparing && <span className="chip compare">The version before</span>}
          {!comparing && subtitle}
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
          <div className="pic-ctx">
            {shot && shot.kind !== "establishing" && (
              <span className="chip">
                <i className="dot" aria-hidden="true" />
                <span>
                  {shot.kind === "reaction" ? `${cap(shot.who)} reacting` : `Take ${shot.take} · ${cap(shot.who)} ${shot.framing === "close" ? "close-up" : "medium"}`}
                </span>
              </span>
            )}
            {activeLine >= 0 && (
              <button
                type="button"
                className="chip"
                onClick={() => {
                  select(activeLine);
                  setTray(activeLine);
                }}
              >
                Other takes
              </button>
            )}
          </div>
          <button type="button" className={`chip cc${subsOn ? " on" : ""}`} aria-pressed={subsOn} title="Subtitles (C)" onClick={() => setSubsOn(!subsOn)}>
            CC
          </button>
          {working && <WorkingVeil cut={cut} />}
        </div>
        <div className="underpic">
          <span className="tc">{tc(time)}</span>
          <span className="now">{activeLine >= 0 ? `${cap(lines[activeLine].who)}: ${lines[activeLine].text}` : shot?.kind === "establishing" ? "Establishing shot" : result.title}</span>
          <span className="dur">
            {tc(duration)} · {result.counts.shots} shots
          </span>
        </div>
        <div className="stripwrap">
          <div className={`filmstrip${playing ? " live" : ""}`} aria-label="Shots in the cut. Click to jump.">
            {shots.map((s, k) => (
              <button
                type="button"
                key={`${s.n}-${k}`}
                className={`fs ${whoClass(s.who)}${s.kind === "reaction" ? " reaction" : ""}${k === current ? " on" : ""}`}
                style={{ width: `${(s.seconds / Math.max(1, duration)) * 100}%` }}
                title={`${s.kind === "reaction" ? `${cap(s.who)} reacting` : `Take ${s.take}`}: ${s.line}`}
                onClick={() => seek(s.at + 0.01)}
              >
                {still(s.take) ? <img src={still(s.take)!} alt="" /> : null}
              </button>
            ))}
            {notes
              .filter((n) => !n.sentAt && !n.doneAt)
              .map((n) => (
                <i key={n.id} className="note-pin" style={{ left: `${(n.at / Math.max(1, duration)) * 100}%` }} title={`${n.name}: ${n.note}`} />
              ))}
            <div className="ph" style={{ left: `${(time / Math.max(1, duration)) * 100}%` }} />
          </div>
        </div>
        <div className="legend">
          <span>
            <i style={{ background: "var(--lead)" }} />
            {cap(result.client)}
          </span>
          <span>
            <i style={{ background: "var(--other)" }} />
            {cap(result.partner)}
          </span>
          <span>Line on top = reaction shot</span>
          <span>J K L, ← → and C for subtitles{cut.previous ? " · hold \\ to compare with the version before" : ""}</span>
        </div>
        {notes.length > 0 && <ViewerNotes notes={notes} busy={busy} onSeek={(s) => seek(s)} onNote={onNote} />}
      </div>

      <div className="scriptcol">
        <div ref={page} className={`page${showMarks ? "" : " hide-marks"}${playing ? " playing" : ""}${scoped ? " scoped" : ""}`}>
          <div className="slug">{cut.heading ?? result.place.toUpperCase()}</div>
          <div className="slug-k">
            {result.fromTakes ? (
              <>Lines worked out from the takes. Add the script for a sharper cut.</>
            ) : (
              <>
                From the script “{result.scriptTitle}” · {Math.round(result.match * 100)}% of it found in the takes
              </>
            )}
          </div>
          <div className="slug-k lead-row">
            <span>Whose scene is it?</span>
            <span className="segctl" role="group" aria-label="Whose scene is it?">
              {[result.client, result.partner].map((role) => (
                <button key={role} type="button" disabled={busy} aria-pressed={cut.done?.leadRole === role} onClick={() => onLead(cut.done?.leadRole === role ? null : role)}>
                  {cap(role)}
                </button>
              ))}
              <button type="button" disabled={busy} aria-pressed={!cut.done?.leadRole} onClick={() => onLead(null)}>
                Both
              </button>
            </span>
          </div>
          {lines.map((line, j) => {
            const here = shotsByLine.get(j) ?? [];
            const main = here.find((s) => s.kind === "shot") ?? here[0];
            const react = here.find((s) => s.kind === "reaction");
            const sel = scope.kind === "line" && scope.line === j;
            const heardAt = result.subs?.find((s) => s.line === j)?.s;
            const playFrom = heardAt !== undefined ? Math.max(0, heardAt - 0.3) : main ? main.at + 0.01 : null;
            const marks = [main?.cut === "J" || main?.cut === "L" ? `${main.cut}-cut` : null, react ? `${cap(react.who)} reacts` : null, main?.pushIn ? "push-in" : null].filter(Boolean);
            return (
              <div key={j}>
                <div className={`beat${sel ? " sel" : ""}${j === activeLine ? " active live-shot" : ""}${inScope(scope, j, line.who) && scoped ? " inscope" : ""}`} data-li={j}>
                  <div className="bthumb">
                    {main && (
                      <>
                        <button type="button" aria-label="Takes for this line" onClick={() => (select(j), setTray(tray === j ? null : j))}>
                          {still(main.take) ? <img src={still(main.take)!} alt="" /> : <span style={{ display: "block", aspectRatio: "16/9", background: "var(--sunk)" }} />}
                        </button>
                        <div className="lab">
                          <b>Take {main.take}</b> · {main.framing === "close" ? "CU" : "MS"}
                        </div>
                      </>
                    )}
                    {react && (
                      <div className="rx">
                        {still(react.take) ? <img src={still(react.take)!} alt="" /> : null}+ {cap(react.who)}
                      </div>
                    )}
                  </div>
                  <div className="btext" onClick={() => (playFrom !== null ? seek(playFrom) : null, select(j))}>
                    <div className="char">{line.who}</div>
                    <div className="line">
                      {j === activeLine && sub
                        ? sub.words.map((w, i) => (
                            <span key={i} className={`w${time >= w.s ? " said" : ""}`}>
                              {w.t}{" "}
                            </span>
                          ))
                        : line.text}
                    </div>
                    {marks.length > 0 && (
                      <div className="marks">
                        {marks.map((m) => (
                          <span key={m}>{m}</span>
                        ))}
                      </div>
                    )}
                    {(sel || j === activeLine) && main?.why && dept !== "preview" && <div className="why">{main.why}</div>}
                  </div>
                  <div className="ltools">
                    <button type="button" onClick={() => (select(j), setTray(tray === j ? null : j))}>
                      Other takes
                    </button>
                    <button type="button" onClick={() => (playFrom !== null ? seek(playFrom) : null, void video.current?.play().catch(() => {}))}>
                      Play from here
                    </button>
                  </div>
                </div>
                {tray === j && (
                  <Tray
                    line={j}
                    text={line.text}
                    takes={takesFor(j)}
                    cut={cut}
                    inCut={new Set(here.map((s) => s.take))}
                    busy={busy}
                    onStart={() => video.current?.pause()}
                    onUse={(take) => onPick(j, take)}
                    onClose={() => setTray(null)}
                  />
                )}
              </div>
            );
          })}
          {result.dropped.length > 0 && <div className="act">Left out (missing from most takes): {result.dropped.map((d) => quote(d)).join(", ")}</div>}
        </div>
      </div>
    </div>
  );
}

/** Notes from the share link: newest work first; passed-on and put-aside ones folded away. */
function ViewerNotes({ notes, busy, onSeek, onNote }: { notes: ViewerNote[]; busy: boolean; onSeek: (s: number) => void; onNote?: (id: number, action: "send" | "done") => void }) {
  const [all, setAll] = useState(false);
  const open = notes.filter((n) => !n.sentAt && !n.doneAt).sort((a, b) => a.at - b.at);
  const handled = notes.filter((n) => n.sentAt || n.doneAt);
  if (!open.length && !all)
    return (
      <div className="room-notes viewer-notes">
        <button type="button" className="textlink fine" onClick={() => setAll(true)}>
          {handled.length} earlier {handled.length === 1 ? "note" : "notes"} from viewers
        </button>
      </div>
    );
  return (
    <div className="room-notes viewer-notes">
      <h3>
        <span>Notes from viewers{open.length ? ` · ${open.length} new` : ""}</span>
        {handled.length > 0 && (
          <button type="button" className="textlink" onClick={() => setAll(!all)}>
            {all ? "Hide earlier" : `${handled.length} earlier`}
          </button>
        )}
      </h3>
      <ol className="note-list">
        {[...open, ...(all ? handled : [])].map((n) => (
          <li key={n.id} className={n.sentAt || n.doneAt ? "sent" : ""}>
            <button type="button" className="tc" onClick={() => onSeek(n.at)}>
              {tc(n.at)}
            </button>
            <div>
              <b>{n.name}</b>
              <p>{n.note}</p>
            </div>
            <div className="acts">
              {n.sentAt ? (
                <span className="fine">Sent to Loupe</span>
              ) : n.doneAt ? (
                <span className="fine">Done</span>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => onNote?.(n.id, "send")}>
                    Send to Loupe
                  </button>
                  <button type="button" disabled={busy} onClick={() => onNote?.(n.id, "done")}>
                    Done
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Every take of one line, fanned out under it. Each card plays just that line, in the card itself; Compare all plays
 * them one after another, card by card. The cut's picture stays where it was.
 */
function Tray({
  line,
  text,
  takes,
  cut,
  inCut,
  busy,
  onStart,
  onUse,
  onClose,
}: {
  line: number;
  text: string;
  takes: string[];
  cut: RoomCut;
  inCut: Set<string>;
  busy: boolean;
  onStart: () => void;
  onUse: (take: string) => void;
  onClose: () => void;
}) {
  const result = cut.done!.result!;
  // What's playing: the card, and the ones still to come when comparing.
  const [queue, setQueue] = useState<string[]>([]);
  const playing = queue[0] ?? null;
  const play = (list: string[]) => {
    onStart();
    setQueue(list);
  };
  const comparing = queue.length > 1;
  return (
    <div className="tray">
      <div className="tray-k">
        <b>
          {quote(text)} in {takes.length} {takes.length === 1 ? "take" : "takes"}
        </b>
        <span>Click one to hear just this line</span>
        {takes.length > 1 && (
          <button type="button" className="cmp" onClick={() => (playing ? setQueue([]) : play(takes))}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              {playing ? <path d="M2 1.5h2.2v7H2zM5.8 1.5H8v7H5.8z" fill="currentColor" /> : <path d="M2 1v8l7-4z" fill="currentColor" />}
            </svg>
            {playing ? "Stop" : "Compare all"}
          </button>
        )}
        <button type="button" className="textlink" onClick={onClose}>
          Done
        </button>
      </div>
      {takes.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--ink3)" }}>No other take has this line on camera.</p>
      ) : (
        <div className="takes">
          {takes.map((take, k) => (
            <TakeCard
              key={take}
              take={take}
              x={result.lineTakes![take]!.lines[line]!}
              framing={result.takes.find((t) => t.take === take)?.setup?.framing ?? "medium"}
              note={result.performances?.[take] ?? null}
              media={cut.takes[take] ?? null}
              on={inCut.has(take)}
              playing={playing === take}
              delay={k * 40}
              busy={busy}
              onPlay={() => (playing === take ? setQueue([]) : play([take]))}
              onEnded={() => setTimeout(() => setQueue((q) => (q[0] === take ? q.slice(1) : q)), comparing ? 400 : 0)}
              onUse={() => onUse(take)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One take of the line: its own little player, from just before the line to just after it. */
function TakeCard({
  take,
  x,
  framing,
  note,
  media,
  on,
  playing,
  delay,
  busy,
  onPlay,
  onEnded,
  onUse,
}: {
  take: string;
  x: LineInTake;
  framing: "medium" | "close";
  note: string | null;
  media: { still: string | null; preview: string | null } | null;
  on: boolean;
  playing: boolean;
  delay: number;
  busy: boolean;
  onPlay: () => void;
  onEnded: () => void;
  onUse: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const from = Math.max(0, x.s - 0.25);
  const to = x.e + 0.3;
  const partial = x.match < 0.85;
  const words = x.said.split(/\s+/).filter(Boolean);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (!playing) {
      v.pause();
      return;
    }
    card.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    const start = () => {
      v.currentTime = from;
      void v.play().catch(() => {});
    };
    if (v.readyState >= 1) start();
    else v.addEventListener("loadedmetadata", start, { once: true });
  }, [playing, from]);

  const progress = playing ? Math.min(1, Math.max(0, (at - from) / (to - from))) : 0;
  // Words light up as they're heard, spread over the line's length.
  const said = playing && at >= x.s ? Math.min(words.length, Math.floor(((at - x.s) / Math.max(0.1, x.e - x.s)) * words.length) + 1) : 0;

  return (
    <div ref={card} className={`take${on ? " on" : ""}${playing ? " playing" : ""}${partial ? " flub" : ""}`} style={{ animationDelay: `${delay}ms` }}>
      <button type="button" className="tk-play" aria-label={`${playing ? "Stop" : "Play"} this line in take ${take}`} onClick={onPlay}>
        {media?.preview ? (
          <video
            ref={video}
            src={media.preview}
            poster={media.still ?? undefined}
            playsInline
            preload="metadata"
            onTimeUpdate={() => {
              const v = video.current;
              if (!v) return;
              setAt(v.currentTime);
              if (playing && v.currentTime >= to) {
                v.pause();
                onEnded();
              }
            }}
            style={{ display: "block", width: "100%", aspectRatio: "16/9", objectFit: "cover", background: "#121210" }}
          />
        ) : media?.still ? (
          <img src={media.still} alt="" />
        ) : (
          <span style={{ display: "block", aspectRatio: "16/9" }} />
        )}
        <span className="tk-pi">
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            {playing ? <path d="M2 1.5h2.2v7H2zM5.8 1.5H8v7H5.8z" fill="#161614" /> : <path d="M2 1v8l7-4z" fill="#161614" />}
          </svg>
        </span>
        <span className="tk-dur">{(x.e - x.s).toFixed(1)} s</span>
        <div className="tk-cap">
          {words.map((w, i) => (
            <span key={i} className={`w${i < said ? " said" : ""}`}>
              {w}{" "}
            </span>
          ))}
        </div>
        <i className="tk-bar" style={{ width: `${progress * 100}%` }} />
      </button>
      <div className="tk-foot">
        <b>
          Take {take} · {framing === "close" ? "CU" : "MS"}
          {on && <em>In the cut</em>}
        </b>
        <span className="tk-note">{partial ? "Doesn't say all of the line" : (note ?? "Every word there")}</span>
        {!on && (
          <button type="button" className="tk-use" disabled={busy} onClick={onUse}>
            Use this take
          </button>
        )}
      </div>
    </div>
  );
}

/** While Loupe is making a new version of a finished cut: the old one stays watchable, with a quiet note on top. */
function WorkingVeil({ cut }: { cut: RoomCut }) {
  const step = cut.steps.findIndex((s) => s.key === cut.latest?.step);
  return (
    <div className="aud" style={{ top: "auto", bottom: 14 }}>
      <span className="chip">
        <Loupe size={18} mood="think" ticklish={false} />
        <span>{step >= 0 ? `${cut.steps[step].label}…` : "Loupe is on it…"}</span>
      </span>
    </div>
  );
}

/** The first cut being made: the takes as a mosaic, and Loupe saying what it's doing. */
function Cutting({ cut, stills, title }: { cut: RoomCut; stills: string[]; title: string }) {
  const step = Math.max(0, cut.steps.findIndex((s) => s.key === cut.latest?.step));
  const waiting = !cut.latest || cut.latest.status === "waiting";
  return (
    <div className="suite">
      <div className="stage">
        <div className="picture">
          <div className="mosaic">
            {stills.slice(0, 12).map((src, i) => (
              <img key={i} src={src} alt="" className="on" />
            ))}
          </div>
          <div className="proc">
            <div className="proc-row">
              <Loupe size={54} mood="think" dept="edit" three label="Loupe" />
              <div>
                <small>{waiting ? "In the queue" : `Step ${step + 1} of ${cut.steps.length}`}</small>
                <div className="proc-text">{waiting ? "Getting ready to watch every take" : cut.steps[step].label}</div>
              </div>
            </div>
            <div className="bar">
              <i style={{ width: `${waiting ? 3 : ((step + 0.5) / cut.steps.length) * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="underpic">
          <span className="now">Loupe is cutting the scene. It usually takes 5 to 20 minutes; you can close this page and come back.</span>
        </div>
      </div>
      <div className="scriptcol">
        <div className="page locked">
          <div className="slug">{cut.heading ?? title}</div>
          <div className="slug-k">{cut.script ? `From the script “${cut.script.title}”` : "No script yet: Loupe works the lines out from the takes."}</div>
        </div>
      </div>
    </div>
  );
}
