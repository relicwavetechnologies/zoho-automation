"use client";

import { useCallback, useEffect, useState } from "react";

import { createMessage, listMessages } from "@/lib/api";
import type { Message } from "@/types";

export function useMessages(token: string | null, conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!token || !conversationId) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await listMessages(token, conversationId);
      setMessages(response);
    } catch {
      setMessages([]);
    } finally {
      setIsLoading(false);
    }
  }, [token, conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (content: string) => {
      if (!token || !conversationId) throw new Error("Missing context");
      const saved = await createMessage(token, conversationId, content);
      setMessages((prev) => [...prev, saved]);
      return saved;
    },
    [token, conversationId]
  );

  return { messages, isLoading, setMessages, send, refresh };
}
