"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { UIMessage } from "ai";

import ChatInput from "@/components/chat/ChatInput";
import MessageList from "@/components/chat/MessageList";
import { useCapability } from "@/components/shared/CapabilityGate";
import type {
  ChatMessage as UiChatMessage,
  ToolInvocation as UiToolInvocation,
} from "@/components/chat/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/context/AuthContext";
import { useConversationChat } from "@/hooks/useConversationChat";
import { api } from "@/lib/api";
import { denyMessage } from "@/lib/deny";
import { uiToast } from "@/lib/toast";
import type { Model } from "@/types";

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { token, user, isLoading: isAuthLoading, refreshCapabilities } = useAuth();
  const initialPromptHandledRef = useRef(false);

  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gpt-4.1-mini");
  const [isLoading, setIsLoading] = useState(true);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const {
    allowed: canSendMessage,
    reasonCode: sendReasonCode,
    requiresApproval: sendRequiresApproval,
  } = useCapability("chat.message.send");
  const { allowed: canAddContext, reasonCode: addContextReason } = useCapability("chat.context.add");
  const { allowed: canUseVoice, reasonCode: voiceReason } = useCapability("chat.voice.input");

  const {
    messages,
    setMessages,
    input,
    handleInputChange,
    handleSubmit,
    append,
    isLoading: isChatLoading,
    status,
    stop,
  } = useConversationChat(id);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!token) {
      router.replace("/login");
    }
  }, [token, isAuthLoading, router]);

  useEffect(() => {
    if (!token || !id) return;
    let mounted = true;

    const load = async () => {
      setIsLoading(true);
      try {
        const [conversationData, messagesData, modelData] = await Promise.all([
          api.conversations.get(token, id),
          api.messages.list(token, id),
          api.models.list(token).catch(() => [{ id: "gpt-4.1-mini", name: "Default" }]),
        ]);

        if (!mounted) return;
        setSelectedModel(conversationData.model || "gpt-4.1-mini");
        setModels(modelData);

        setMessages(
          messagesData.map((message) => ({
            id: message.id,
            role: message.role,
            parts: [{ type: "text", text: message.content }],
          })) as UIMessage[]
        );
      } catch (error) {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
      stop();
    };
  }, [token, id, setMessages, stop]);

  const submitFromInput = async () => {
    if (!input.trim()) return;
    if (!canSendMessage) {
      uiToast.error(denyMessage(sendReasonCode));
      return;
    }

    if (sendRequiresApproval) {
      setAwaitingApproval(true);
      return;
    }

    await handleSubmit();
  };

  useEffect(() => {
    const initialPrompt = searchParams.get("q");
    if (!initialPrompt) return;
    if (!token || !id || isLoading || isChatLoading) return;
    if (initialPromptHandledRef.current) return;

    initialPromptHandledRef.current = true;

    append({ role: "user", content: initialPrompt }).catch((error: unknown) => {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    });

    router.replace(`/${id}`);
  }, [searchParams, token, id, isLoading, isChatLoading, router, append]);

  const loadingSkeleton = useMemo(
    () => (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[660px] flex-col justify-end gap-4 px-6 pb-[120px] pt-6">
          <Skeleton className="h-20 w-[70%] rounded-xl" />
          <Skeleton className="ml-auto h-16 w-[55%] rounded-xl" />
          <Skeleton className="h-24 w-[80%] rounded-xl" />
        </div>
      </div>
    ),
    []
  );

  const uiMessages = toUiMessages(messages as UIMessage[]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isLoading ? (
        loadingSkeleton
      ) : (
        <MessageList
          messages={uiMessages}
          isLoading={isChatLoading}
          status={status}
          userInitial={user?.first_name?.charAt(0).toUpperCase() || "U"}
        />
      )}

      <ChatInput
        isStreaming={isChatLoading}
        input={input}
        onInputChange={(value) =>
          handleInputChange({
            target: { value },
          } as ChangeEvent<HTMLTextAreaElement>)
        }
        onSubmit={submitFromInput}
        models={models}
        selectedModel={selectedModel}
        onModelChange={async (model) => {
          if (!token) return;
          try {
            setSelectedModel(model);
            await api.conversations.updateSettings(token, id, { model });
          } catch (error) {
            uiToast.error(error instanceof Error ? error.message : "Unable to connect");
          }
        }}
        onStop={stop}
        canAddContext={canAddContext}
        addContextReason={addContextReason}
        canUseVoice={canUseVoice}
        voiceReason={voiceReason}
      />

      <Dialog open={awaitingApproval} onOpenChange={setAwaitingApproval}>
        <DialogContent
          className="border"
          style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}
        >
          <DialogHeader>
            <DialogTitle>Approval-required action</DialogTitle>
            <DialogDescription>
              This action is marked as approval-required. Confirm to submit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAwaitingApproval(false)}>
              Cancel
            </Button>
            <Button
              style={{ backgroundColor: "var(--accent)", color: "#fff" }}
              onClick={async () => {
                setAwaitingApproval(false);
                try {
                  await handleSubmit();
                } catch (error) {
                  uiToast.error(error instanceof Error ? error.message : "Unable to connect");
                  await refreshCapabilities();
                }
              }}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toUiMessages(messages: UIMessage[]): UiChatMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const textContent = (message.parts || [])
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join("");

      const toolInvocations = (message.parts || [])
        .filter(
          (part): part is Extract<typeof part, { type: string }> =>
            part.type === "dynamic-tool" || part.type.startsWith("tool-")
        )
        .map((part) => {
          const toolPart = part as {
            type: string;
            toolName?: string;
            toolCallId: string;
            input?: unknown;
            output?: unknown;
            errorText?: string;
            state?: string;
          };
          const isDynamicTool = toolPart.type === "dynamic-tool";
          const toolName = isDynamicTool ? toolPart.toolName || "tool" : toolPart.type.slice(5);
          const invocationState: UiToolInvocation["state"] =
            toolPart.state === "output-available" ||
            toolPart.state === "output-error" ||
            toolPart.state === "output-denied"
              ? "result"
              : "call";

          return {
            toolCallId: toolPart.toolCallId,
            toolName,
            args: toolPart.input,
            state: invocationState,
            result: toolPart.output ?? toolPart.errorText,
          };
        });

      return {
        id: message.id,
        role: message.role,
        content: textContent,
        toolInvocations,
      };
    });
}
