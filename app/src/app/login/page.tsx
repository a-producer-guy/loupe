import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui/brand";
import { currentEmail, safeNext } from "@/lib/auth";
import { afterSignIn } from "@/lib/security";
import { LoginForm } from "./login-form";

export default async function LoginPage(props: PageProps<"/login">) {
  const params = await props.searchParams;
  const next = safeNext(params.next);
  // Already signed in: anyone can use Loupe, so straight in.
  if (await currentEmail()) redirect(afterSignIn(next));

  return (
    <main className="flex min-h-dvh flex-col bg-bg px-5 py-6 sm:px-8">
      <Link href="/" aria-label="Loupe home" className="self-start">
        <Wordmark className="text-[18px]" />
      </Link>
      <div className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-[420px] rounded-3xl bg-surface px-7 pb-8 pt-9 shadow-lift sm:px-9">
          <LoginForm next={next} linkFailed={params.error === "link"} />
        </div>
      </div>
      <p className="text-center text-[12px] text-faint">Loupe · made by Reelarc</p>
    </main>
  );
}
