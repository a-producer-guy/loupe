"use client";

import { useEffect, useRef, useState } from "react";
import { whatChanged, type CutView } from "@/lib/footage/cut-types";
import { Loupe, type LoupeDept } from "@/components/loupe/loupe";
import type { RoomCut } from "@/lib/footage/cut-types";
import { scopeLabel, type Scope } from "./suite";

// The command bar from the mockup: Loupe, the mode (which department Loupe works as for the next note, like picking a
// model: Edit, Sound, Color, Preview, with ⌥1–4 or a slash), the note, what it applies to (the scope chip) and send.
// Suggestions under it change with the mode; the extras (Guy, Oct 7: off by default) are one click.

export type Dept = "edit" | "sound" | "color" | "preview";

export const MODES: Record<Dept, { name: string; color: string; d: string; k: string }> = {
  edit: { name: "Edit", color: "#E2452B", d: "Takes, timing, reactions", k: "⌥1" },
  sound: { name: "Sound", color: "#3D7BE0", d: "Dialogue, ambience, score", k: "⌥2" },
  color: { name: "Color", color: "#2E9E6B", d: "Warmth, contrast, matching shots", k: "⌥3" },
  preview: { name: "Preview", color: "#8A8A84", d: "Watch and ask. Nothing changes.", k: "⌥4" },
};
const ORDER: Dept[] = ["edit", "sound", "color", "preview"];

type Suggestion = { text: string; extra?: { extra: "establishing" | "ambience" | "score"; on: boolean } };

function suggestions(dept: Dept, scope: Scope, cut: RoomCut): Suggestion[] {
  const extras = cut.done?.result?.extras;
  const other = cut.done?.result?.partner ?? "";
  const name = other ? other.charAt(0) + other.slice(1).toLowerCase() : "";
  if (dept === "preview") return [{ text: "Why this take?" }, { text: "Which line is weakest?" }, { text: "How long is it?" }];
  if (dept === "color")
    return scope.kind === "scene" ? [{ text: "Warmer" }, { text: "Cooler" }, { text: "More contrast" }, { text: "Film look" }] : [{ text: "Warmer" }, { text: "Cooler" }, { text: "More contrast" }];
  if (dept === "sound")
    return [
      extras?.score ? { text: "No score", extra: { extra: "score", on: false } } : { text: "Add a score", extra: { extra: "score", on: true } },
      extras?.ambience ? { text: "No ambience", extra: { extra: "ambience", on: false } } : { text: "Add the room's ambience", extra: { extra: "ambience", on: true } },
      { text: "Keep the voices as recorded" },
    ];
  if (scope.kind === "line") return [{ text: "Different take" }, { text: "Add a reaction" }, { text: "Tighter" }];
  if (scope.kind === "scene")
    return [
      { text: name ? `More of ${name}'s reactions` : "More reactions" },
      { text: "Tighter" },
      extras?.establishing ? { text: "No establishing shot", extra: { extra: "establishing", on: false } } : { text: "Open on an establishing shot", extra: { extra: "establishing", on: true } },
    ];
  return [{ text: "Tighter" }, { text: "Add reactions" }];
}

const placeholder = (dept: Dept, scope: Scope) => {
  const where = scope.kind === "line" ? "this line" : scope.kind === "from" ? "from here on" : scope.kind === "who" ? "these lines" : "";
  return dept === "preview"
    ? "Ask Loupe about the cut…"
    : dept === "color"
      ? where
        ? `How should ${where} look?`
        : "How should it look?"
      : dept === "sound"
        ? where
          ? `How should ${where} sound?`
          : "How should it sound?"
        : where
          ? `What should change in ${where}?`
          : "Tell Loupe what to change…";
};

