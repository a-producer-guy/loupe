import { notFound } from "next/navigation";
import { SceneRoom } from "@/components/room/scene-room";
import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { ownedShoot } from "@/lib/footage/access";
import { roomCut } from "@/lib/footage/room";
import { getShoot } from "@/lib/footage/status";
import { signView } from "@/lib/storage";

export default async function ScenePage(props: PageProps<"/scenes/[id]">) {
  const member = await requireMember();
  const id = Number((await props.params).id);
  const db = getDb();
  // Someone else's scene looks exactly like one that doesn't exist.
  const owned = Number.isSafeInteger(id) ? await ownedShoot(db, member, id) : null;
  const shoot = owned ? await getShoot(db, owned.id, signView) : null;
  if (!owned || !shoot) notFound();
  const cut = await roomCut(db, owned, member.email, member.accountId);
  return <SceneRoom initial={shoot} initialCut={cut} />;
}
