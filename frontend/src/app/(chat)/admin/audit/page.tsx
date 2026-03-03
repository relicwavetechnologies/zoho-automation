"use client";

import { FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/AuthContext";
import { api, type AuditRecord } from "@/lib/api";
import { uiToast } from "@/lib/toast";

export default function AdminAuditPage() {
  const { token } = useAuth();
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      setRecords(
        await api.admin.audit.list(token, {
          action: action || undefined,
          actor_email: actor || undefined,
          from: from || undefined,
          to: to || undefined,
        })
      );
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const onFilter = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Audit timeline
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Filter security and admin events.
      </p>

      <form onSubmit={onFilter} className="mt-4 grid grid-cols-1 gap-2 rounded-xl border p-4 md:grid-cols-5" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <Input value={action} onChange={(event) => setAction(event.target.value)} placeholder="action" />
        <Input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="actor email" />
        <Input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
        <Input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
        <Button type="submit" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
          Apply filters
        </Button>
      </form>

      <div className="mt-4 space-y-2">
        {loading ? (
          <p>Loading audit events...</p>
        ) : records.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No audit events found.</p>
        ) : (
          records.map((record) => (
            <div key={record.id} className="rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
              <p className="text-sm" style={{ color: "var(--text-primary)" }}>
                {record.action} on {record.entity_type}
              </p>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {record.actor_email} · {new Date(record.created_at).toLocaleString()} · {record.entity_id}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
