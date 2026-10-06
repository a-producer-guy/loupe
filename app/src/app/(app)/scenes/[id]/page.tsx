import { notFound } from "next/navigation";
import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { ownedShoot } from "@/lib/footage/access";
import { getShoot } from "@/lib/footage/status";
import { signView } from "@/lib/storage";
import { ShootView } from "./shoot-view";

export default async function ScenePage(props: PageProps<"/scenes/[id]">) {
  const member = await requireMember();
  const id = Number((await props.params).id);
  const db = getDb();
  // Someone else's scene looks exactly like one that doesn't exist.
  const owned = Number.isSafeInteger(id) ? await ownedShoot(db, member, id) : null;
  const shoot = owned ? await getShoot(db, owned.id, signView) : null;
  if (!shoot) notFound();
  return <ShootView initial={shoot} />;
}
