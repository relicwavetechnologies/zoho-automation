"use client";

import { FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { uiToast } from "@/lib/toast";
import type { ProfileDto } from "@/types";

export default function ProfileSettingsPage() {
  const { token, refreshSession } = useAuth();
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;

    const load = async () => {
      setLoading(true);
      try {
        const data = await api.me.profile.get(token);
        setProfile(data);
        setFirstName(data.user.first_name || "");
        setLastName(data.user.last_name || "");
        setAvatarUrl(data.user.avatar_url || "");
      } catch (error) {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [token]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;

    if (!firstName.trim() || !lastName.trim()) {
      uiToast.error("First and last name are required");
      return;
    }

    setSaving(true);
    try {
      const updated = await api.me.profile.update(token, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        avatar_url: avatarUrl.trim() || null,
      });
      setProfile(updated);
      await refreshSession();
      uiToast.success("Profile updated");
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Profile
      </h1>

      <div className="rounded-xl border p-5" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        {loading ? (
          <p style={{ color: "var(--text-secondary)" }}>Loading profile...</p>
        ) : profile ? (
          <>
            <div className="mb-4 grid gap-1 text-sm">
              <p><span style={{ color: "var(--text-secondary)" }}>Email:</span> {profile.user.email}</p>
              <p><span style={{ color: "var(--text-secondary)" }}>Workspace:</span> {profile.workspace.name}</p>
              <p><span style={{ color: "var(--text-secondary)" }}>Role:</span> {profile.membership.role_name}</p>
            </div>

            <form onSubmit={onSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>First name</Label>
                  <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={100} />
                </div>
                <div className="space-y-2">
                  <Label>Last name</Label>
                  <Input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={100} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Avatar URL</Label>
                <Input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://..." />
              </div>

              <Button type="submit" disabled={saving} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
                {saving ? "Saving..." : "Save profile"}
              </Button>
            </form>
          </>
        ) : (
          <p style={{ color: "var(--error)" }}>Unable to load profile.</p>
        )}
      </div>
    </div>
  );
}
