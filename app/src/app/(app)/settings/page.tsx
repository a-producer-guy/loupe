import { TopBar } from "@/components/shell/top-bar";
import { requireMember } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { accountView } from "@/lib/footage/account-view";
import { AccountName } from "./account-name";

const KEEP_DAYS = { free: 30, indie: 30, pro: 60, studio: 90 } as const;

export default async function SettingsPage() {
  const member = await requireMember();
  const account = await accountView(getDb(), member.accountId);
  return (
    <>
      <TopBar crumbs={[{ label: "Settings" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[760px] gap-5 px-4 pb-16 pt-8 sm:px-8">
          <h1 className="text-[30px] font-semibold tracking-[-0.035em]">Settings</h1>

          <section className="grid gap-4 rounded-[20px] bg-surface p-6 shadow-lift-sm ring-1 ring-line">
            <AccountName initial={account.name} canEdit={member.role === "owner"} />
            <div>
              <p className="text-[13px] text-faint">Your email</p>
              <p className="mt-1 text-[15px]">{member.email}</p>
              <p className="mt-1 text-[12.5px] text-faint">You sign in with a link sent here. No password.</p>
            </div>
          </section>

          <section className="rounded-[20px] bg-surface p-6 shadow-lift-sm ring-1 ring-line">
            <p className="font-semibold">Footage</p>
            <p className="mt-1 text-[13.5px] text-muted">
              Original footage is kept {KEEP_DAYS[account.plan]} days after export. We email you 7 days and 3 days before it&apos;s deleted, with a
              download link. Cuts, timelines and proxies are kept for good.
            </p>
          </section>

          <section className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-surface p-6 shadow-lift-sm ring-1 ring-line">
            <div>
              <p className="font-semibold">Sign out</p>
              <p className="mt-1 text-[13.5px] text-muted">Uploads in this tab stop when you sign out.</p>
            </div>
            <form action="/auth/signout" method="post">
              <button className="h-9 rounded-xl px-4 text-[13.5px] font-medium text-bad ring-1 ring-line-strong hover:bg-bad-soft">Sign out</button>
            </form>
          </section>
        </div>
      </main>
    </>
  );
}
