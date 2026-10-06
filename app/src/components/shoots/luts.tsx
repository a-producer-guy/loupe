"use client";

import { ChevronDown, LoaderCircle, Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import type { Lut } from "@/lib/footage/luts";
import { sortCards } from "@/lib/footage/names";
import type { ShootDetail } from "@/lib/footage/status";

const byName = (a: Lut, b: Lut) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** The team's LUTs, and the one used on the most recent shoot. `add` puts a newly uploaded one in the list. */
export function useLuts() {
  const [state, setState] = useState<{ luts: Lut[]; lastUsedId: number | null }>({ luts: [], lastUsedId: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/luts", { cache: "no-store" }).catch(() => null);
      const data = response?.ok ? await response.json() : null;
      if (data && !cancelled) setState({ luts: data.luts, lastUsedId: data.lastUsedId });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const add = (lut: Lut) => setState((s) => ({ ...s, luts: [...s.luts.filter((l) => l.id !== lut.id), lut].sort(byName) }));
  return { ...state, add };
}

/** Adds a .cube file: the app hands out an upload link, the file goes straight to B2, then the app checks it. */
export async function uploadLut(file: File): Promise<Lut> {
  const start = await fetch("/api/luts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: file.name, size: file.size }),
  });
  const started = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(started.error ?? "Couldn't start uploading the LUT.");
  const put = await fetch(started.url, { method: "PUT", body: file }).catch(() => null);
  if (!put?.ok) throw new Error("The LUT didn't upload. Check the connection and try again.");
  const check = await fetch("/api/luts/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: started.key }),
  });
  const checked = await check.json().catch(() => ({}));
  if (!check.ok) throw new Error(checked.error ?? "Couldn't add the LUT.");
  return checked.lut;
}

const NONE = "none";
const SHOOT = "shoot";
const UPLOAD = "upload";

/**
 * Picks a LUT: one of the team's, none, or a new .cube file uploaded on the
 * spot. With `sameAsShoot`, there's also "use the shoot's LUT" (for a card).
 */
export function LutSelect({
  value,
  onChange,
  luts,
  onUploaded,
  sameAsShoot,
  disabled,
  label,
}: {
  value: number | null | "shoot";
  onChange: (value: number | null | "shoot") => void;
  luts: Lut[];
  onUploaded: (lut: Lut) => void;
  /** Label of the "same as the shoot" option; without it the option isn't offered. */
  sameAsShoot?: string;
  disabled?: boolean;
  label: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const current = value === "shoot" ? SHOOT : value === null ? NONE : String(value);

  return (
    <div>
      <div className="relative">
        <select
          aria-label={label}
          value={current}
          disabled={disabled || uploading}
          onChange={(event) => {
            const picked = event.target.value;
            if (picked === UPLOAD) return fileInput.current?.click();
            setError(undefined);
            onChange(picked === SHOOT ? "shoot" : picked === NONE ? null : Number(picked));
          }}
          className="h-10 w-full appearance-none truncate rounded-lg border border-line-strong bg-surface-2 pl-3 pr-9 text-[14px] text-text transition focus:border-pink focus:outline-none focus:ring-4 focus:ring-pink-soft disabled:opacity-60"
        >
          {sameAsShoot && <option value={SHOOT}>{sameAsShoot}</option>}
          <option value={NONE}>No LUT</option>
          {luts.map((lut) => (
            <option key={lut.id} value={lut.id}>
              {lut.name}
            </option>
          ))}
          <option value={UPLOAD}>Upload a LUT (.cube)…</option>
        </select>
        {uploading ? (
          <LoaderCircle className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" />
        ) : (
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".cube"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setUploading(true);
          setError(undefined);
          try {
            const lut = await uploadLut(file);
            onUploaded(lut);
            onChange(lut.id);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't add the LUT.");
          } finally {
            setUploading(false);
          }
        }}
      />
      {uploading && <p className="mt-1.5 text-[12.5px] text-muted">Uploading and checking the LUT…</p>}
      {error && <p className="mt-1.5 text-[12.5px] text-bad">{error}</p>}
    </div>
  );
}

/** The LUT chip under a shoot's name: which look its footage gets. */
export function LutChip({ shoot, onClick }: { shoot: ShootDetail; onClick: () => void }) {
  const others = shoot.cardLuts.length;
  return (
    <button
      type="button"
      onClick={onClick}
      title="The LUT the footage was shot for. It's baked into the proxies."
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12.5px] text-muted transition hover:border-line-strong hover:text-text"
    >
      <Palette className="size-3.5 shrink-0" />
      <span className="truncate">{shoot.lut ? shoot.lut.name : "No LUT"}</span>
      {others > 0 && <span className="shrink-0 text-faint">· {others === 1 ? "1 card differs" : `${others} cards differ`}</span>}
    </button>
  );
}

/**
 * The shoot's LUT, and a different one for any card filmed on another
 * camera. Each change saves at once; finished proxies are re-made with it.
 */
export function LutDialog({
  open,
  onClose,
  shoot,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  shoot: ShootDetail;
  onSaved: (result: { remade: number } | { error: string }) => void;
}) {
  const { luts, add } = useLuts();
  const [saving, setSaving] = useState(false);
  const cards = sortCards([...new Set(shoot.cards.map((c) => c.card))]);
  const overrides = new Map(shoot.cardLuts.map((c) => [c.card, c.lut?.id ?? null]));

  const save = async (body: { lutId: number | null; card?: string; sameAsShoot?: boolean }) => {
    setSaving(true);
    try {
      const response = await fetch(`/api/shoots/${shoot.id}/lut`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      onSaved(response.ok ? { remade: data.remade ?? 0 } : { error: data.error ?? "Couldn't change the LUT." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="LUT"
      description="The look the footage was shot for. It's baked into the proxies and stills, so the client and the editor see it in full colour."
    >
      <div className="space-y-5">
        <div>
          <p className="mb-1.5 text-[12.5px] text-muted">Whole scene</p>
          <LutSelect
            label="The scene's LUT"
            value={shoot.lut?.id ?? null}
            luts={luts}
            onUploaded={add}
            disabled={saving}
            onChange={(value) => void save({ lutId: value === "shoot" ? null : value })}
          />
        </div>
        {cards.length > 1 && (
          <div>
            <p className="mb-1.5 text-[12.5px] text-muted">Cards shot on another camera</p>
            <div className="space-y-2.5">
              {cards.map((card) => (
                <div key={card} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3">
                  <span className="truncate text-[13.5px] font-medium">{card || "Loose files"}</span>
                  <LutSelect
                    label={`LUT for ${card || "loose files"}`}
                    value={overrides.has(card) ? overrides.get(card)! : "shoot"}
                    sameAsShoot={`Same as the shoot (${shoot.lut?.name ?? "No LUT"})`}
                    luts={luts}
                    onUploaded={add}
                    disabled={saving}
                    onChange={(value) =>
                      void save(value === "shoot" ? { lutId: null, card, sameAsShoot: true } : { lutId: value, card })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-[12.5px] leading-relaxed text-faint">
          Proxies already made are re-made with the new LUT by themselves. The LUT file is also saved in the scene&apos;s LUTs folder
          and comes with every download, so the editor can apply the same look to the originals.
        </p>
      </div>
    </Dialog>
  );
}
