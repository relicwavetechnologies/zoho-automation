"use client";

import { Bot } from "lucide-react";

import MarkdownRenderer from "@/components/shared/MarkdownRenderer";
import { ToolExecutionCard } from "@/components/chat/ToolExecutionCard";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import type { ChatMessage } from "@/components/chat/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  showMeta?: boolean;
  userInitial?: string;
}

export default function MessageBubble({
  message,
  isStreaming = false,
  showMeta = true,
  userInitial = "U",
}: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="group flex justify-end gap-2">
        <div className="max-w-[80%]">
          <div
            className="whitespace-pre-wrap break-words rounded-[18px_18px_4px_18px] border px-4 py-3 text-[15px] leading-relaxed"
            style={{
              backgroundColor: "var(--bg-elevated)",
              borderColor: "var(--border-subtle)",
              color: "var(--text-primary)",
            }}
          >
            {message.content || ""}
          </div>
          <p
            className="mt-1 text-right text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
            style={{ color: "var(--text-tertiary)" }}
          >
            {formatTime(message.createdAt)}
          </p>
        </div>

        {showMeta ? (
          <Avatar className="mt-1 h-7 w-7">
            <AvatarFallback className="text-xs" style={{ backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)" }}>
              {userInitial}
            </AvatarFallback>
          </Avatar>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-3">
      {showMeta ? (
        <Avatar className="mt-0.5 h-7 w-7">
          <AvatarFallback style={{ backgroundColor: "var(--accent-subtle)", color: "var(--accent)" }}>
            <Bot className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      ) : (
        <div className="w-7" />
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        {message.toolInvocations?.map((tool) => (
          <div key={tool.toolCallId} className="mb-2">
            <ToolExecutionCard
              toolName={tool.toolName}
              args={tool.args}
              result={tool.result}
              state={tool.state || "call"}
            />
          </div>
        ))}

        {isStreaming && !message.content ? <ThinkingIndicator /> : null}

        {message.content ? <MarkdownRenderer content={message.content} /> : null}
        {isStreaming && message.content ? <span className="typing-cursor ml-0.5 inline-block">|</span> : null}
      </div>
    </div>
  );
}

function formatTime(value?: string | Date): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
