import AppShell from "@/components/layout/AppShell";
import AuthGuard from "@/components/shared/AuthGuard";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
