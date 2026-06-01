import { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MessageList } from './MessageList';
import { EmptyState } from './EmptyState';
import { Composer } from './Composer';
import { EditorPane } from '../editor/EditorPane';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { useWorkspaceStore } from '@/store/workspace';

export function ChatLayout() {
  const { session, status, error } = useAuthStore();
  const { threads, activeThreadId, loadThreads, loadMessages, connect, disconnect } = useChatStore();
  const [editorOpen, setEditorOpen] = useState(false);

  const active = threads.find((t) => t.id === activeThreadId) ?? null;
  const hasMessages = (active?.messages.length ?? 0) > 0;

  useEffect(() => {
    if (!session?.token) return;
    void useWorkspaceStore.getState().hydrateRemote(session.token)
      .then(() => loadThreads(session.token));
    connect(session.token);
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  useEffect(() => {
    if (!activeThreadId || !session?.token) return;
    void loadMessages(session.token, activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, session?.token]);

  useEffect(() => {
    useWorkspaceStore.getState().hydrate();
  }, []);

  return (
    <SidebarProvider
      defaultOpen
      style={
        {
          '--sidebar-width': '252px',
          '--sidebar-width-icon': '52px',
        } as React.CSSProperties
      }
      className="h-full !min-h-0"
    >
      <Sidebar />

      <SidebarInset className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <Header
          editorOpen={editorOpen}
          onToggleEditor={() => setEditorOpen((v) => !v)}
        />

        {status === 'authenticating' ? (
          <AuthBanner tone="info">
            Lark authentication is open in your browser. Complete it there, then return to Divo.
          </AuthBanner>
        ) : null}
        {status === 'error' && error ? (
          <AuthBanner tone="error">{error}</AuthBanner>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {hasMessages && active ? (
              <>
                <MessageList thread={active} />
                <Composer />
              </>
            ) : (
              <EmptyState />
            )}
          </div>
          {editorOpen ? (
            <div className="w-[480px] shrink-0 border-l border-border-subtle">
              <EditorPane onClose={() => setEditorOpen(false)} />
            </div>
          ) : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AuthBanner({ children, tone }: { children: React.ReactNode; tone: 'info' | 'error' }) {
  return (
    <div
      className={
        tone === 'error'
          ? 'border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive'
          : 'border-b border-info/30 bg-info/10 px-4 py-2 text-xs text-info'
      }
    >
      {children}
    </div>
  );
}
