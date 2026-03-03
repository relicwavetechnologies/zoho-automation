"use client";

import { FormEvent, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { uiToast } from "@/lib/toast";

export default function OnboardingPage() {
  const { token, user, refreshSession } = useAuth();
  const [organizationName, setOrganizationName] = useState("");
  const [firstName, setFirstName] = useState(user?.first_name || "");
  const [lastName, setLastName] = useState(user?.last_name || "");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(
    () => Boolean(organizationName.trim() && firstName.trim() && lastName.trim() && token),
    [organizationName, firstName, lastName, token]
  );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !canSubmit) return;

    setSubmitting(true);
    try {
      await api.onboarding.createOrganization(token, {
        organization_name: organizationName.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      });
      await refreshSession();
      uiToast.success("Organization setup complete");
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[520px] space-y-5 rounded-2xl border p-8"
        style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}
      >
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
            Set up your workspace
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Complete organization onboarding before entering the app.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="first-name">First name</Label>
            <Input
              id="first-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              className="border"
              style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-elevated)" }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="last-name">Last name</Label>
            <Input
              id="last-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              className="border"
              style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-elevated)" }}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="org-name">Company / Workspace name</Label>
          <Input
            id="org-name"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            placeholder="Acme Finance"
            className="border"
            style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-elevated)" }}
          />
        </div>

        <Button
          type="submit"
          disabled={!canSubmit || submitting}
          style={{ backgroundColor: "var(--accent)", color: "#fff" }}
        >
          {submitting ? "Creating workspace..." : "Complete setup"}
        </Button>
      </form>
    </div>
  );
}
