"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { uiToast } from "@/lib/toast";
import type { SecurityDto } from "@/types";

export default function SecuritySettingsPage() {
  const { token } = useAuth();
  const [security, setSecurity] = useState<SecurityDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const load = async () => {
      setLoading(true);
      try {
        setSecurity(await api.me.security.get(token));
      } catch (error) {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [token]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Security
      </h1>

      <div className="rounded-xl border p-5" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        {loading ? (
          <p style={{ color: "var(--text-secondary)" }}>Loading security settings...</p>
        ) : security ? (
          <div className="space-y-2 text-sm">
            <p><span style={{ color: "var(--text-secondary)" }}>Auth provider:</span> {security.auth_provider}</p>
            <p><span style={{ color: "var(--text-secondary)" }}>Password enabled:</span> {security.password_enabled ? "Yes" : "No"}</p>
            <p><span style={{ color: "var(--text-secondary)" }}>MFA enabled:</span> {security.mfa_enabled ? "Yes" : "No"}</p>
            <p><span style={{ color: "var(--text-secondary)" }}>Last password change:</span> {security.last_password_change_at ? new Date(security.last_password_change_at).toLocaleString() : "Never"}</p>

            {security.password_enabled ? (
              <div className="pt-2">
                <Link href="/forgot-password" className="underline" style={{ color: "var(--accent)" }}>
                  Request password reset
                </Link>
              </div>
            ) : (
              <p style={{ color: "var(--text-tertiary)" }}>
                Password reset is unavailable for this provider.
              </p>
            )}
          </div>
        ) : (
          <p style={{ color: "var(--error)" }}>Unable to load security settings.</p>
        )}
      </div>
    </div>
  );
}
