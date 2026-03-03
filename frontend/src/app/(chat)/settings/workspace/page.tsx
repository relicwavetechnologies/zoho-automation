"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { uiToast } from "@/lib/toast";
import type { ProfileDto } from "@/types";

export default function WorkspaceSettingsPage() {
  const { token, capabilities } = useAuth();
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const load = async () => {
      setLoading(true);
      try {
        setProfile(await api.me.profile.get(token));
      } catch (error) {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [token]);

  const isAdmin = useMemo(() => {
    return capabilities.roles.some((role) => role === "admin" || role === "owner");
  }, [capabilities.roles]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Workspace
      </h1>

      <div className="rounded-xl border p-5" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        {loading ? (
          <p style={{ color: "var(--text-secondary)" }}>Loading workspace...</p>
        ) : profile ? (
          <div className="space-y-2 text-sm">
            <p><span style={{ color: "var(--text-secondary)" }}>Name:</span> {profile.workspace.name}</p>
            <p><span style={{ color: "var(--text-secondary)" }}>Slug:</span> {profile.workspace.slug}</p>
            <p><span style={{ color: "var(--text-secondary)" }}>Your role:</span> {profile.membership.role_name}</p>

            {isAdmin ? (
              <div className="pt-2">
                <Link href="/admin/members" className="underline" style={{ color: "var(--accent)" }}>
                  Go to workspace admin controls
                </Link>
              </div>
            ) : (
              <p style={{ color: "var(--text-tertiary)" }}>
                Admin controls are available to workspace admins only.
              </p>
            )}
          </div>
        ) : (
          <p style={{ color: "var(--error)" }}>Unable to load workspace details.</p>
        )}
      </div>
    </div>
  );
}
