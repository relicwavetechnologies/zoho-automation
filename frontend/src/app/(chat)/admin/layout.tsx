import AdminRouteGuard from "@/components/shared/AdminRouteGuard";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminRouteGuard>{children}</AdminRouteGuard>;
}
