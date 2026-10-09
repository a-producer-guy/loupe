"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// The Plan page's buttons. Subscribing, changing the card and cancelling all happen on Stripe's own pages.

async function open(path: string, body: object, fail: (message: string) => void) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (response?.ok && json?.url) window.location.assign(json.url);
  else fail(json?.error ?? "Couldn't open Stripe just now. Try again in a moment.");
}

export function ChoosePlan({ plan, label, owner }: { plan: "pro" | "studio"; label: string; owner: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!owner) return <p className="text-[12.5px] text-faint">The account&apos;s owner can change the plan.</p>;
  return (
    <Button
      variant="primary"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void open("/api/billing/plan", { plan }, (title) => (setBusy(false), toast({ tone: "bad", title })));
      }}
    >
      {busy ? "Opening Stripe…" : label}
    </Button>
  );
}

export function ManageBilling() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="text-[13px] text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void open("/api/billing/portal", {}, (title) => (setBusy(false), toast({ tone: "bad", title })));
      }}
    >
      {busy ? "Opening Stripe…" : "Card, invoices and cancelling"}
    </button>
  );
}

/** Back from Stripe's page (?paid=…): checked with Stripe, then the page shows the new plan. */
export function PlanReturn() {
  const toast = useToast();
  const router = useRouter();
  useEffect(() => {
    const paid = new URLSearchParams(window.location.search).get("paid");
    if (!paid) return;
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      const response = await fetch("/api/billing/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: paid }) }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { paid?: boolean } | null;
      toast(body?.paid ? { tone: "good", title: "Welcome aboard. Your plan is on." } : { tone: "info", title: "Stripe is still confirming it.", detail: "Your plan switches on in a moment." });
      router.refresh();
    })();
  }, [toast, router]);
  return null;
}
