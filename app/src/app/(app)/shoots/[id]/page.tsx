import { notFound } from "next/navigation";
import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { getShoot } from "@/lib/footage/status";
import { signView } from "@/lib/storage";
import { ShootView } from "./shoot-view";

export default async function ShootPage(props: PageProps<"/shoots/[id]">) {
  await requireMember();
  const id = Number((await props.params).id);
  const shoot = Number.isSafeInteger(id) ? await getShoot(getDb(), id, signView) : null;
  if (!shoot) notFound();
  return <ShootView initial={shoot} />;
}
