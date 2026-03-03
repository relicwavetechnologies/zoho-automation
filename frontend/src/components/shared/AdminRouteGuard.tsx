"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/context/AuthContext";

const ADMIN_ROLES = new Set(["owner", "admin"]);

export default function AdminRouteGuard({ children }: { children: React.ReactNode }) {
  const { token, membership, capabilities, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin =
    Boolean(membership && ADMIN_ROLES.has(membership.role_key)) ||
    capabilities.roles.some((role) => ADMIN_ROLES.has(role));

  useEffect(() => {
    if (isLoading) return;
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (!isAdmin) {
      router.replace("/");
    }
  }, [token, isAdmin, isLoading, router, pathname]);

  if (isLoading || !token) return null;
  if (!isAdmin) return null;

  return <>{children}</>;
}
