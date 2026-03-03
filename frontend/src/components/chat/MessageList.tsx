"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

import MessageBubble from "@/components/chat/MessageBubble";
import type { ChatMessage } from "@/components/chat/types";

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  status: string;
  userInitial?: string;
}

export default function MessageList({
  messages,
  isLoading,
  status,
  userInitial = "U",
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  const isStreaming = isLoading || status === "submitted" || status === "streaming";

  const isNearBottom = () => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  useEffect(() => {
    if (!autoScrollEnabled) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, autoScrollEnabled]);

  const onScroll = () => {
    setAutoScrollEnabled(isNearBottom());
  };

  const showJumpButton = !autoScrollEnabled && isStreaming;

  const streamingAssistantIndex = useMemo(() => {
    if (!isStreaming) return -1;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return index;
    }

    return -1;
  }, [messages, isStreaming]);

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 pb-[120px] pt-6">
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const showMeta = previous?.role !== message.role;
          const compactGap = previous?.role === message.role;

          return (
            <div key={`${message.id}-${index}`} style={{ marginTop: compactGap ? -12 : 0 }}>
              <MessageBubble
                message={message}
                showMeta={showMeta}
                isStreaming={index === streamingAssistantIndex}
                userInitial={userInitial}
              />
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {showJumpButton ? (
        <button
          type="button"
          className="absolute bottom-6 right-6 rounded-full border p-2"
          style={{
            borderColor: "var(--border-default)",
            backgroundColor: "var(--bg-surface)",
            color: "var(--text-primary)",
          }}
          onClick={() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            setAutoScrollEnabled(true);
          }}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
