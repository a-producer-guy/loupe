import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { listShoots } from "@/lib/footage/status";
import { signView } from "@/lib/storage";
import { ScenesBoard, ALL_SCENES } from "./scenes-board";

export default async function ScenesPage() {
  const member = await requireMember();
  const scenes = await listShoots(getDb(), member.accountId, ALL_SCENES.from, ALL_SCENES.to, signView);
  return <ScenesBoard initial={scenes} />;
}
