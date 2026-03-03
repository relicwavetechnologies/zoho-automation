"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { api, authGoogleStartUrl } from "@/lib/api";
import { uiToast } from "@/lib/toast";

type InviteState = "checking" | "needs_login" | "ready" | "done" | "error";

export default function InviteAcceptPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { token, refreshSession } = useAuth();

  const inviteToken = useMemo(() => searchParams.get("token") || "", [searchParams]);
  const [state, setState] = useState<InviteState>("checking");
  const [statusMessage, setStatusMessage] = useState("Validating invite...");

  useEffect(() => {
    if (!inviteToken) {
      setState("error");
      setStatusMessage("Invalid invite link");
      return;
    }

    api.invites
      .validate(inviteToken)
      .then((result) => {
        if (result.status !== "pending") {
          setState("error");
          setStatusMessage(`Invite is ${result.status}`);
          return;
        }

        if (!token) {
          setState("needs_login");
          setStatusMessage("Continue with Google to accept this invite.");
          return;
        }

        setState("ready");
        setStatusMessage("Invite is valid.");
      })
      .catch((error) => {
        setState("error");
        setStatusMessage(error instanceof Error ? error.message : "Unable to validate invite");
      });
  }, [inviteToken, token]);

  const continueWithGoogle = () => {
    const next = `/invite/accept?token=${encodeURIComponent(inviteToken)}`;
    window.location.assign(authGoogleStartUrl(next));
  };

  const acceptInvite = async () => {
    if (!token) return;

    try {
      await api.invites.accept(token, inviteToken);
      await refreshSession();
      setState("done");
      setStatusMessage("Invite accepted. Redirecting...");
      uiToast.success("Invite accepted");
      setTimeout(() => router.replace("/"), 700);
    } catch (error) {
      setState("error");
      setStatusMessage(error instanceof Error ? error.message : "Unable to accept invite");
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{ backgroundColor: "var(--bg-base)" }}
    >
      <div
        className="w-full max-w-[460px] rounded-2xl border p-8"
        style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}
      >
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Invite acceptance
        </h1>
        <p className="mt-2 text-sm" style={{ color: state === "error" ? "var(--error)" : "var(--text-secondary)" }}>
          {statusMessage}
        </p>

        <div className="mt-5 flex gap-2">
          {state === "needs_login" ? (
            <Button onClick={continueWithGoogle} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
              Continue with Google
            </Button>
          ) : null}

          {state === "ready" ? (
            <Button onClick={() => void acceptInvite()} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
              Accept invite
            </Button>
          ) : null}

          {(state === "error" || state === "done") ? (
            <Button variant="ghost" onClick={() => router.replace("/")}>Go to app</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
