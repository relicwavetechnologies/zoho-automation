"use client";

import { useEffect, useState } from "react";
import { PanelLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Conversation } from "@/types";

interface TopBarProps {
  conversation: Conversation | null;
  onToggleSidebar: () => void;
  onTitleChange: (title: string) => Promise<void>;
}

export default function TopBar({
  conversation,
  onToggleSidebar,
  onTitleChange,
}: TopBarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation?.title || "New chat");

  useEffect(() => {
    setDraftTitle(conversation?.title || "New chat");
    setIsEditing(false);
  }, [conversation?.id, conversation?.title]);

  return (
    <header
      className="sticky top-0 z-10 flex h-14 items-center border-b px-4"
      style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-base)" }}
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onToggleSidebar}
        style={{ color: "var(--text-secondary)" }}
      >
        <PanelLeft className="h-4 w-4" />
      </Button>

      <div className="flex-1 px-4 text-center">
        {isEditing ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={async () => {
              setIsEditing(false);
              const title = draftTitle.trim();
              if (title && title !== conversation?.title) {
                await onTitleChange(title);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            className="mx-auto w-full max-w-[380px] rounded-md border bg-elevated px-3 py-1 text-center text-[15px]"
            style={{
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          />
        ) : (
          <button
            type="button"
            className="text-[15px]"
            style={{ color: "var(--text-primary)" }}
            onDoubleClick={() => setIsEditing(true)}
          >
            {conversation?.title || "New Chat"}
          </button>
        )}
      </div>

      <div className="w-8" />
    </header>
  );
}
