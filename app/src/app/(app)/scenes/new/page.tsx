import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { accountPlan, accountUsage, PLAN_LIMITS, waitingFull } from "@/lib/footage/access";
import { NewScene } from "./new-scene";

export default async function NewScenePage() {
  const member = await requireMember();
  const db = getDb();
  const plan = await accountPlan(db, member.accountId);
  const used = await accountUsage(db, member.accountId);
  // As many scenes waiting to be exported as the plan keeps: say so before anyone drops 100 GB on the page.
  const planNeeded = used.scenes >= PLAN_LIMITS[plan].scenes;
  return <NewScene planNeeded={planNeeded ? waitingFull(plan) : null} free={plan === "free" || plan === "indie"} />;
}
