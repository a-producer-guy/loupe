import { TopBar } from "@/components/shell/top-bar";
import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { accountView } from "@/lib/footage/account-view";

const ROLES: Record<string, string> = {
  owner: "Owner",
  editor: "Editor",
  director: "Director",
  viewer: "Viewer",
};

export default async function TeamPage() {
  const member = await requireMember();
  const account = await accountView(getDb(), member.accountId);
  return (
    <>
      <TopBar crumbs={[{ label: "Team" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[900px] gap-5 px-4 pb-16 pt-8 sm:px-8">
          <div>
            <h1 className="text-[30px] font-semibold tracking-[-0.035em]">Team</h1>
            <p className="mt-1 text-[14px] text-muted">{account.name}</p>
          </div>
          <div className="overflow-hidden rounded-[20px] bg-surface shadow-lift-sm ring-1 ring-line">
            {account.people.map((person) => (
              <div key={person.email} className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
                <span className="grid size-8 place-items-center rounded-full bg-[#8a7b6a] text-[12.5px] font-semibold uppercase text-white">{person.email[0]}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">
                    {person.email}
                    {person.email === member.email && <span className="font-normal text-faint"> · you</span>}
                  </p>
                </div>
                <span className="text-[13px] text-muted">{ROLES[person.role] ?? person.role}</span>
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-surface px-6 py-5 ring-1 ring-line">
            <p className="font-semibold">Inviting people comes with Studio</p>
            <p className="mt-1 text-[13.5px] text-muted">
              Editors cut and export. Directors give notes. Viewers watch cuts and comment. Team seats open with paid plans at launch.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
