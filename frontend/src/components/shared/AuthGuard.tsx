"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/context/AuthContext";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { token, organization, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isLoading) return;
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    if (!organization && pathname !== "/onboarding") {
      router.replace("/onboarding");
      return;
    }

    if (organization && pathname === "/onboarding") {
      router.replace("/");
    }
  }, [isLoading, token, organization, pathname, router]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-base text-secondary">
        Loading...
      </div>
    );
  }

  if (!token) return null;

  return <>{children}</>;
}
