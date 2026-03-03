"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/context/AuthContext";

const ADMIN_ROLES = new Set(["owner", "admin"]);

export default function AdminRouteGuard({ children }: { children: React.ReactNode }) {
  const { token, membership, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isLoading) return;
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (!membership || !ADMIN_ROLES.has(membership.role_key)) {
      router.replace("/");
    }
  }, [token, membership, isLoading, router, pathname]);

  if (isLoading || !token) return null;
  if (!membership || !ADMIN_ROLES.has(membership.role_key)) return null;

  return <>{children}</>;
}
