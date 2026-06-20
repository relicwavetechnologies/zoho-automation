import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, ShieldCheck, ShieldAlert, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api, type PolicyAuditEvent, type PolicyBinding, type PolicyMeResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

function decisionTone(value?: string): string {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "allow") return "text-emerald-300";
  if (normalized === "deny") return "text-red-300";
  if (normalized === "needs_approval") return "text-amber-300";
  return "text-text-secondary";
}

function formatEvent(event: PolicyAuditEvent): string {
  const action = String(event.action || "");
  const resource = String(event.resource || "");
  if (action || resource) return `${action} ${resource}`.trim();
  return String(event.event || "policy event");
}

const ROLE_MATRIX = [
  { role: "MEMBER", admin: false, tools: "Non-sensitive tools only", policy: false },
  { role: "COMPANY_ADMIN", admin: true, tools: "Sensitive tools and admin routes", policy: false },
  { role: "SUPER_ADMIN", admin: true, tools: "All tools, routes, and policy audit", policy: true },
];

const SENSITIVE_TOOLSETS = ["zoho", "google", "lark", "mcp", "skills", "system", "credentials"];

const DEFAULT_BINDING_FORM = {
  principal_type: "role",
  principal_id: "COMPANY_ADMIN",
  resource_type: "Tool",
  resource_id: "zoho_books",
  action: "read",
  effect: "permit",
};

