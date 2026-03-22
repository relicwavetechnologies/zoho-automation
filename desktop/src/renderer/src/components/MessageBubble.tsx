import { useEffect, useMemo, useState } from "react";
import type { Message } from "../types";
import { cn } from "../lib/utils";
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Share2,
} from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { BlocksRenderer } from "./BlocksRenderer";
import { useAuth } from "../context/AuthContext";
import { Logo } from "./Logo";

interface Props {
  message: Message;
  isLast?: boolean;
}

export function MessageBubble({ message, isLast }: Props): JSX.Element {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [shareState, setShareState] = useState<
    "idle" | "sharing" | "shared" | "failed"
  >("idle");
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [showAllCitations, setShowAllCitations] = useState(false);
  const { token } = useAuth();

  useEffect(() => {
    if (!message.metadata?.shareAction?.shared) {
      setShareState("idle");
      setShareMessage(null);
      return;
    }
    setShareState("shared");
    setShareMessage("Already shared to company scope.");
  }, [message.id, message.metadata?.shareAction?.shared]);

  // Use contentBlocks (new) if available, else fall back to rendering content as text
  const blocks = message.metadata?.contentBlocks;
  const copyableResponse = useMemo(() => {
    if (message.content.trim()) return message.content;
    if (!blocks || blocks.length === 0) return "";
    return blocks
      .map((block) => {
        if (block.type === "text") return block.content;
        if (block.type === "tool")
          return block.resultSummary
            ? `${block.label}\n${block.resultSummary}`
            : block.label;
        if (block.type === "terminal") {
          return [`$ ${block.command}`, block.stdout, block.stderr]
            .filter(Boolean)
            .join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }, [blocks, message.content]);

  const copyResponse = async (): Promise<void> => {
    if (!copyableResponse) return;
    await navigator.clipboard.writeText(copyableResponse);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const displayContent = useMemo(() => {
    if (!isUser) return message.content;
    return message.content
      .replace(/\n*!\[.*?\]\([^)]+\)/g, "")
      .replace(/\n*\[.*?\]\(attachment:[^)]+\)/g, "")
      .trim();
  }, [message.content, isUser]);

  const visibleCitations = useMemo(() => {
    const citations = message.metadata?.citations ?? [];
    return showAllCitations ? citations : citations.slice(0, 3);
  }, [message.metadata?.citations, showAllCitations]);

  const hiddenCitationCount = Math.max(
    0,
    (message.metadata?.citations?.length ?? 0) - visibleCitations.length,
  );

  const shareConversation = async (): Promise<void> => {
    if (!token || !message.metadata?.shareAction || shareState === "sharing")
      return;

    setShareState("sharing");
    setShareMessage(null);
    try {
      const result = await window.desktopAPI.chat.share(
        token,
        message.threadId,
      );
      const payload = result.data as
        | {
            message?: string;
            data?: { status?: string; classification?: string };
          }
        | undefined;
      if (!result.success) {
        setShareState("failed");
        setShareMessage(
          payload?.message ?? "Failed to share this conversation.",
        );
        return;
      }

      const status = payload?.data?.status ?? "processed";
      const classification = payload?.data?.classification;
      setShareState("shared");
      setShareMessage(
        classification
          ? `Share ${status.replace(/_/g, " ")} (${classification}).`
          : `Share ${status.replace(/_/g, " ")}.`,
      );
    } catch {
      setShareState("failed");
      setShareMessage("Failed to share this conversation.");
    }
  };

  return (
    <div className="group mb-8 last:mb-0">
      <div
        className={cn(
          "flex w-full flex-col gap-2",
          isUser ? "items-end" : "items-start",
        )}
      >
        {/* Identity Header (Logo only for AI, Nothing for User) */}
        {!isUser && (
          <div className="flex items-center gap-2 mb-1 ml-1 opacity-50">
            <Logo size={14} className="opacity-80" />
          </div>
        )}

        {/* Content Container */}
        <div
          className={cn(
            "relative min-w-0 max-w-[90%] flex flex-col",
            isUser ? "items-end" : "items-start",
          )}
        >
          {message.metadata?.attachedFiles &&
            message.metadata.attachedFiles.length > 0 && (
              <div
                className={cn(
                  "flex flex-wrap gap-2 mb-2",
                  isUser ? "flex-row-reverse" : "flex-row",
                )}
              >
                {message.metadata.attachedFiles.map((file) => (
                  <div key={file.fileAssetId} className="relative group/file">
                    {file.mimeType.startsWith("image/") ? (
                      <img
                        src={file.cloudinaryUrl}
                        alt={file.fileName}
                        className="w-16 h-16 rounded-xl object-cover border border-border hover:border-primary/30 transition-colors cursor-pointer shadow-sm"
                        title={file.fileName}
                        onClick={() =>
                          window.open(file.cloudinaryUrl, "_blank")
                        }
                      />
                    ) : (
                      <div
                        className="w-16 h-16 rounded-xl flex flex-col items-center justify-center gap-1 border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer shadow-sm"
                        title={file.fileName}
                        onClick={() =>
                          window.open(file.cloudinaryUrl, "_blank")
                        }
                      >
                        {file.mimeType === "application/pdf" ? (
                          <FileText size={18} className="text-red-400/70" />
                        ) : (
                          <FileText
                            size={18}
                            className="text-muted-foreground"
                          />
                        )}
                        <span className="text-[9px] font-medium text-muted-foreground truncate w-full px-1 text-center">
                          {file.fileName.includes(".")
                            ? file.fileName
                                .slice(file.fileName.lastIndexOf(".") + 1)
                                .toUpperCase()
                            : "FILE"}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

          {!isUser && copyableResponse && (
            <div className="absolute right-0 -top-6 z-10 flex gap-2 opacity-0 transition-all group-hover:opacity-100">
              <button
                onClick={() => void copyResponse()}
                className="rounded-lg border border-border bg-background px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
              >
                {copied ? (
                  <Check size={10} className="mr-1 inline-block" />
                ) : (
                  <Copy size={10} className="mr-1 inline-block" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {isUser ? (
            <div className="group/user relative inline-block rounded-3xl bg-secondary/40 px-5 py-3.5 max-w-[85%] border border-border/50 shadow-sm text-right mt-1 mb-1 break-words">
              <p className="text-[14px] leading-[1.6] text-foreground/90 whitespace-pre-wrap text-left break-words">
                {displayContent}
              </p>

              <div className="absolute -left-10 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/user:opacity-100">
                <button
                  onClick={() => void copyResponse()}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary/80 border border-border/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
                  title="Copy message"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          ) : blocks && blocks.length > 0 ? (
            <div className="w-full">
              <BlocksRenderer blocks={blocks} isStreaming={false} />
            </div>
          ) : (
            <div className="w-full">
              <MarkdownContent
                content={message.content}
                className="desktop-markdown text-sm leading-relaxed text-foreground/85"
              />
            </div>
          )}

          {/* Lark doc references */}
          {message.metadata?.larkDocs &&
            message.metadata.larkDocs.length > 0 && (
              <div className="mt-2 flex flex-col gap-1 w-full">
                {message.metadata.larkDocs.map((doc) => (
                  <div
                    key={doc.documentId}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-secondary/30 border border-border/50"
                  >
                    <FileText size={12} className="text-amber-500/70" />
                    <span className="text-xs text-muted-foreground">
                      {doc.title}
                    </span>
                  </div>
                ))}
              </div>
            )}

          {!isUser &&
            message.metadata?.citations &&
            message.metadata.citations.length > 0 && (
              <div className="mt-2 w-full">
                <div className="flex flex-wrap items-center gap-1.5">
                  {visibleCitations.map((citation) => {
                    const content = (
                      <>
                        <FileText
                          size={11}
                          className="text-amber-500/70 shrink-0"
                        />
                        <span className="max-w-0 overflow-hidden whitespace-nowrap text-[10px] opacity-0 transition-all duration-300 ease-in-out group-hover:max-w-[200px] group-hover:opacity-100 group-hover:ml-1.5 truncate">
                          {citation.title}
                        </span>
                      </>
                    );

                    if (citation.url) {
                      return (
                        <a
                          key={citation.id}
                          href={citation.url}
                          target="_blank"
                          rel="noreferrer"
                          className="group flex h-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/30 px-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-all shadow-sm"
                        >
                          {content}
                        </a>
                      );
                    }

                    return (
                      <div
                        key={citation.id}
                        className="group flex h-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/30 px-1.5 text-muted-foreground shadow-sm transition-all"
                      >
                        {content}
                      </div>
                    );
                  })}

                  {message.metadata.citations.length > 3 && (
                    <button
                      onClick={() => setShowAllCitations((value) => !value)}
                      className="h-6 px-2 flex items-center justify-center rounded-full border border-border bg-secondary/30 text-[10px] font-black text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
                    >
                      {showAllCitations ? "LESS" : `+${hiddenCitationCount}`}
                    </button>
                  )}
                </div>
              </div>
            )}

          {!isUser && isLast && message.metadata?.shareAction && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void shareConversation()}
                disabled={shareState === "sharing" || shareState === "shared"}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {shareState === "sharing" ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Share2 size={11} />
                )}
                <span>
                  {shareState === "shared"
                    ? "Shared"
                    : message.metadata.shareAction.label}
                </span>
              </button>
            </div>
          )}

          {!isUser && shareMessage && (
            <div
              className={cn(
                "mt-2 text-xs",
                shareState === "failed"
                  ? "text-[hsl(0,50%,60%)]"
                  : "text-[hsl(140,45%,60%)]",
              )}
            >
              {shareMessage}
            </div>
          )}

          {/* Error */}
          {message.metadata?.error && (
            <div className="mt-2 px-2 py-1 rounded bg-[hsl(0,40%,10%)] border border-[hsl(0,40%,20%)] w-full">
              <span className="text-xs text-[hsl(0,50%,60%)]">
                {message.metadata.error}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
