import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { listShoots } from "@/lib/footage/status";
import { signView } from "@/lib/storage";
import { TodayBoard } from "./today-board";

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export default async function TodayPage() {
  await requireMember();
  const shoots = await listShoots(getDb(), dayOffset(-30), dayOffset(30), signView);
  return <TodayBoard initial={shoots} />;
}
