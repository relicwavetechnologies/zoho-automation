"use client";

import { useMemo } from "react";

import { useAuth } from "@/context/AuthContext";

interface CapabilityGateProps {
  toolKey: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function useCapability(toolKey: string) {
  const { capabilities } = useAuth();

  return useMemo(() => {
    if (
      capabilities.tools.allowed.length === 0 &&
      capabilities.tools.blocked.length === 0 &&
      capabilities.tools.approval_required.length === 0
    ) {
      return { allowed: true, reasonCode: null as string | null, requiresApproval: false };
    }

    const requiresApproval = capabilities.tools.approval_required.includes(toolKey);
    const isAllowed = capabilities.tools.allowed.includes(toolKey);

    if (isAllowed) {
      return { allowed: true, reasonCode: null as string | null, requiresApproval };
    }

    const blocked = capabilities.tools.blocked.find((item) => item.tool_key === toolKey);

    return {
      allowed: false,
      reasonCode: blocked?.reason_code || "tool_not_permitted",
      requiresApproval,
    };
  }, [capabilities, toolKey]);
}

export default function CapabilityGate({ toolKey, fallback = null, children }: CapabilityGateProps) {
  const { allowed } = useCapability(toolKey);
  if (!allowed) return <>{fallback}</>;
  return <>{children}</>;
}
