"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/workspace", label: "Workspace" },
  { href: "/settings/security", label: "Security" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="mx-auto flex w-full max-w-[1080px] gap-6 p-6">
      <aside
        className="w-[220px] shrink-0 rounded-xl border p-3"
        style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}
      >
        <p className="mb-3 px-2 text-xs uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
          Settings
        </p>
        <div className="space-y-1">
          {items.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-md px-3 py-2 text-sm"
                style={{
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                  backgroundColor: active ? "var(--bg-elevated)" : "transparent",
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