export default function PolicyPage() {
  const [policy, setPolicy] = useState<PolicyMeResponse | null>(null);
  const [audit, setAudit] = useState<PolicyAuditEvent[]>([]);
  const [bindings, setBindings] = useState<PolicyBinding[]>([]);
  const [bindingForm, setBindingForm] = useState(DEFAULT_BINDING_FORM);
  const [loading, setLoading] = useState(true);
  const [savingBinding, setSavingBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getPolicyMe(),
      api.getPolicyAudit(80).catch(() => ({ events: [] })),
      api.getPolicyBindings().catch(() => ({ company_id: "", bindings: [] })),
    ])
      .then(([policyBody, auditBody, bindingBody]) => {
        setPolicy(policyBody);
        setAudit(auditBody.events ?? []);
        setBindings(bindingBody.bindings ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const allowedRoutes = useMemo(
    () => policy?.routes.filter((route) => route.allowed).length ?? 0,
    [policy],
  );
  const deniedRoutes = (policy?.routes.length ?? 0) - allowedRoutes;

  const updateBindingForm = (key: keyof typeof DEFAULT_BINDING_FORM, value: string) => {
    setBindingForm((current) => ({ ...current, [key]: value }));
  };

  const createBinding = () => {
    setSavingBinding(true);
    setError(null);
    api.createPolicyBinding(bindingForm)
      .then(() => {
        setBindingForm(DEFAULT_BINDING_FORM);
        load();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingBinding(false));
  };

  const deleteBinding = (id: string) => {
    setSavingBinding(true);
    setError(null);
    api.deletePolicyBinding(id)
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingBinding(false));
  };

  if (loading && !policy) {
    return (
      <div className="flex min-h-[280px] items-center justify-center text-text-secondary">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 pb-8">
      <header className="flex flex-col gap-3 rounded-lg border border-current/15 bg-midground/5 p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-midground/10 text-midground">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-secondary">Enterprise policy</p>
            <h1 className="text-2xl font-semibold tracking-tight text-midground">
              RBAC / ABAC controls
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Local Cedar-shaped decisions for admin routes, tools, connectors, and audit visibility.
            </p>
          </div>
        </div>
        <Button onClick={load} ghost className="shrink-0 gap-2">
          <RotateCw className="h-4 w-4" />
          Refresh
        </Button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Mode" value={policy?.mode ?? "unknown"} tone="accent" />
        <MetricCard label="Actor role" value={policy?.actor.role ?? "unknown"} />
        <MetricCard label="Allowed routes" value={String(allowedRoutes)} />
        <MetricCard label="Denied routes" value={String(Math.max(0, deniedRoutes))} tone="warning" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <Panel title="Route permissions" subtitle="Backend capability decisions for the admin app.">
          <div className="overflow-hidden rounded-lg border border-current/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-midground/10 text-xs text-text-secondary">
                <tr>
                  <th className="px-3 py-2 font-medium">Surface</th>
                  <th className="px-3 py-2 font-medium">Capability</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {(policy?.routes ?? []).map((route) => (
                  <tr key={route.key} className="border-t border-current/10">
                    <td className="px-3 py-2 text-midground">{route.label}</td>
                    <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                      {route.capability}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">{route.action}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-md px-2 py-1 text-xs font-medium",
                          route.allowed
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-red-500/15 text-red-300",
                        )}
                      >
                        {route.allowed ? "allowed" : "denied"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Current actor" subtitle="Bootstrap super-admin status and company identity.">
          <dl className="grid gap-2 text-sm">
            <Info label="Name" value={policy?.actor.display_name || "Local dashboard"} />
            <Info label="Email" value={policy?.actor.email || "-"} />
            <Info label="Company user" value={policy?.actor.company_user_id || "-"} mono />
            <Info label="Company" value={policy?.actor.company_id || "-"} mono />
            <Info label="Department" value={policy?.actor.department_id || "-"} />
            <Info label="Status" value={policy?.actor.status || "-"} />
          </dl>
          {policy?.actor.is_super_admin ? (
            <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              This actor has SUPER_ADMIN policy access.
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              This actor is not a super admin. Restricted surfaces are hidden and backend guarded.
            </div>
          )}
        </Panel>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Panel title="Role matrix" subtitle="Default role ceilings used by the local policy layer.">
          <div className="overflow-hidden rounded-lg border border-current/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-midground/10 text-xs text-text-secondary">
                <tr>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Admin routes</th>
                  <th className="px-3 py-2 font-medium">Tools</th>
                  <th className="px-3 py-2 font-medium">Policy</th>
                </tr>
              </thead>
              <tbody>
                {ROLE_MATRIX.map((row) => (
                  <tr key={row.role} className="border-t border-current/10">
                    <td className="px-3 py-2 font-mono text-xs text-midground">{row.role}</td>
                    <td className="px-3 py-2 text-text-secondary">{row.admin ? "Allowed" : "Denied"}</td>
                    <td className="px-3 py-2 text-text-secondary">{row.tools}</td>
                    <td className="px-3 py-2 text-text-secondary">{row.policy ? "Manage" : "View denied"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Sensitive tool defaults" subtitle="Toolsets requiring an admin role before model exposure or dispatch.">
          <div className="flex flex-wrap gap-2">
            {SENSITIVE_TOOLSETS.map((toolset) => (
              <span
                key={toolset}
                className="rounded-md border border-current/10 bg-midground/10 px-2.5 py-1.5 font-mono text-xs text-midground"
              >
                {toolset}
              </span>
            ))}
          </div>
          <p className="mt-3 text-sm text-text-secondary">
            Non-sensitive tools remain available to complete company identities. Sensitive toolsets require COMPANY_ADMIN or SUPER_ADMIN.
          </p>
        </Panel>
      </section>

      <Panel title="Policy bindings" subtitle="Company-local overrides evaluated before default role rules.">
        <div className="grid gap-3 rounded-lg border border-current/10 bg-midground/5 p-3 xl:grid-cols-[160px_minmax(150px,1fr)_160px_minmax(150px,1fr)_120px_120px_auto]">
          <Field label="Principal">
            <select
              value={bindingForm.principal_type}
              onChange={(event) => updateBindingForm("principal_type", event.target.value)}
              className="h-9 w-full rounded-md border border-current/15 bg-background-base px-2 text-sm text-midground"
            >
              <option value="role">Role</option>
              <option value="department">Department</option>
              <option value="company_user">User</option>
              <option value="any">Any</option>
            </select>
          </Field>
          <Field label="Principal ID">
            <input
              value={bindingForm.principal_id}
              onChange={(event) => updateBindingForm("principal_id", event.target.value)}
              className="h-9 w-full rounded-md border border-current/15 bg-background-base px-2 text-sm text-midground"
            />
          </Field>
          <Field label="Resource">
            <select
              value={bindingForm.resource_type}
              onChange={(event) => updateBindingForm("resource_type", event.target.value)}
              className="h-9 w-full rounded-md border border-current/15 bg-background-base px-2 text-sm text-midground"
            >
              <option value="Tool">Tool</option>
              <option value="AdminRoute">Admin route</option>
              <option value="Connector">Connector</option>
              <option value="DataScope">Data scope</option>
            </select>
          </Field>
          <Field label="Resource ID">
            <input
              value={bindingForm.resource_id}
              onChange={(event) => updateBindingForm("resource_id", event.target.value)}
              className="h-9 w-full rounded-md border border-current/15 bg-background-base px-2 text-sm text-midground"
            />
          </Field>
          <Field label="Action">
            <select
              value={bindingForm.action}
              onChange={(event) => updateBindingForm("action", event.target.value)}
              className="h-9 w-full rounded-md border border-current/15 bg-background-base px-2 text-sm text-midground"
            >
              <option value="read">Read</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="delete">Delete</option>
              <option value="send">Send</option>
              <option value="execute">Execute</option>
              <option value="manage">Manage</option>
              <option value="*">Any</option>
            </select>
          </Field>
          <Field label="Effect">
            <select
              value={bindingForm.effect}
              onChange={(event) => updateBindingForm("effect", event.target.value)}
              className="h-9 w-full rounded-md border border-current/15 bg-background-base px-2 text-sm text-midground"
            >
              <option value="permit">Permit</option>
              <option value="forbid">Forbid</option>
              <option value="approval">Approval</option>
            </select>
          </Field>
          <div className="flex items-end">
            <Button
              onClick={createBinding}
              disabled={savingBinding}
              className="h-9 w-full justify-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </div>

        <div className="mt-3 overflow-hidden rounded-lg border border-current/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-midground/10 text-xs text-text-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Principal</th>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Effect</th>
                <th className="w-12 px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {bindings.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-text-secondary">
                    No policy bindings yet.
                  </td>
                </tr>
              ) : (
                bindings.map((binding) => (
                  <tr key={binding.id} className="border-t border-current/10">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs text-midground">{binding.principal_id}</div>
                      <div className="text-xs text-text-secondary">{binding.principal_type}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs text-midground">{binding.resource_id}</div>
                      <div className="text-xs text-text-secondary">{binding.resource_type}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-text-secondary">{binding.action}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-md px-2 py-1 text-xs font-medium",
                          binding.effect === "forbid"
                            ? "bg-red-500/15 text-red-300"
                            : binding.effect === "approval"
                              ? "bg-amber-500/15 text-amber-300"
                              : "bg-emerald-500/15 text-emerald-300",
                        )}
                      >
                        {binding.effect}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        onClick={() => deleteBinding(binding.id)}
                        disabled={savingBinding}
                        ghost
                        className="h-8 w-8 justify-center p-0"
                        title="Delete policy binding"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recent policy audit" subtitle="Local JSONL audit events from authorization checks.">
        {audit.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-current/10 bg-midground/5 p-3 text-sm text-text-secondary">
            <ShieldAlert className="h-4 w-4" />
            No policy audit events recorded yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-current/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-midground/10 text-xs text-text-secondary">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Decision</th>
                  <th className="px-3 py-2 font-medium">Request</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {audit.slice().reverse().map((event, idx) => (
                  <tr key={`${event.timestamp ?? "event"}-${idx}`} className="border-t border-current/10">
                    <td className="px-3 py-2 text-xs text-text-secondary">
                      {String(event.timestamp || "-")}
                    </td>
                    <td className={cn("px-3 py-2 text-xs font-semibold", decisionTone(String(event.decision || "")))}>
                      {String(event.decision || event.event || "-")}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                      {formatEvent(event)}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {String(event.reason || event.code || "-")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: "accent" | "warning" }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-current/10 p-3 shadow-sm",
        tone === "accent"
          ? "bg-midground text-background-base"
          : tone === "warning"
            ? "bg-amber-500/10 text-amber-200"
            : "bg-midground/5 text-midground",
      )}
    >
      <p className={cn("text-xs font-medium", tone === "accent" ? "text-background-base/70" : "text-text-secondary")}>
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-current/10 bg-midground/5 p-4 shadow-sm">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-midground">{title}</h2>
        <p className="text-sm text-text-secondary">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 rounded-md bg-midground/5 px-3 py-2">
      <dt className="text-text-secondary">{label}</dt>
      <dd className={cn("truncate text-midground", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}
