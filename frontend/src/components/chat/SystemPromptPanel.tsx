"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface SystemPromptPanelProps {
  value: string | null;
  onSave: (prompt: string | null) => Promise<void>;
}

export default function SystemPromptPanel({ value, onSave }: SystemPromptPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(value || "");
  }, [value]);

  return (
    <div
      className="border-b"
      style={{ backgroundColor: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <div className="mx-auto w-full max-w-[920px] px-6 py-2">
        <button
          type="button"
          className="rounded-full border px-3 py-1 text-xs"
          style={{
            borderColor: "var(--border-default)",
            color: "var(--text-secondary)",
            backgroundColor: "var(--bg-elevated)",
          }}
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {`System prompt · ${value ? "Custom" : "Default"}`}
        </button>
      </div>

      <div className="overflow-hidden transition-[max-height] duration-200" style={{ maxHeight: isExpanded ? "280px" : "0px" }}>
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3 px-6 pb-4">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[120px] border text-sm"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--bg-elevated)",
              color: "var(--text-primary)",
            }}
          />

          <div className="flex items-center gap-3">
            <Button
              type="button"
              disabled={isSaving}
              onClick={async () => {
                setIsSaving(true);
                try {
                  await onSave(draft.trim() || null);
                } finally {
                  setIsSaving(false);
                }
              }}
              className="h-9"
              style={{ backgroundColor: "var(--accent)", color: "#fff" }}
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
            <button
              type="button"
              className="text-sm"
              style={{ color: "var(--text-secondary)" }}
              onClick={async () => {
                setDraft("");
                await onSave(null);
              }}
            >
              Reset to default
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
