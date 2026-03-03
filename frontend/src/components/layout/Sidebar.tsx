"use client";

import { useEffect, useState } from "react";
import { Ellipsis, LogOut, Plus, Settings, UserCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { Conversation, User } from "@/types";

interface SidebarProps {
  conversations: Conversation[];
  isOpen: boolean;
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  pathname: string;
  membershipRole: string | null;
  user: User | null;
  onNewChat: () => Promise<void>;
  onNavigate: (path: string) => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => Promise<void> | void;
  onDeleteConversation: (id: string) => void;
  onSaveSystemPrompt: (prompt: string | null) => Promise<void>;
  onLogout: () => void;
}

function groupConversations(conversations: Conversation[]) {
  const groups = {
    Today: [] as Conversation[],
    Yesterday: [] as Conversation[],
    "This Week": [] as Conversation[],
    Older: [] as Conversation[],
  };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  conversations
    .slice()
    .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
    .forEach((conversation) => {
      const ts = +new Date(conversation.updated_at || conversation.created_at);
      if (ts >= todayStart) groups.Today.push(conversation);
      else if (ts >= yesterdayStart) groups.Yesterday.push(conversation);
      else if (ts >= weekStart) groups["This Week"].push(conversation);
      else groups.Older.push(conversation);
    });

  return groups;
}

export default function Sidebar({
  conversations,
  isOpen,
  activeConversationId,
  activeConversation,
  pathname,
  membershipRole,
  user,
  onNewChat,
  onNavigate,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onSaveSystemPrompt,
  onLogout,
}: SidebarProps) {
  const grouped = groupConversations(conversations);
  const [promptDraft, setPromptDraft] = useState(activeConversation?.system_prompt || "");
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    setPromptDraft(activeConversation?.system_prompt || "");
  }, [activeConversation?.id, activeConversation?.system_prompt]);

  const isAdmin = membershipRole === "owner" || membershipRole === "admin";

  return (
    <aside
      className="absolute left-0 top-0 z-20 flex h-screen w-[260px] flex-col border-r transition-transform duration-200 md:relative"
      style={{
        backgroundColor: "var(--bg-surface)",
        borderColor: "var(--border-subtle)",
        transform: isOpen ? "translateX(0)" : "translateX(-260px)",
      }}
    >
      <div className="px-4 py-4">
        <div className="mb-4 flex items-center gap-2">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
            style={{ backgroundColor: "var(--accent-subtle)", color: "var(--accent)" }}
          >
            H
          </div>
          <p className="text-[20px] font-semibold" style={{ color: "var(--accent)" }}>
            Halo
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onNewChat()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm transition-colors hover:bg-hover"
          style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
        >
          <Plus className="h-4 w-4" />
          New Chat
        </button>
      </div>

      <div className="min-h-0 flex-1 border-t" style={{ borderColor: "var(--border-subtle)" }}>
        <ScrollArea className="h-full px-2 py-3">
          <div className="mb-4 space-y-1">
            <button
              type="button"
              onClick={() => onNavigate("/")}
              className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
              style={{
                backgroundColor: pathname === "/" ? "var(--bg-elevated)" : "transparent",
                color: pathname === "/" ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              Chat
            </button>

            {isAdmin ? (
              <>
                <button
                  type="button"
                  onClick={() => onNavigate("/admin/members")}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                  style={{
                    backgroundColor: pathname.startsWith("/admin/members")
                      ? "var(--bg-elevated)"
                      : "transparent",
                    color: pathname.startsWith("/admin/members")
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  }}
                >
                  Members
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("/admin/invites")}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                  style={{
                    backgroundColor: pathname.startsWith("/admin/invites")
                      ? "var(--bg-elevated)"
                      : "transparent",
                    color: pathname.startsWith("/admin/invites")
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  }}
                >
                  Invites
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("/admin/roles")}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                  style={{
                    backgroundColor: pathname.startsWith("/admin/roles")
                      ? "var(--bg-elevated)"
                      : "transparent",
                    color: pathname.startsWith("/admin/roles")
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  }}
                >
                  Roles
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("/admin/tools")}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                  style={{
                    backgroundColor: pathname.startsWith("/admin/tools")
                      ? "var(--bg-elevated)"
                      : "transparent",
                    color: pathname.startsWith("/admin/tools")
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  }}
                >
                  Tools
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("/admin/integrations")}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                  style={{
                    backgroundColor: pathname.startsWith("/admin/integrations")
                      ? "var(--bg-elevated)"
                      : "transparent",
                    color: pathname.startsWith("/admin/integrations")
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  }}
                >
                  Integrations
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("/admin/audit")}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                  style={{
                    backgroundColor: pathname.startsWith("/admin/audit")
                      ? "var(--bg-elevated)"
                      : "transparent",
                    color: pathname.startsWith("/admin/audit")
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  }}
                >
                  Audit
                </button>
              </>
            ) : null}
          </div>

          {Object.entries(grouped).map(([label, items]) => {
            if (items.length === 0) return null;
            return (
              <div key={label} className="mb-4">
                <p className="mb-2 px-2 text-xs uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
                  {label}
                </p>
                <div className="space-y-1">
                  {items.map((conversation) => {
                    const active = conversation.id === activeConversationId;
                    return (
                      <div key={conversation.id} className="group flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onSelectConversation(conversation.id)}
                          className="flex min-w-0 flex-1 items-center rounded-md border-l-2 px-2 py-2 text-left text-sm transition-colors hover:bg-hover"
                          style={{
                            borderLeftColor: active ? "var(--accent)" : "transparent",
                            backgroundColor: active ? "var(--bg-elevated)" : "transparent",
                            color: active ? "var(--text-primary)" : "var(--text-secondary)",
                          }}
                          title={conversation.title}
                        >
                          <span className="truncate">{conversation.title || "New conversation"}</span>
                        </button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="invisible rounded-md p-1 opacity-70 group-hover:visible hover:bg-hover"
                              style={{ color: "var(--text-secondary)" }}
                            >
                              <Ellipsis className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="border" style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}>
                            <DropdownMenuItem
                              onClick={() => {
                                setRenameTargetId(conversation.id);
                                setRenameDraft(conversation.title || "");
                                setIsRenameOpen(true);
                              }}
                            >
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onDeleteConversation(conversation.id)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </ScrollArea>
      </div>

      <div className="border-t p-3" style={{ borderColor: "var(--border-subtle)" }}>
        <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
          <DialogContent className="border" style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}>
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                placeholder="Conversation title"
                className="border"
                style={{
                  color: "var(--text-primary)",
                  backgroundColor: "var(--bg-elevated)",
                  borderColor: "var(--border-default)",
                }}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setIsRenameOpen(false)}>
                  Cancel
                </Button>
                <Button
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                  onClick={async () => {
                    if (!renameTargetId || !renameDraft.trim()) return;
                    await onRenameConversation(renameTargetId, renameDraft.trim());
                    setIsRenameOpen(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md p-1 text-left hover:bg-hover">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold"
                style={{ backgroundColor: "var(--accent-subtle)", color: "var(--accent)" }}
              >
                {user?.first_name?.charAt(0).toUpperCase() || <UserCircle2 className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
                  {user ? `${user.first_name} ${user.last_name}` : "Guest"}
                </p>
                <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {user?.email || ""}
                </p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border" style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}>
            <Dialog>
              <DialogTrigger asChild>
                <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
                  <Settings className="mr-2 h-4 w-4" />
                  Profile/Settings
                </DropdownMenuItem>
              </DialogTrigger>
              <DialogContent className="border" style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}>
                <DialogHeader>
                  <DialogTitle>Conversation Settings</DialogTitle>
                </DialogHeader>
                {activeConversation ? (
                  <div className="space-y-3">
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                      System prompt for: <span style={{ color: "var(--text-primary)" }}>{activeConversation.title}</span>
                    </p>
                    <Textarea
                      value={promptDraft}
                      onChange={(event) => setPromptDraft(event.target.value)}
                      className="min-h-[140px]"
                    />
                    <div className="flex gap-2">
                      <Button
                        onClick={async () => {
                          setIsSavingPrompt(true);
                          try {
                            await onSaveSystemPrompt(promptDraft.trim() || null);
                          } finally {
                            setIsSavingPrompt(false);
                          }
                        }}
                        disabled={isSavingPrompt}
                        style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                      >
                        {isSavingPrompt ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          setPromptDraft("");
                          await onSaveSystemPrompt(null);
                        }}
                      >
                        Reset to default
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Select a conversation first to edit its system prompt.
                  </p>
                )}
              </DialogContent>
            </Dialog>
            <DropdownMenuItem onClick={onLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
