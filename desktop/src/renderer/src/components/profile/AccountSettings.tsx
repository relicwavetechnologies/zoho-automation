import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import { cn } from "../../lib/utils";
import { Check } from "lucide-react";
import { TokenUsageCard } from "./TokenUsageCard";

export function AccountSettings(): JSX.Element {
  const { session, token, logout } = useAuth();

  // Parse session securely with fallbacks
  const userStr = localStorage.getItem("user_session");
  const userContext = userStr ? JSON.parse(userStr) : null;

  const email = session?.email || userContext?.email || "user@example.com";
  const name = session?.name || userContext?.name || email.split("@")[0];
  const username =
    name.toLowerCase().replace(/[^a-z0-9]/g, "") +
    Math.floor(Math.random() * 1000);

  const [googleStatus, setGoogleStatus] = useState<{
    configured: boolean;
    connected: boolean;
    email?: string;
    scopes?: string[];
  } | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const loadGoogleStatus = useCallback(async () => {
    if (!token) return;
    setGoogleLoading(true);
    setGoogleError(null);
    try {
      const res = await window.desktopAPI.auth.getGoogleStatus(token);
      if (res?.success && res.data) {
        setGoogleStatus(
          res.data as {
            configured: boolean;
            connected: boolean;
            email?: string;
            scopes?: string[];
          },
        );
      } else {
        setGoogleStatus(null);
        setGoogleError("Unable to load Google connection status.");
      }
    } catch {
      setGoogleStatus(null);
      setGoogleError("Unable to load Google connection status.");
    } finally {
      setGoogleLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadGoogleStatus();
  }, [loadGoogleStatus]);

  const handleGoogleConnect = useCallback(async () => {
    if (!token) return;
    setGoogleConnecting(true);
    setGoogleError(null);
    try {
      await window.desktopAPI.auth.openGoogleConnect(token);
    } catch {
      setGoogleError(
        "Could not start Google OAuth. Check server configuration.",
      );
    } finally {
      setGoogleConnecting(false);
    }
  }, [token]);

  const handleGoogleDisconnect = useCallback(async () => {
    if (!token) return;
    setGoogleLoading(true);
    setGoogleError(null);
    try {
      await window.desktopAPI.auth.unlinkGoogle(token);
      await loadGoogleStatus();
    } catch {
      setGoogleError("Could not disconnect Google account.");
    } finally {
      setGoogleLoading(false);
    }
  }, [token, loadGoogleStatus]);

  return (
    <div className="flex flex-col gap-12 text-foreground/80">
      <section>
        <h2 className="text-[24px] font-bold text-foreground/90 mb-6 tracking-tight">
          Account
        </h2>

        <div className="flex flex-col gap-0 border-t border-b border-border/50 divide-y divide-border/50">
          {/* Avatar / Identity Row */}
          <div className="py-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-secondary/40 flex items-center justify-center text-muted-foreground/60 font-bold text-xl border border-border/50 shadow-sm">
                {name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="font-semibold text-[15px] text-foreground/90">
                  {name}
                </div>
                <div className="text-[12px] text-muted-foreground/50 font-medium">
                  @{username}
                </div>
              </div>
            </div>
            <button className="px-4 py-1.5 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm">
              Change avatar
            </button>
          </div>

          {/* Full Name */}
          <div className="py-5 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                Full Name
              </div>
              <div className="text-[14px] font-medium text-foreground/80">
                {name}
              </div>
            </div>
            <button className="px-4 py-1.5 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm">
              Edit
            </button>
          </div>

          {/* Username */}
          <div className="py-5 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                Username
              </div>
              <div className="text-[14px] font-medium text-foreground/80">
                @{username}
              </div>
            </div>
            <button className="px-4 py-1.5 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm">
              Edit
            </button>
          </div>

          {/* Email */}
          <div className="py-5 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                Email Address
              </div>
              <div className="text-[14px] font-medium text-foreground/80">
                {email}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-[20px] font-bold text-foreground/90 tracking-tight">
            Connected Services
          </h2>
        </div>
        <div className="border border-border bg-secondary/20 rounded-2xl p-6 flex flex-col gap-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-bold text-[15px] text-foreground/90">
                Google Workspace
              </div>
              <p className="text-[13px] text-muted-foreground/60 mt-1 leading-relaxed max-w-md">
                Connect your Drive and Gmail to let Divo research documents and
                coordinate communications.
              </p>
            </div>
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-lg border shadow-sm",
                googleStatus?.connected
                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500/80"
                  : "bg-secondary/50 border-border text-muted-foreground/50",
              )}
            >
              {googleStatus?.connected ? "Connected" : "Disconnected"}
            </span>
          </div>

          {googleStatus?.connected && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground/50 bg-black/20 px-3 py-2 rounded-xl border border-border/30 w-fit">
              <Check size={14} className="text-emerald-500/60" />
              Linked as{" "}
              <span className="font-bold text-foreground/70">
                {googleStatus.email}
              </span>
            </div>
          )}

          {googleError && (
            <div className="text-[12px] font-medium text-red-500/80 bg-red-500/5 border border-red-500/10 px-3 py-2 rounded-xl">
              {googleError}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2 border-t border-border/30">
            {!googleStatus?.connected ? (
              <button
                onClick={() => void handleGoogleConnect()}
                disabled={!googleStatus?.configured || googleConnecting}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-[12px] font-bold uppercase tracking-wider hover:opacity-90 transition-all disabled:opacity-50 shadow-sm"
              >
                {googleConnecting ? "Connecting..." : "Connect Google"}
              </button>
            ) : (
              <button
                onClick={() => void handleGoogleDisconnect()}
                disabled={googleLoading}
                className="px-4 py-2 rounded-lg border border-red-500/20 bg-red-500/5 text-[12px] font-bold uppercase tracking-wider text-red-500/70 hover:bg-red-500/10 transition-all disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
            <button
              onClick={() => void loadGoogleStatus()}
              disabled={googleLoading}
              className="px-4 py-2 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all disabled:opacity-50"
            >
              {googleLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-[20px] font-bold text-foreground/90 mb-6 tracking-tight">
          Subscription
        </h2>
        <div className="border border-border divide-y divide-border/50 rounded-2xl overflow-hidden bg-secondary/20 shadow-sm">
          <div className="p-6 flex items-center justify-between gap-6">
            <div>
              <div className="font-bold text-[15px] flex items-center gap-2 text-foreground/90">
                Divo Professional{" "}
                <span className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-lg font-black uppercase tracking-widest">
                  Active
                </span>
              </div>
              <p className="text-[13px] text-muted-foreground/60 mt-1.5 leading-relaxed max-w-md">
                You're on the Pro plan. Manage your billing or upgrade to
                Enterprise for team-wide controls.
              </p>
            </div>
            <button className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-bold text-[12px] uppercase tracking-wider hover:opacity-90 transition-all shadow-sm shrink-0">
              Manage Plan
            </button>
          </div>
          <div className="p-6 bg-black/10">
            <TokenUsageCard />
          </div>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-[20px] font-bold text-foreground/90 mb-6 tracking-tight">
          System
        </h2>
        <div className="flex flex-col gap-0 border-t border-b border-border/50 divide-y divide-border/50">
          <div className="py-5 flex items-center justify-between">
            <div className="text-[14px] font-medium text-foreground/80">
              Help & Support
            </div>
            <button className="px-4 py-1.5 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm">
              Contact
            </button>
          </div>

          <div className="py-5 flex items-center justify-between">
            <div className="text-[14px] text-muted-foreground/60">
              Signed in as{" "}
              <span className="font-bold text-foreground/70">@{username}</span>
            </div>
            <button
              onClick={() => void logout()}
              className="px-4 py-1.5 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
            >
              Sign out
            </button>
          </div>

          <div className="py-5 flex items-center justify-between">
            <div>
              <div className="font-bold text-[14px] text-foreground/90">
                Security
              </div>
              <p className="text-[13px] text-muted-foreground/50 mt-0.5 font-medium">
                Sign out of all other active sessions
              </p>
            </div>
            <button className="px-4 py-1.5 rounded-lg border border-border bg-secondary/50 text-[12px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm">
              Reset Sessions
            </button>
          </div>

          <div className="py-5 flex items-center justify-between">
            <div>
              <div className="font-bold text-[14px] text-red-500/80">
                Account Deletion
              </div>
              <p className="text-[13px] text-muted-foreground/50 mt-0.5 font-medium">
                Permanently remove your account and all workspace data
              </p>
            </div>
            <button className="px-4 py-1.5 rounded-lg border border-red-500/20 bg-red-500/5 text-[12px] font-bold uppercase tracking-wider text-red-500/70 hover:bg-red-500/10 transition-all shadow-sm">
              Delete Account
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