export function CommandBar({
  cut,
  dept,
  onDept,
  scope,
  onScope,
  onSend,
  onExtra,
  onUndo,
  busy,
}: {
  cut: RoomCut;
  dept: Dept;
  onDept: (d: Dept) => void;
  scope: Scope;
  onScope: (s: Scope) => void;
  onSend: (note: string) => Promise<boolean>;
  onExtra: (extra: "establishing" | "ambience" | "score", on: boolean) => Promise<boolean>;
  /** Back to the version before (there is one). */
  onUndo?: () => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<"mode" | "scope" | null>(null);
  const [focused, setFocused] = useState(false);
  const [about, setAbout] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const result = cut.done?.result;

  // A menu or the card about Loupe closes with a click anywhere outside the bar, or Esc.
  useEffect(() => {
    if (!menu && !about) return;
    const outside = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) {
        setMenu(null);
        setAbout(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setAbout(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [menu, about]);
  const lines = result?.lines ?? [];
  const M = MODES[dept];

  // ⌥1–4 switches the mode, anywhere on the page.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const n = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(e.code);
      if (n >= 0) {
        e.preventDefault();
        onDept(ORDER[n]);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onDept]);

  // What Loupe is doing (always shown while it works, Guy Oct 7), and what it last said once it's done.
  const latest = cut.latest;
  const working = Boolean(cut.working || cut.waiting);
  const last = cut.done?.direction?.notes?.at(-1);
  const replyKey = last ? `${cut.done?.id}-${last.at}-${last.reply ?? ""}` : null;
  const reply = !working && latest?.status === "done" && last?.reply && replyKey !== seen ? { text: last.reply, key: replyKey! } : null;

  // A slash picks a mode: "/sound", "/color"...
  const slash = text.startsWith("/") ? ORDER.filter((d) => d.startsWith(text.slice(1).toLowerCase()) || MODES[d].name.toLowerCase().startsWith(text.slice(1).toLowerCase())) : [];

  const send = async (note: string) => {
    const said = note.trim();
    if (!said || busy) return;
    if (said.startsWith("/") && slash.length) {
      onDept(slash[0]);
      setText("");
      return;
    }
    if (await onSend(said)) setText("");
  };

  const sugs = suggestions(dept, scope, cut);
  const narrow = scope.kind !== "scene";
  const pickScope = (s: Scope) => {
    onScope(s);
    setMenu(null);
    input.current?.focus();
  };
  const at = scope.kind === "line" || scope.kind === "from" ? scope.line : Math.max(0, lines.findIndex(() => true));
  const roles = result ? [result.client, result.partner] : [];

  return (
    <div ref={bar} className="cmd" data-mode={dept} style={{ ["--mode" as string]: M.color }}>
      {about && (
        <div className="about">
          <Loupe size={40} mood="happy" />
          <div>
            <p>
              <b>I&apos;m Loupe, a vision machine.</b> I watch every take, line it up with your script and build a first cut, so you can spend your time directing.
            </p>
            <p>I&apos;m not here to take an editor&apos;s job. I do the sorting; editors make it sing.</p>
            <small>I can be wrong: every pick comes with its reason.</small>
          </div>
        </div>
      )}
      {working && !menu && !about && <Status cut={cut} />}
      {reply && !about && !menu && !(focused && !text) && (
        <div className="reply" role="status">
          <b>Loupe</b>
          <span>{reply.text}</span>
          {!working && onUndo && (
            <button
              type="button"
              className="soft"
              title="Back to the version before (⌘Z)"
              onClick={() => {
                setSeen(reply.key);
                onUndo();
              }}
            >
              Undo
            </button>
          )}
          {!working && (
            <button type="button" onClick={() => setSeen(reply.key)}>
              OK
            </button>
          )}
        </div>
      )}
      {menu === "mode" && (
        <div className="scopemenu modemenu" role="menu" aria-label="What Loupe works on">
          <div className="smk">Loupe works as…</div>
          {ORDER.map((d) => (
            <button
              key={d}
              type="button"
              role="menuitemradio"
              aria-checked={d === dept}
              onClick={() => {
                onDept(d);
                setMenu(null);
                input.current?.focus();
              }}
            >
              <span className="ck">
                <i className="mdot" style={{ background: MODES[d].color }} />
              </span>
              <b>
                {MODES[d].name}
                <kbd>{MODES[d].k}</kbd>
              </b>
              <span>{MODES[d].d}</span>
            </button>
          ))}
        </div>
      )}
      {menu === "scope" && result && (
        <div className="scopemenu" role="menu" aria-label="What should your next note change?">
          <div className="smk">Your next note changes…</div>
          {(
            [
              { s: { kind: "scene" }, t: "Whole scene", d: "Notes can change anything in the cut" },
              { s: { kind: "line", line: at }, t: "This line", d: lines[at] ? `${lines[at].who}: ${lines[at].text}` : "" },
              { s: { kind: "from", line: at }, t: "From here on", d: "This line to the end" },
              ...roles.map((r) => ({ s: { kind: "who", who: r }, t: `${r.charAt(0) + r.slice(1).toLowerCase()}’s lines`, d: `Only the lines ${r.charAt(0) + r.slice(1).toLowerCase()} says` })),
            ] as { s: Scope; t: string; d: string }[]
          ).map((o) => (
            <button key={o.t} type="button" role="menuitemradio" aria-checked={JSON.stringify(o.s) === JSON.stringify(scope)} onClick={() => pickScope(o.s)}>
              <span className="ck">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 7.4l2.6 2.6L11 4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <b>{o.t}</b>
              <span>{o.d}</span>
            </button>
          ))}
        </div>
      )}
      {slash.length > 0 && (
        <div className="scopemenu modemenu" role="listbox" aria-label="Commands">
          {slash.map((d) => (
            <button key={d} type="button" onClick={() => (onDept(d), setText(""), input.current?.focus())}>
              <span className="ck">/</span>
              <b>{MODES[d].name.toLowerCase()}</b>
              <span>{MODES[d].d}</span>
            </button>
          ))}
        </div>
      )}
      {focused && !text && !menu && (
        <div className="sugs">
          {sugs.map((s) => (
            <button
              key={s.text}
              type="button"
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void (s.extra ? onExtra(s.extra.extra, s.extra.on) : send(s.text))}
            >
              {s.text}
            </button>
          ))}
          <span className="hint">/ for commands · ⌥1–4 to switch</span>
        </div>
      )}
      <form
        className="cmdbar"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <button type="button" className="lpbtn" aria-label="Who is Loupe?" aria-expanded={about} onClick={() => setAbout((a) => !a)}>
          <Loupe size={30} mood={busy || working ? "think" : focused ? "listen" : "idle"} dept={dept as LoupeDept} />
        </button>
        <button type="button" className="modebtn" aria-haspopup="menu" aria-expanded={menu === "mode"} title="Switch with ⌥1–⌥4, or type /" onClick={() => setMenu(menu === "mode" ? null : "mode")}>
          <i className="mdot" style={{ background: M.color }} />
          <span>{M.name}</span>
          <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 6.5L5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => (setFocused(true), setAbout(false))}
          onBlur={() => setFocused(false)}
          placeholder={result ? placeholder(dept, scope) : "Loupe is cutting the scene…"}
          disabled={!result}
          aria-label="Tell Loupe what to change"
          maxLength={500}
        />
        <button type="button" className={`scope${narrow ? " narrow" : ""}`} aria-haspopup="menu" aria-expanded={menu === "scope"} disabled={!result} onClick={() => setMenu(menu === "scope" ? null : "scope")}>
          <span className="sl">{scopeLabel(scope, lines)}</span>
          {narrow ? (
            <span
              className="x"
              role="button"
              aria-label="Back to the whole scene"
              onClick={(e) => {
                e.stopPropagation();
                onScope({ kind: "scene" });
              }}
            >
              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
          ) : (
            <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 6.5L5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <button className="send" type="submit" aria-label="Send to Loupe" disabled={!text.trim() || busy || !result}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}

/** A note's words as the bar shows them: what was asked, without the scope's preamble, short. */
const asked = (v: CutView | null) => {
  const note = v?.direction?.notes?.filter((n) => n.reply === null).at(-1)?.note ?? null;
  if (!note) return null;
  const words = note.replace(/^[^:]{0,160}(lines?|cut|sound|colour|nothing)[^:]*: /i, "").replace(/ Then: /g, " · ");
  return words.length > 70 ? `${words.slice(0, 68)}…` : words;
};

/**
 * While Loupe works: what it's on (in your words), the step, how long it's been at it, and what's queued behind it.
 * Always there until it's done, so nobody wonders whether anything is happening (Guy, Oct 7). The tab's title says
 * so too, for when the page is in the background.
 */
function Status({ cut }: { cut: RoomCut }) {
  const [now, setNow] = useState(() => Date.now());
  // Ticks the clock, and keeps the tab's title saying so (the page's own title can come back over it).
  useEffect(() => {
    const mark = "● Loupe is working · ";
    const tick = () => {
      setNow(Date.now());
      if (!document.title.startsWith(mark)) document.title = mark + document.title;
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      document.title = document.title.replace(mark, "");
    };
  }, []);
  const doing = cut.working;
  const next = cut.waiting;
  const step = cut.steps.findIndex((s) => s.key === doing?.step);
  const since = doing?.startedAt ? Math.max(0, Math.round((now - Date.parse(doing.startedAt)) / 1000)) : null;
  // In your words; else going back, or what it changes.
  const name = (v: CutView | null, fallback: string) =>
    v ? (v.direction?.restoredFrom ? "Going back to an earlier version" : (asked(v) ?? ((cut.done && whatChanged(cut.done, v)) || fallback))) : null;
  const what = name(doing, "A new version");
  const queued = name(next, "Another version");

  return (
    <div className="status" role="status" aria-live="polite">
      <Loupe size={22} mood="think" ticklish={false} />
      <div>
        {doing ? (
          <>
            <b>Working on: </b>
            <span>“{what}”</span>
            <small>
              {step >= 0 ? `${cut.steps[step].label}` : "Starting"}
              {since !== null && ` · ${Math.floor(since / 60)}:${String(since % 60).padStart(2, "0")}`}
              {" · the cut you see stays until it's ready"}
            </small>
          </>
        ) : (
          <>
            <b>Up next: </b>
            <span>“{queued}”</span>
            <small>Starting in a moment</small>
          </>
        )}
        {doing && next && (
          <small className="queued">
            Then: “{queued}”
          </small>
        )}
      </div>
    </div>
  );
}
