"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loupe } from "@/components/loupe/loupe";
import type { LineInTake, RoomCut, Shot } from "@/lib/footage/cut-types";

// Screen 3 of the mockup, the suite: the picture on the left (the cut, or one line from one take while you audition),
// the filmstrip of shots under it, and the script on the right as the editing surface. Each line carries its shot,
// the reason for it, and on hover the tools for that line; "Other takes" fans out every take of the line, and plays
// just that line in each (Guy, Oct 6).

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

type Audition = { line: number; queue: string[]; take: string; multi: boolean };

export function Suite({
  cut,
  title,
  stills,
  dept,
  scope,
  onScope,
  onPick,
  onLead,
  busy,
}: {
  cut: RoomCut;
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
}) {
  const result = cut.done?.result ?? null;
  const working = cut.latest && (cut.latest.status === "waiting" || cut.latest.status === "working");
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tray, setTray] = useState<number | null>(null);
  const [aud, setAud] = useState<Audition | null>(null);
  const resume = useRef(0);

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
  const activeLine = shot ? lineOf(shot) : -1;
  const lead = result?.client ?? "";
  const whoClass = (who: string) => (who === lead ? "who-lead" : "who-other");
  const still = (take: string) => cut.takes[take]?.still ?? null;
  const setupOf = (take: string) => result?.takes.find((t) => t.take === take)?.setup ?? null;

  // The cut's own preview, unless a line is being auditioned (then that take's preview, at that line).
  const auditionTake = aud ? cut.takes[aud.take] : null;
  const auditionLine: LineInTake | null = aud && result?.lineTakes ? (result.lineTakes[aud.take]?.lines[aud.line] ?? null) : null;
  const source = aud ? (auditionTake?.preview ?? null) : cut.preview;

  useEffect(() => {
    const v = video.current;
    if (!v || !aud || !auditionLine) return;
    const start = () => {
      v.currentTime = Math.max(0, auditionLine.s - 0.25);
      void v.play().catch(() => {});
    };
    if (v.readyState >= 1) start();
    else v.addEventListener("loadedmetadata", start, { once: true });
  }, [aud, auditionLine]);

  const stopAudition = useCallback(() => {
    setAud(null);
    // Back to the cut, where it was.
    requestAnimationFrame(() => {
      const v = video.current;
      if (!v) return;
      const back = () => (v.currentTime = resume.current);
      if (v.readyState >= 1) back();
      else v.addEventListener("loadedmetadata", back, { once: true });
    });
  }, []);

  const audition = (line: number, takes: string[]) => {
    if (!takes.length) return;
    if (!aud) resume.current = video.current?.currentTime ?? 0;
    video.current?.pause();
    setAud({ line, queue: takes.slice(1), take: takes[0], multi: takes.length > 1 });
  };

  const onTime = () => {
    const v = video.current;
    if (!v) return;
    if (aud && auditionLine) {
      if (v.currentTime >= auditionLine.e + 0.3) {
        v.pause();
        if (aud.queue.length) setTimeout(() => setAud((a) => (a ? { ...a, take: a.queue[0], queue: a.queue.slice(1) } : a)), 450);
        else if (!aud.multi) setTimeout(stopAudition, 300);
      }
      return;
    }
    setTime(v.currentTime);
  };

  const seek = (seconds: number) => {
    if (aud) stopAudition();
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

  // J K L and the arrows, like an editing room (not while typing a note).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = video.current;
      if (!v || !result) return;
      if (e.key === "k" || e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "l") void v.play().catch(() => {});
      else if (e.key === "j") seek(v.currentTime - 2);
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const k = Math.max(0, Math.min(shots.length - 1, (current < 0 ? 0 : current) + (e.key === "ArrowRight" ? 1 : -1)));
        if (shots[k]) seek(shots[k].at + 0.01);
      } else if (e.key === "Escape") {
        if (aud) stopAudition();
        else if (tray !== null) setTray(null);
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
      .sort((a, b) => (b[1].lines[j]!.match - a[1].lines[j]!.match) || ((b[1].q ?? 0) - (a[1].q ?? 0)))
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

  return (
    <div className="suite">
      <div className="stage">
        <div className={`picture${playing ? "" : " paused"}${aud ? " auditioning" : ""}`}>
          {source ? (
            <video
              key={source}
              ref={video}
              src={source}
              poster={still(shots[0]?.take ?? "") ?? undefined}
              playsInline
              preload="auto"
              onTimeUpdate={onTime}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={aud ? undefined : toggle}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#121210" }}
            />
          ) : null}
          {!aud && shot && shot.kind !== "establishing" && <div className="sub">{shot.line}</div>}
          {aud && auditionLine && <div className="sub">{auditionLine.said}</div>}
          {!aud && (
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
          )}
          {!aud && shot && shot.kind !== "establishing" && (
            <div className="pic-ctx">
              <span className="chip">
                <i className="dot" aria-hidden="true" />
                <span>
                  {shot.kind === "reaction" ? `${cap(shot.who)} reacting` : `Take ${shot.take} · ${cap(shot.who)} ${shot.framing === "close" ? "close-up" : "medium"}`}
                </span>
              </span>
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
          )}
          {aud && (
            <div className="aud">
              <span className="chip">
                <i className="dot" aria-hidden="true" />
                <span>
                  <b>Take {aud.take}</b> · {cap(setupOf(aud.take)?.who ?? "")} {setupOf(aud.take)?.framing === "close" ? "close-up" : "medium"} · this line only
                </span>
              </span>
              {shotsByLine.get(aud.line)?.some((s) => s.take === aud.take) ? (
                <span className="chip">In the cut</span>
              ) : (
                <button type="button" className="chip" disabled={busy} onClick={() => (onPick(aud.line, aud.take), stopAudition())}>
                  Use take {aud.take}
                </button>
              )}
              <button type="button" className="chip" onClick={stopAudition}>
                {aud.multi ? "Stop comparing" : "Back to the cut"}
              </button>
            </div>
          )}
          {working && <WorkingVeil cut={cut} />}
        </div>
        <div className="underpic">
          <span className="tc">{tc(time)}</span>
          <span className="now">{shot ? (shot.kind === "establishing" ? "Establishing shot" : `${cap(shot.speaker)}: ${shot.line}`) : result.title}</span>
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
          <span>J K L and ← → work too</span>
        </div>
      </div>

      <div className="scriptcol">
        <div className={`page${showMarks ? "" : " hide-marks"}${playing ? " playing" : ""}${scoped ? " scoped" : ""}`}>
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
            const marks = [main?.cut === "J" || main?.cut === "L" ? `${main.cut}-cut` : null, react ? `${cap(react.who)} reacts` : null, main?.pushIn ? "push-in" : null].filter(Boolean);
            return (
              <div key={j}>
                <div
                  className={`beat${sel ? " sel" : ""}${j === activeLine && !aud ? " active live-shot" : ""}${inScope(scope, j, line.who) && scoped ? " inscope" : ""}`}
                  data-li={j}
                >
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
                  <div className="btext" onClick={() => (main ? seek(main.at + 0.01) : null, select(j))}>
                    <div className="char">{line.who}</div>
                    <div className="line">{line.text}</div>
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
                    <button type="button" onClick={() => main && seek(main.at + 0.01)}>
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
                    playing={aud?.line === j ? aud.take : null}
                    busy={busy}
                    onPlay={(takes) => audition(j, takes)}
                    onUse={(take) => onPick(j, take)}
                    onClose={() => (setTray(null), aud && stopAudition())}
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

/** Every take of one line, fanned out under it: play just that line in each, compare them all, use one. */
function Tray({
  line,
  text,
  takes,
  cut,
  inCut,
  playing,
  busy,
  onPlay,
  onUse,
  onClose,
}: {
  line: number;
  text: string;
  takes: string[];
  cut: RoomCut;
  inCut: Set<string>;
  playing: string | null;
  busy: boolean;
  onPlay: (takes: string[]) => void;
  onUse: (take: string) => void;
  onClose: () => void;
}) {
  const result = cut.done!.result!;
  return (
    <div className="tray">
      <div className="tray-k">
        <b>
          {quote(text)} in {takes.length} {takes.length === 1 ? "take" : "takes"}
        </b>
        <span>Click one to hear just this line</span>
        {takes.length > 1 && (
          <button type="button" className="cmp" onClick={() => onPlay(takes)}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 1v8l7-4z" fill="currentColor" />
            </svg>
            Compare all
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
          {takes.map((take, k) => {
            const x = result.lineTakes![take]!.lines[line]!;
            const setup = result.takes.find((t) => t.take === take)?.setup;
            const on = inCut.has(take);
            const partial = x.match < 0.85;
            const note = result.performances?.[take];
            return (
              <div key={take} className={`take${on ? " on" : ""}${playing === take ? " playing" : ""}${partial ? " flub" : ""}`} style={{ animationDelay: `${k * 40}ms` }}>
                <button type="button" className="tk-play" aria-label={`Play this line in take ${take}`} onClick={() => onPlay([take])}>
                  {cut.takes[take]?.still ? <img src={cut.takes[take]!.still!} alt="" /> : <span style={{ display: "block", aspectRatio: "16/9" }} />}
                  <span className="tk-pi">
                    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M2 1v8l7-4z" fill="#161614" />
                    </svg>
                  </span>
                  <span className="tk-dur">{(x.e - x.s).toFixed(1)} s</span>
                  <div className="tk-cap">{x.said}</div>
                </button>
                <div className="tk-foot">
                  <b>
                    Take {take} · {setup?.framing === "close" ? "CU" : "MS"}
                    {on && <em>In the cut</em>}
                  </b>
                  <span className="tk-note">{partial ? "Doesn't say all of the line" : (note ?? "Every word there")}</span>
                  {!on && (
                    <button type="button" className="tk-use" disabled={busy} onClick={() => onUse(take)}>
                      Use this take
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
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
          <span className="now">Loupe is cutting the scene. It usually takes 10 to 20 minutes; you can close this page and come back.</span>
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
