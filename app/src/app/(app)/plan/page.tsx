import { Check } from "lucide-react";
import { TopBar } from "@/components/shell/top-bar";
import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { accountView, PLANS } from "@/lib/footage/account-view";
import { formatBytes } from "@/lib/footage/names";
import { ChoosePlan, ManageBilling, PlanReturn } from "./plan-actions";

const PLAN_NAME = { free: "Free", indie: "Indie", pro: "Pro", studio: "Studio" } as const;

export default async function PlanPage() {
  const member = await requireMember();
  const account = await accountView(getDb(), member.accountId);
  const { usage, limits } = account;
  const owner = member.role === "owner";
  const sceneShare = limits.scenes ? Math.min(1, usage.scenes / limits.scenes) : 0;
  const byteShare = limits.bytes ? Math.min(1, usage.bytes / limits.bytes) : 0;

  return (
    <>
      <TopBar crumbs={[{ label: "Plan and billing" }]} />
      <PlanReturn />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1100px] gap-5 px-4 pb-16 pt-8 sm:px-8">
          <h1 className="text-[30px] font-semibold tracking-[-0.035em]">Plan and billing</h1>

          <section className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
            <div className="rounded-[20px] bg-surface p-6 shadow-lift-sm ring-1 ring-line">
              <p className="text-[13px] text-faint">Your plan</p>
              <p className="mt-1 text-[44px] font-light leading-none tracking-[-0.05em]">{PLAN_NAME[account.plan]}</p>
              <p className="mt-2 text-[14px] text-muted">
                {account.plan === "free"
                  ? "Your first scene is free: upload it, watch Loupe work, direct it and export it."
                  : account.plan === "indie"
                    ? "You pay $39 when you export a scene. Nothing else."
                    : account.billing.status === "past_due"
                      ? "Your last payment didn't go through. Stripe will try again; update your card to keep your plan."
                      : `Thanks for being on Loupe.${account.billing.periodEnd ? ` Renews ${new Date(account.billing.periodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric" })}.` : ""}`}
              </p>
              {limits.scenes !== null && (
                <div className="mt-5 grid gap-4">
                  <Meter label="Scenes waiting to export" value={`${usage.scenes} of ${limits.scenes}`} share={sceneShare} />
                  <Meter label="Their footage" value={`${formatBytes(usage.bytes)} of ${formatBytes(limits.bytes ?? 0)}`} share={byteShare} />
                </div>
              )}
            </div>
            <div className="rounded-[20px] bg-text p-6 text-white shadow-lift">
              <p className="text-[13px] text-white/55">How you pay</p>
              <p className="mt-1 text-[26px] font-medium leading-tight tracking-[-0.03em]">Only when you export</p>
              <p className="mt-2 text-[14px] text-white/70">
                Uploading, watching Loupe cut and directing your scene are free. You pay to take the Premiere timeline home.
              </p>
              <div className="mt-4 border-t border-white/15 pt-4 text-[13px] text-white/60">
                {account.billing.customer && owner ? <ManageBilling /> : "Payments are on Stripe's own page. Loupe never sees your card."}
              </div>
            </div>
          </section>

          <section className="grid gap-5 md:grid-cols-3">
            {PLANS.map((plan) => {
              const current = account.plan === plan.id;
              return (
                <div key={plan.id} className={`grid content-start gap-4 rounded-[20px] bg-surface p-6 ring-1 ${current ? "shadow-lift ring-2 ring-text" : "shadow-lift-sm ring-line"}`}>
                  <div>
                    <p className="flex items-center gap-2 text-[17px] font-semibold">
                      {plan.name}
                      {current && <span className="rounded-full bg-good-soft px-2 py-0.5 text-[11.5px] font-medium text-good">Current</span>}
                    </p>
                    <p className="mt-0.5 text-[13px] text-faint">{plan.for}</p>
                  </div>
                  <p className="text-[42px] font-light leading-none tracking-[-0.05em] tabular-nums">
                    {plan.price}
                    <span className="ml-1 text-[14px] font-normal tracking-normal text-faint">{plan.per}</span>
                  </p>
                  <ul className="grid gap-2 text-[13.5px] text-muted">
                    {[...plan.points, plan.keeps].map((point) => (
                      <li key={point} className="flex gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-good" /> {point}
                      </li>
                    ))}
                  </ul>
                  {plan.id === "indie" ? (
                    <p className="text-[12.5px] text-faint">Nothing to choose: pay when you export.</p>
                  ) : current ? (
                    <p className="text-[12.5px] text-faint">Your plan. Change or cancel it under “How you pay”.</p>
                  ) : (
                    <ChoosePlan plan={plan.id} label={`Choose ${plan.name}`} owner={owner} />
                  )}
                </div>
              );
            })}
          </section>

          <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-surface px-6 py-4 ring-1 ring-line">
            <div>
              <p className="font-semibold">Keep footage longer</p>
              <p className="text-[13.5px] text-muted">$20 per TB a month, for any scene you choose. Cuts, timelines and proxies are always kept, free.</p>
            </div>
            <span className="ml-auto text-[12.5px] text-faint">About $2 a month for a typical 100 GB scene</span>
          </section>
        </div>
      </main>
    </>
  );
}

function Meter({ label, value, share }: { label: string; value: string; share: number }) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full rounded-full ${share >= 1 ? "bg-tally" : "bg-text"}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
    </div>
  );
}
