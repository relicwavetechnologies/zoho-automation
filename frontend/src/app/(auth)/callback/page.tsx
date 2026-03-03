"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/context/AuthContext";

export default function OAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { completeOAuthLogin } = useAuth();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const token = searchParams.get("token");
  const backendError = searchParams.get("error");
  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);

  useEffect(() => {
    if (backendError) {
      setErrorMessage(backendError);
      return;
    }

    if (!token) {
      setErrorMessage("Missing OAuth token");
      return;
    }

    completeOAuthLogin(token)
      .then(() => {
        router.replace(nextPath);
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "Unable to connect");
      });
  }, [backendError, token, completeOAuthLogin, router, nextPath]);

  if (errorMessage) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4" style={{ backgroundColor: "var(--bg-base)" }}>
        <div
          className="w-full max-w-[420px] rounded-xl border p-6"
          style={{
            backgroundColor: "var(--bg-surface)",
            borderColor: "var(--border-subtle)",
          }}
        >
          <h1 className="mb-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Sign-in failed
          </h1>
          <p style={{ color: "var(--error)" }}>{errorMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: "var(--bg-base)", color: "var(--text-secondary)" }}>
      Completing sign-in...
    </div>
  );
}
