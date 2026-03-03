"use client";

import { useMemo, useState } from "react";
import { CheckCircle, ChevronDown, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

type ToolInvocationState = "call" | "partial-call" | "result";

interface ToolExecutionCardProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  state: ToolInvocationState;
}

export function ToolExecutionCard({
  toolName,
  args,
  result,
  state,
}: ToolExecutionCardProps) {
  const [isExpanded, setIsExpanded] = useState(state !== "result");
  const isComplete = state === "result";

  const displayName = useMemo(
    () =>
      toolName
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    [toolName]
  );

  return (
    <div
      className={cn(
        "rounded-lg border text-sm transition-all duration-200",
        isComplete ? "bg-surface" : "bg-accent-subtle"
      )}
      style={{
        borderColor: isComplete ? "var(--border-subtle)" : "rgba(217, 119, 87, 0.5)",
      }}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2"
      >
        {isComplete ? (
          <CheckCircle className="h-4 w-4 shrink-0" style={{ color: "var(--success)" }} />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
        )}

        <span className="font-medium" style={{ color: "var(--text-primary)" }}>
          {isComplete ? "Used" : "Using"}: {displayName}
        </span>

        <ChevronDown
          className={cn("ml-auto h-4 w-4 transition-transform", isExpanded && "rotate-180")}
          style={{ color: "var(--text-tertiary)" }}
        />
      </button>

      {isExpanded ? (
        <div
          className="mt-1 space-y-1 border-t px-3 pb-2 pt-2 text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          {args !== undefined ? (
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Input: </span>
              <code style={{ color: "var(--text-primary)" }}>{truncate(safeStringify(args), 220)}</code>
            </div>
          ) : null}
          {result !== undefined ? (
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Output: </span>
              <code style={{ color: "var(--text-primary)" }}>{truncate(safeStringify(result), 220)}</code>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}
