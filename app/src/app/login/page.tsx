import { redirect } from "next/navigation";
import { ReelarcMark, Wordmark } from "@/components/ui/brand";
import { currentEmail, findMember, safeNext } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage(props: PageProps<"/login">) {
  const params = await props.searchParams;
  const next = safeNext(params.next);
  const email = await currentEmail();
  if (email && (await findMember(email))) redirect(next);

  return (
    <main className="grid min-h-dvh bg-bg lg:grid-cols-2">
      <Artwork />
      <section className="flex flex-col px-6 py-8 sm:px-12">
        <div className="lg:hidden">
          <Wordmark className="text-[17px]" />
        </div>
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-[360px]">
            {email ? (
              <div className="animate-rise">
                <ReelarcMark className="size-10 text-text" />
                <h1 className="mt-6 text-[26px] font-semibold tracking-tight">Not on the team list yet</h1>
                <p className="mt-2 text-[14.5px] text-muted">
                  You&apos;re signed in as <span className="text-text">{email}</span>, which isn&apos;t on the Reelarc team list. Ask Guy to add you.
                </p>
                <form action="/auth/signout" method="post" className="mt-6">
                  <button className="text-[13.5px] text-muted underline underline-offset-4 hover:text-text">Use a different email</button>
                </form>
              </div>
            ) : (
              <LoginForm next={next} linkFailed={params.error === "link"} />
            )}
          </div>
        </div>
        <p className="text-center text-[12px] text-faint lg:text-left">Reelarc Footage · for the Reelarc team</p>
      </section>
    </main>
  );
}

/** Frame.io's sign-in has a glowing light arc; ours is the arc from the Reelarc logo. */
function Artwork() {
  const arc = "M -120 980 C 40 640, 260 330, 700 90";
  return (
    <div className="relative hidden overflow-hidden bg-black lg:block">
      <svg viewBox="0 0 600 900" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 size-full" aria-hidden>
        <defs>
          <linearGradient id="arcStroke" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#1d2a8f" />
            <stop offset="45%" stopColor="#8b2cf5" />
            <stop offset="78%" stopColor="#ff3d8a" />
            <stop offset="100%" stopColor="#ffe3ee" />
          </linearGradient>
          <radialGradient id="flare" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#fff4f8" stopOpacity="1" />
            <stop offset="30%" stopColor="#ff7fb0" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#ff3d8a" stopOpacity="0" />
          </radialGradient>
          <filter id="wide" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="28" />
          </filter>
          <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <path d={arc} fill="none" stroke="url(#arcStroke)" strokeWidth="90" opacity="0.55" filter="url(#wide)" />
        <path d={arc} fill="none" stroke="url(#arcStroke)" strokeWidth="14" opacity="0.9" filter="url(#soft)" />
        <path d={arc} fill="none" stroke="url(#arcStroke)" strokeWidth="2.5" />
        <circle cx="610" cy="130" r="170" fill="url(#flare)" opacity="0.55" />
      </svg>
      <div className="absolute inset-x-12 top-10">
        <Wordmark className="text-[17px]" />
      </div>
      <div className="absolute inset-x-12 bottom-12 max-w-md">
        <p className="text-[34px] font-semibold leading-[1.1] tracking-tight">
          Drop the cards.
          <br />
          <span className="text-muted">Everything else is automatic.</span>
        </p>
        <p className="mt-4 text-[14.5px] text-muted">Uploads, safety checks and Premiere proxies for every Reelarc shoot.</p>
      </div>
    </div>
  );
}
