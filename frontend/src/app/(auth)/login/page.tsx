"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { authGoogleStartUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);

  const startGoogleOAuth = () => {
    if (isLoading) return;
    setIsLoading(true);
    const oauthUrl = authGoogleStartUrl(nextPath);
    window.location.assign(oauthUrl);
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{ backgroundColor: "var(--bg-base)" }}
    >
      <div
        className="w-full max-w-[420px] rounded-2xl border p-10"
        style={{
          backgroundColor: "var(--bg-surface)",
          borderColor: "var(--border-subtle)",
        }}
      >
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-subtle text-sm font-bold text-accent">
            H
          </div>
          <p className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Halo
          </p>
        </div>

        <h1 className="mb-1 text-[22px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Continue with Google
        </h1>
        <p className="mb-6 text-sm" style={{ color: "var(--text-secondary)" }}>
          Sign in securely using your Google account.
        </p>

        <Button
          type="button"
          onClick={startGoogleOAuth}
          disabled={isLoading}
          className="w-full border"
          style={{
            backgroundColor: "var(--bg-elevated)",
            borderColor: "var(--border-default)",
            color: "var(--text-primary)",
          }}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <span className="flex items-center gap-2">
              <GoogleIcon />
              Continue with Google
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.8-5.5 3.8-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.8 3.1 14.6 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.7-4.1 9.7-9.8 0-.7-.1-1.2-.2-1.8H12z"
      />
    </svg>
  );
}
