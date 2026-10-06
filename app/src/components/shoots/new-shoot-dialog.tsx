"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { field } from "@/components/ui/field";
import { DpField } from "./dp";
import { LutSelect, useLuts } from "./luts";

export function NewShootDialog({
  open,
  today,
  onClose,
  onCreated,
}: {
  open: boolean;
  today: string;
  onClose: () => void;
  onCreated: (shoot: { id: number; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState(today);
  const [dp, setDp] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // Untouched, a new shoot gets the LUT the last shoot used.
  const { luts, lastUsedId, add } = useLuts();
  const [lutChoice, setLutChoice] = useState<number | null | undefined>(undefined);
  const lutId = lutChoice === undefined ? lastUsedId : lutChoice;

  const close = () => {
    setName("");
    setDate(today);
    setDp("");
    setLutChoice(undefined);
    setError(undefined);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title="New shoot" description="It appears on Today, ready for the cards.">
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError(undefined);
          try {
            const response = await fetch("/api/shoots", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, shootDate: date, dpName: dp.trim() || null, lutId }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error ?? "Couldn't create the shoot.");
            onCreated(data.shoot);
            close();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't create the shoot.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-muted">Name</span>
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Client name, like Jane Doe"
            autoFocus
            required
            maxLength={120}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-muted">Shoot date</span>
          <input
            type="date"
            className={`${field} [color-scheme:dark]`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-muted">DP</span>
          <DpField value={dp} onChange={setDp} />
        </label>
        <div>
          <span className="mb-1.5 block text-[12.5px] text-muted">LUT</span>
          <LutSelect
            label="LUT"
            value={lutId}
            luts={luts}
            onUploaded={add}
            onChange={(value) => setLutChoice(value === "shoot" ? null : value)}
          />
          <p className="mt-1.5 text-[12px] text-faint">Baked into the proxies so everyone sees the footage in colour. You can change it later.</p>
        </div>
        {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={saving || !name.trim()}>
          {saving ? "Creating…" : "Create shoot"}
        </Button>
      </form>
    </Dialog>
  );
}
