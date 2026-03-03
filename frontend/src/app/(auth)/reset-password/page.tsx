"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { denyMessage } from "@/lib/deny";

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const token = useMemo(() => searchParams.get("token") || "", [searchParams]);

  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || newPassword.length < 8) {
      setStatus("error");
      setMessage("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);
    try {
      await api.account.password.resetConfirm(token, newPassword);
      setStatus("success");
      setMessage("Password reset successful. You can now sign in.");
    } catch (error) {
      setStatus("error");
      if (error instanceof ApiError) {
        setMessage(denyMessage(error.reasonCode || "validation_error"));
      } else {
        setMessage(error instanceof Error ? error.message : "Unable to reset password");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ backgroundColor: "var(--bg-base)" }}>
      <div className="w-full max-w-[420px] rounded-2xl border p-8" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Set a new password
        </h1>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="space-y-2">
            <Label>New password</Label>
            <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </div>

          <Button type="submit" disabled={submitting} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
            {submitting ? "Resetting..." : "Reset password"}
          </Button>
        </form>

        {status !== "idle" ? (
          <p className="mt-3 text-sm" style={{ color: status === "success" ? "var(--success)" : "var(--error)" }}>
            {message}
          </p>
        ) : null}

        <Link href="/login" className="mt-4 inline-block underline" style={{ color: "var(--accent)" }}>
          Back to login
        </Link>
      </div>
    </div>
  );
}
