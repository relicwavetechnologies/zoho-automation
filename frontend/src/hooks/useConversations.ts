"use client";

import { useCallback, useEffect, useState } from "react";

import {
  createConversation,
  deleteConversation,
  listConversations,
  patchConversationSettings,
} from "@/lib/api";
import type { Conversation } from "@/types";

export function useConversations(token: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!token) {
      setConversations([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await listConversations(token);
      setConversations(response);
    } catch {
      setConversations([]);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createNewConversation = useCallback(
    async (payload?: { title?: string; model?: string; system_prompt?: string }) => {
      if (!token) throw new Error("Missing token");
      const created = await createConversation(token, {
        title: payload?.title,
        model: payload?.model || "gpt-4.1-mini",
        system_prompt: payload?.system_prompt,
      });
      setConversations((prev) => [created, ...prev]);
      return created;
    },
    [token]
  );

  const updateSettings = useCallback(
    async (
      conversationId: string,
      payload: { model?: string; system_prompt?: string; temperature?: number; title?: string }
    ) => {
      if (!token) throw new Error("Missing token");
      const updated = await patchConversationSettings(token, conversationId, payload);
      setConversations((prev) => prev.map((item) => (item.id === conversationId ? updated : item)));
      return updated;
    },
    [token]
  );

  const renameLocal = useCallback((conversationId: string, title: string) => {
    setConversations((prev) =>
      prev.map((item) => (item.id === conversationId ? { ...item, title } : item))
    );
  }, []);

  const removeLocal = useCallback((conversationId: string) => {
    setConversations((prev) => prev.filter((item) => item.id !== conversationId));
  }, []);

  const deleteRemote = useCallback(
    async (conversationId: string) => {
      if (!token) throw new Error("Missing token");
      await deleteConversation(token, conversationId);
      setConversations((prev) => prev.filter((item) => item.id !== conversationId));
    },
    [token]
  );

  return {
    conversations,
    isLoading,
    refresh,
    createNewConversation,
    updateSettings,
    renameLocal,
    removeLocal,
    deleteRemote,
  };
}
