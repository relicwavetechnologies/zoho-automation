import { Sparkles } from "lucide-react";

export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-2" style={{ color: "var(--text-secondary)" }}>
      <Sparkles className="h-4 w-4 animate-pulse" style={{ color: "var(--accent)" }} />
      <span className="shimmer-text text-sm">Generating...</span>
    </div>
  );
}
