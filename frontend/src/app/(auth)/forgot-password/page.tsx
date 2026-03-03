"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;

    setSubmitting(true);
    try {
      await api.account.password.resetRequest(email.trim());
    } finally {
      setSubmitting(false);
      setDone(true);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ backgroundColor: "var(--bg-base)" }}>
      <div className="w-full max-w-[420px] rounded-2xl border p-8" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Reset your password
        </h1>

        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          {done
            ? "If an account exists, a reset link has been sent."
            : "Enter your email to receive a reset link."}
        </p>

        {!done ? (
          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
              {submitting ? "Submitting..." : "Send reset link"}
            </Button>
          </form>
        ) : (
          <Link href="/login" className="mt-4 inline-block underline" style={{ color: "var(--accent)" }}>
            Back to login
          </Link>
        )}
      </div>
    </div>
  );
}
