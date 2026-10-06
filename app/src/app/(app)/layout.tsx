import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { requireMember } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  return (
    <ToastProvider>
      <AppShell email={member.email}>{children}</AppShell>
    </ToastProvider>
  );
}
