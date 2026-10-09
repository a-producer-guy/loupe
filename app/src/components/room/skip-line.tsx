"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toast";

// When free cutting is busy (the free-cutting fund is waiting for sales to refill it, lib/fund.ts), a free version
// waits in line. Paying for the scene skips the line: the cut starts now, with the studio sound, ready to export.

export function SkipLine({ sceneId, className = "btn" }: { sceneId: number; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const response = await fetch(`/api/shoots/${sceneId}/unlock`, { method: "POST" }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { unlocked?: boolean; url?: string; error?: string } | null;
    if (response?.ok && body?.url) return window.location.assign(body.url);
    setBusy(false);
    if (!response?.ok || !body?.unlocked) toast({ tone: "bad", title: body?.error ?? "Couldn't open the payment page just now. Try again in a moment." });
  };
  return (
    <button type="button" className={className} disabled={busy} onClick={() => void go()}>
      {busy ? "Opening the payment page…" : "Pay $39 to start now and export"}
    </button>
  );
}

/** What a free version waiting in line says. */
export const FUND_WAIT = "Loupe is busy with other scenes. Your free version starts soon, by itself.";
