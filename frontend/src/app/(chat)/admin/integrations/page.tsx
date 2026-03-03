"use client";

import { useEffect, useState } from "react";

import ApprovalConfirmDialog from "@/components/shared/ApprovalConfirmDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { api, type IntegrationStatusDto } from "@/lib/api";
import { uiToast } from "@/lib/toast";

export default function AdminIntegrationsPage() {
  const { token } = useAuth();
  const [status, setStatus] = useState<IntegrationStatusDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      setStatus(await api.admin.integrations.status(token));
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const run = async (task: () => Promise<void>, success: string) => {
    try {
      await task();
      uiToast.success(success);
      await load();
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[880px] p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Zoho Integration
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Manage global organization integration and health state.
      </p>

      <div className="mt-4 rounded-xl border p-5" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        {loading ? (
          <p style={{ color: "var(--text-secondary)" }}>Loading integration status...</p>
        ) : (
          <>
            <div className="grid gap-2 text-sm">
              <p><span style={{ color: "var(--text-secondary)" }}>Provider:</span> zoho</p>
              <p><span style={{ color: "var(--text-secondary)" }}>Status:</span> {status?.status || "unknown"}</p>
              <p><span style={{ color: "var(--text-secondary)" }}>Connected at:</span> {status?.connected_at ? new Date(status.connected_at).toLocaleString() : "-"}</p>
              <p><span style={{ color: "var(--text-secondary)" }}>Last health check:</span> {status?.last_health_check_at ? new Date(status.last_health_check_at).toLocaleString() : "-"}</p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => void run(() => api.admin.integrations.connect(token as string), "Zoho connected")} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
                Connect
              </Button>
              <Button variant="ghost" onClick={() => void run(() => api.admin.integrations.reconnect(token as string), "Zoho reconnected")}>
                Reconnect
              </Button>

              <ApprovalConfirmDialog
                title="Disconnect Zoho integration"
                description="This can stop tool execution until reconnected."
                onConfirm={async () => {
                  await run(() => api.admin.integrations.disconnect(token as string), "Zoho disconnected");
                }}
              >
                <Button variant="ghost">Disconnect</Button>
              </ApprovalConfirmDialog>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
