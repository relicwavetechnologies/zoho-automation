"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

import { useAuth } from "@/context/AuthContext";
import { API_URL } from "@/lib/api";

interface AppendMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function useConversationChat(conversationId: string) {
  const { token } = useAuth();
  const [input, setInput] = useState("");
  const tokenRef = useRef<string | null>(token);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${API_URL}/conversations/${conversationId}/stream`,
        headers: () => ({
          Authorization: `Bearer ${tokenRef.current ?? ""}`,
        }),
      }),
    [conversationId]
  );

  const chat = useAiChat({
    transport,
    onFinish: () => {
      window.dispatchEvent(new Event("conversations:changed"));
    },
    onError: (error) => {
      console.error("Chat error:", error);
    },
  });

  const handleInputChange = (
    event: ChangeEvent<HTMLInputElement> | ChangeEvent<HTMLTextAreaElement>
  ) => {
    setInput(event.target.value);
  };

  const handleSubmit = async () => {
    const message = input.trim();
    if (!message) return;
    if (!tokenRef.current) {
      throw new Error("Not authenticated");
    }
    setInput("");
    await chat.sendMessage({ text: message });
  };

  const append = async (message: AppendMessage) => {
    if (message.role !== "user") return;
    if (!tokenRef.current) {
      throw new Error("Not authenticated");
    }
    await chat.sendMessage({ text: message.content });
  };

  return {
    ...chat,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    append,
    isLoading: chat.status === "submitted" || chat.status === "streaming",
  };
}
