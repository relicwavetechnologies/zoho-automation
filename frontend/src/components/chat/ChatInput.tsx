"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Paperclip, Square } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { uiToast } from "@/lib/toast";
import type { Model } from "@/types";

interface ChatInputProps {
  isStreaming?: boolean;
  onStop?: () => void;
  models?: Model[];
  selectedModel?: string;
  onModelChange?: (model: string) => Promise<void> | void;
  input?: string;
  onInputChange?: (value: string) => void;
  onSubmit?: () => Promise<void> | void;
  onSend?: (message: string) => Promise<void> | void;
  canAddContext?: boolean;
  addContextReason?: string | null;
  canUseVoice?: boolean;
  voiceReason?: string | null;
}

export default function ChatInput({
  isStreaming = false,
  onStop,
  models = [],
  selectedModel,
  onModelChange,
  input,
  onInputChange,
  onSubmit,
  onSend,
  canAddContext = true,
  addContextReason = null,
  canUseVoice = true,
  voiceReason = null,
}: ChatInputProps) {
  const [internalValue, setInternalValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const value = input ?? internalValue;

  useEffect(() => {
    if (!textAreaRef.current) return;
    const el = textAreaRef.current;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const setValue = (nextValue: string) => {
    if (onInputChange) {
      onInputChange(nextValue);
      return;
    }
    setInternalValue(nextValue);
  };

  const canSend = value.trim().length > 0 && !isStreaming && !isSending;

  const send = async () => {
    const payload = value.trim();
    if (!payload || isStreaming || isSending) return;

    setIsSending(true);
    try {
      if (onSubmit) {
        await onSubmit();
      } else if (onSend) {
        await onSend(payload);
      }

      setValue("");
      if (textAreaRef.current) {
        textAreaRef.current.style.height = "44px";
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  return (
    <div
      className="sticky bottom-0 px-6 pb-0 pt-2"
      style={{
        background: "linear-gradient(to top, var(--bg-base), rgba(15,15,15,0))",
      }}
    >
      <div className="mx-auto w-full max-w-[720px]">
        <form
          onSubmit={handleFormSubmit}
          className="overflow-hidden rounded-t-[26px] rounded-b-none border"
          style={{
            backgroundColor: "var(--bg-surface)",
            borderColor: "var(--border-default)",
            borderBottomColor: "transparent",
          }}
        >
          <div className="px-5 pb-2 pt-4">
            <Textarea
              ref={textAreaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
                if (event.key === "Escape") {
                  setValue("");
                  event.currentTarget.blur();
                }
              }}
              placeholder="Type your message..."
              className="min-h-[56px] max-h-[180px] w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-[15px] text-primary shadow-none focus-visible:ring-0"
            />
          </div>

          <div
            className="flex items-center justify-between px-4 pb-3 pt-1.5"
            style={{ backgroundColor: "var(--bg-surface)" }}
          >
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md"
                    style={{
                      color: "var(--text-tertiary)",
                      backgroundColor: "var(--bg-hover)",
                      opacity: canAddContext ? 1 : 0.5,
                    }}
                    onClick={() =>
                      canAddContext
                        ? uiToast.info("Coming soon")
                        : uiToast.error(addContextReason || "tool_not_permitted")
                    }
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Add context (coming soon)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md"
                    style={{
                      color: "var(--text-tertiary)",
                      backgroundColor: "var(--bg-hover)",
                      opacity: canUseVoice ? 1 : 0.5,
                    }}
                    onClick={() =>
                      canUseVoice
                        ? uiToast.info("Coming soon")
                        : uiToast.error(voiceReason || "tool_not_permitted")
                    }
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Voice input (coming soon)</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-8 rounded-md border px-2 text-xs"
                    style={{
                      borderColor: "var(--border-default)",
                      color: "var(--text-primary)",
                      backgroundColor: "var(--bg-elevated)",
                    }}
                  >
                    {models.find((model) => model.id === selectedModel)?.name || "Model"}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="border"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--bg-surface)",
                  }}
                >
                  {models.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      onClick={() => void onModelChange?.(model.id)}
                      className="text-sm"
                    >
                      {model.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{
                    backgroundColor: "var(--bg-hover)",
                    color: "var(--text-primary)",
                  }}
                  aria-label="Stop"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                    canSend ? "text-white" : "cursor-not-allowed"
                  )}
                  style={{
                    backgroundColor: canSend ? "var(--accent)" : "var(--bg-hover)",
                    color: canSend ? "#fff" : "var(--text-tertiary)",
                  }}
                  aria-label="Send"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
