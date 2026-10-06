"use client";

import { Video } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { field } from "@/components/ui/field";

/** DPs already typed in on shoots, most recent first. */
function useDps() {
  const [dps, setDps] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/dps", { cache: "no-store" }).catch(() => null);
      const data = response?.ok ? await response.json() : null;
      if (data && !cancelled) setDps(data.dps);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return dps;
}

/** A name box that suggests the DPs already used, so a name is spelled the same way every time. */
export function DpField({ value, onChange, autoFocus }: { value: string; onChange: (value: string) => void; autoFocus?: boolean }) {
  const dps = useDps();
  const list = useId();
  return (
    <>
      <input
        className={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Who's shooting it, like Sam Rivera"
        aria-label="DP"
        list={list}
        maxLength={80}
        autoComplete="off"
        autoFocus={autoFocus}
      />
      <datalist id={list}>
        {dps.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

/** The DP chip under a shoot's name: who shot it, or a nudge to add them. */
export function DpChip({ dpName, onClick }: { dpName: string | null; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={dpName ? "The DP who shot this. Click to change." : "Add the DP who shot this"}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border bg-surface px-2.5 py-0.5 text-[12.5px] text-muted transition hover:border-line-strong hover:text-text ${
        dpName ? "border-line" : "border-dashed border-line-strong"
      }`}
    >
      <Video className="size-3.5 shrink-0" />
      {dpName ? (
        <>
          <span className="shrink-0 text-faint">DP</span>
          <span className="truncate">{dpName}</span>
        </>
      ) : (
        <span>Add DP</span>
      )}
    </button>
  );
}

/** Adds or changes who shot a shoot. */
export function DpDialog({
  open,
  onClose,
  shootId,
  dpName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  shootId: number;
  dpName: string | null;
  onSaved: (dpName: string | null) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="DP" description="Who shot it. It shows on the shoot and on Today, and search finds shoots by it.">
      <DpForm
        shootId={shootId}
        dpName={dpName}
        onSaved={(name) => {
          onSaved(name);
          onClose();
        }}
      />
    </Dialog>
  );
}

// Inside the dialog, so it starts from the saved name every time the dialog opens.
function DpForm({ shootId, dpName, onSaved }: { shootId: number; dpName: string | null; onSaved: (dpName: string | null) => void }) {
  const [value, setValue] = useState(dpName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const typed = value.trim().replace(/\s+/g, " ");

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError(undefined);
        try {
          const response = await fetch(`/api/shoots/${shootId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dpName: typed || null }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error ?? "Couldn't save the DP.");
          onSaved(data.dpName ?? null);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Couldn't save the DP.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <DpField value={value} onChange={setValue} autoFocus />
      {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={saving || (typed || null) === dpName}>
        {saving ? "Saving…" : typed || !dpName ? "Save" : "Remove DP"}
      </Button>
    </form>
  );
}
