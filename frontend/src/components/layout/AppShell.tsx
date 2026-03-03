"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import TopBar from "@/components/layout/TopBar";
import Sidebar from "@/components/layout/Sidebar";
import { useAuth } from "@/context/AuthContext";
import { useConversations } from "@/hooks/useConversations";
import { uiToast } from "@/lib/toast";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, token, membership, logout } = useAuth();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const {
    conversations,
    refresh,
    updateSettings,
    renameLocal,
    deleteRemote,
  } = useConversations(token);

  const activeConversationId = useMemo(() => {
    const match = pathname.match(/^\/([^/]+)$/);
    return match ? match[1] : null;
  }, [pathname]);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) || null,
    [conversations, activeConversationId]
  );

  useEffect(() => {
    if (!token) return;
    void refresh();
  }, [pathname, token, refresh]);

  useEffect(() => {
    const onConversationChanged = () => {
      if (!token) return;
      void refresh();
    };

    window.addEventListener("conversations:changed", onConversationChanged);
    return () => {
      window.removeEventListener("conversations:changed", onConversationChanged);
    };
  }, [token, refresh]);

  const handleNewChat = async () => {
    router.push("/");
  };

  return (
    <div className="relative flex h-screen overflow-hidden bg-base">
      <Sidebar
        conversations={conversations}
        isOpen={isSidebarOpen}
        activeConversationId={activeConversationId}
        activeConversation={activeConversation}
        pathname={pathname}
        membershipRole={membership?.role_key || null}
        user={user}
        onNewChat={handleNewChat}
        onNavigate={(path) => router.push(path)}
        onSelectConversation={(id) => router.push(`/${id}`)}
        onRenameConversation={async (id, title) => {
          renameLocal(id, title);
          try {
            await updateSettings(id, { title });
            uiToast.success("Conversation renamed");
          } catch (error) {
            uiToast.error(error instanceof Error ? error.message : "Unable to connect");
          }
        }}
        onDeleteConversation={(id) => {
          void (async () => {
            try {
              await deleteRemote(id);
              if (activeConversationId === id) router.push("/");
              uiToast.success("Conversation deleted");
            } catch (error) {
              uiToast.error(error instanceof Error ? error.message : "Unable to connect");
            }
          })();
        }}
        onSaveSystemPrompt={async (prompt) => {
          if (!activeConversationId) return;
          try {
            await updateSettings(activeConversationId, {
              system_prompt: prompt || undefined,
            });
            uiToast.success("System prompt saved");
          } catch (error) {
            uiToast.error(error instanceof Error ? error.message : "Unable to connect");
          }
        }}
        onLogout={logout}
      />

      <main
        className="flex h-screen flex-1 flex-col overflow-hidden transition-[margin] duration-200"
        style={{ marginLeft: isSidebarOpen ? 0 : -260 }}
      >
        <TopBar
          conversation={activeConversation}
          onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
          onTitleChange={async (title) => {
            if (!activeConversationId) return;
            renameLocal(activeConversationId, title);
            try {
              await updateSettings(activeConversationId, { title });
            } catch {
              // optional title support
            }
          }}
        />

        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    </div>
  );
}
