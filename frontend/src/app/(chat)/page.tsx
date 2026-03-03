"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import ChatInput from "@/components/chat/ChatInput";
import { useCapability } from "@/components/shared/CapabilityGate";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { uiToast } from "@/lib/toast";
import type { Model } from "@/types";

const prompts = ["Explain a concept", "Help me write", "Review my code"];

export default function EmptyStatePage() {
  const router = useRouter();
  const { user, token } = useAuth();
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState("gpt-4.1-mini");
  const { allowed: canSendMessage, reason: sendReason } = useCapability("chat.message.send");
  const { allowed: canAddContext, reason: addContextReason } = useCapability("chat.context.add");
  const { allowed: canUseVoice, reason: voiceReason } = useCapability("chat.voice.input");

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    const loadModels = async () => {
      try {
        const response = await api.models.list(token);
        if (!mounted) return;
        setModels(response);
        if (response[0]) setSelectedModel(response[0].id);
      } catch {
        if (!mounted) return;
        setModels([{ id: "gpt-4.1-mini", name: "Default" }]);
      }
    };

    void loadModels();
    return () => {
      mounted = false;
    };
  }, [token]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const startConversation = async (message: string) => {
    if (!token) return;
    if (!canSendMessage) {
      uiToast.error(sendReason || "tool_not_permitted");
      return;
    }
    try {
      const conversation = await api.conversations.create(token, {
        model: selectedModel,
      });
      window.dispatchEvent(new Event("conversations:changed"));
      router.push(`/${conversation.id}?q=${encodeURIComponent(message)}`);
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-[900px] text-center">
          <h1 className="mb-2 text-[28px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {greeting}, {user?.first_name || "there"}
          </h1>
          <p className="mb-8 text-base" style={{ color: "var(--text-secondary)" }}>
            How can I help you today?
          </p>

          <div className="grid gap-4 md:grid-cols-3">
            {prompts.map((prompt) => (
              <Card
                key={prompt}
                className="cursor-pointer border transition-colors hover:bg-hover"
                style={{ backgroundColor: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
                onClick={() => void startConversation(prompt)}
              >
                <CardHeader className="pb-3">
                  <CardTitle className="text-base" style={{ color: "var(--text-primary)" }}>
                    {prompt}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-left text-sm" style={{ color: "var(--text-secondary)" }}>
                  Start with this prompt.
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>

      <ChatInput
        models={models}
        selectedModel={selectedModel}
        onModelChange={async (model) => setSelectedModel(model)}
        onSend={startConversation}
        canAddContext={canAddContext}
        addContextReason={addContextReason}
        canUseVoice={canUseVoice}
        voiceReason={voiceReason}
      />
    </div>
  );
}
