"use client";

import { ArrowRight } from "lucide-react";
import { useActionState, useRef, useState, useSyncExternalStore } from "react";
import { Loupe } from "@/components/loupe/loupe";
import { buttonClass } from "@/components/ui/button";
import { sendLink, verifyCode, type LoginState } from "./actions";
import { OtpInput } from "./otp-input";

const field =
  "h-12 w-full rounded-xl border border-line-strong bg-surface px-4 text-[15px] text-text placeholder:text-faint transition focus:border-pink focus:outline-none focus:ring-4 focus:ring-pink-soft";

// Gmail users get a shortcut straight to the email.
const usesGmail = (email?: string) => /@(gmail\.com|googlemail\.com|reelarc\.com)$/i.test(email ?? "");
const RESEND_SECONDS = 60;

// A clock that ticks once a second, for the resend countdown.
const clock = {
  subscribe(listener: () => void) {
    const id = setInterval(listener, 1000);
    return () => clearInterval(id);
  },
  now: () => Math.floor(Date.now() / 1000) * 1000,
};

export function LoginForm({ next, linkFailed }: { next: string; linkFailed: boolean }) {
  const [sent, send, sending] = useActionState(sendLink, { step: "email", next } satisfies LoginState);
  const [changingEmail, setChangingEmail] = useState(false);
  const [requestedAt, setRequestedAt] = useState(0);

  const request = (form: FormData) => {
    setChangingEmail(false);
    setRequestedAt(Date.now());
    send(form);
  };

  if (sent.step === "code" && !changingEmail && !sending) {
    // Keyed by the request, so every new link starts with empty boxes and a fresh countdown.
    return (
      <CodeStep key={requestedAt} email={sent.email ?? ""} next={next} requestedAt={requestedAt} onResend={request} onChangeEmail={() => setChangingEmail(true)} />
    );
  }

  return (
    <form action={request} className="animate-rise text-center">
      <Loupe size={72} mood="idle" label="Loupe" />
      <h1 className="mt-5 text-[26px] font-semibold tracking-[-0.035em]">Sign in to Loupe</h1>
      <p className="mt-2 text-[14.5px] text-muted">No password. We&apos;ll email you a link, and if you&apos;re new, the same link makes your account.</p>
      {linkFailed && !sent.error && (
        <p className="mt-5 rounded-xl bg-warn-soft px-4 py-3 text-left text-[13.5px] text-warn">
          That sign-in link didn&apos;t work. It may have expired or opened in another browser. Ask for a new one below.
        </p>
      )}
      <input type="hidden" name="next" value={next} />
      <label className="mt-7 block text-left">
        <span className="mb-1.5 block text-[12.5px] text-muted">Email</span>
        <input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          defaultValue={sent.email}
          placeholder="you@studio.com"
          className={field}
        />
      </label>
      {sent.error && <p className="mt-3 text-[13.5px] text-bad">{sent.error}</p>}
      <button className={buttonClass("primary", "lg", "mt-5 w-full")} disabled={sending}>
        {sending ? "Sending your link…" : "Continue"}
      </button>
    </form>
  );
}

function CodeStep({
  email,
  next,
  requestedAt,
  onResend,
  onChangeEmail,
}: {
  email: string;
  next: string;
  requestedAt: number;
  onResend: (form: FormData) => void;
  onChangeEmail: () => void;
}) {
  const [checked, check, checking] = useActionState(verifyCode, { step: "code", next } satisfies LoginState);
  const [code, setCode] = useState("");
  const [seen, setSeen] = useState(checked);
  const [shakes, setShakes] = useState(0);
  const codeForm = useRef<HTMLFormElement>(null);
  const now = useSyncExternalStore(clock.subscribe, clock.now, () => requestedAt);

  // A wrong code clears the boxes and gives them a shake.
  if (checked !== seen) {
    setSeen(checked);
    if (checked.error) {
      setCode("");
      setShakes((n) => n + 1);
    }
  }

  const secondsLeft = Math.max(0, RESEND_SECONDS - Math.floor((now - requestedAt) / 1000));

  return (
    <div className="animate-rise">
      <div className="text-center">
        <Loupe size={72} mood="happy" label="Loupe" />
      </div>
      <h1 className="mt-5 text-center text-[26px] font-semibold tracking-[-0.035em]">Check your email</h1>
      <p className="mt-2 text-center text-[14.5px] text-muted">
        We sent a sign-in link to <span className="font-medium text-text">{email}</span>. Click it on this computer and you&apos;re in.
      </p>
      {usesGmail(email) && (
        <a
          href="https://mail.google.com/mail/u/0/#search/Loupe+newer_than%3A1d"
          target="_blank"
          rel="noreferrer"
          className="mx-auto mt-4 flex w-fit items-center gap-1.5 text-[14px] font-medium text-text hover:text-tally"
        >
          <GmailIcon /> Open Gmail <ArrowRight className="size-3.5" />
        </a>
      )}

      <form ref={codeForm} action={check} className="mt-8">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="code" value={code} />
        <p className="mb-2 text-[12.5px] text-muted">Or type the 6-digit code from the email</p>
        <OtpInput
          key={shakes}
          value={code}
          onChange={setCode}
          invalid={shakes > 0 && code === ""}
          onComplete={() => setTimeout(() => codeForm.current?.requestSubmit(), 0)}
        />
        <div className="mt-3 min-h-5 text-[13px]">
          {checking ? <span className="text-muted">Checking…</span> : checked.error ? <span className="text-bad">{checked.error}</span> : null}
        </div>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        {secondsLeft > 0 ? (
          <span className="text-faint tabular-nums">You can ask for a new link in 0:{String(secondsLeft).padStart(2, "0")}</span>
        ) : (
          <form action={onResend}>
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="next" value={next} />
            <button className="font-medium text-text hover:text-tally">Send a new link</button>
          </form>
        )}
        <button type="button" onClick={onChangeEmail} className="text-muted hover:text-text">
          Use a different email
        </button>
      </div>
    </div>
  );
}

function GmailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M2 6.5 12 13l10-6.5V18a2 2 0 0 1-2 2h-2V9.8l-6 3.9-6-3.9V20H4a2 2 0 0 1-2-2z" />
      <path fill="#EA4335" d="M22 6.5V6a2 2 0 0 0-3.2-1.6L12 9.2 5.2 4.4A2 2 0 0 0 2 6v.5L12 13z" />
      <path fill="#34A853" d="M18 20h2a2 2 0 0 0 2-2V6.5l-4 2.6z" />
      <path fill="#FBBC05" d="M2 6.5V18a2 2 0 0 0 2 2h2V9.1z" />
    </svg>
  );
}
