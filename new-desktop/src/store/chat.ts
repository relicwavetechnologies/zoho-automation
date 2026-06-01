import { create } from 'zustand';
import { createThread as apiCreateThread, deleteThread as apiDeleteThread, listThreads, getThread } from '@/lib/api';
import type { ChatMessage, Thread, ApprovalRequest, TimelineItem, TerminalBlock } from '@/types/chat';
import type { StatusEvent } from '@/types/status-events';
import { DesktopWsClient, type WsState } from '@/lib/ws';
import { runLocalCommand, killLocalCommand } from '@/lib/tauri';
import { useWorkspaceStore, type Workspace } from '@/store/workspace';

interface ChatState {
  threads: Thread[];
  activeThreadId: string | null;
  ws: DesktopWsClient | null;
  wsState: WsState;
  isStreaming: boolean;
  loadedThreadIds: Set<string>;
  /** Threads where the user chose "don't ask again" — terminal commands auto-run. */
  autoRunChats: Set<string>;

  loadThreads: (token: string) => Promise<void>;
  selectThread: (id: string | null) => void;
  loadMessages: (token: string, threadId: string) => Promise<void>;
  newThread: (token: string, workspace?: Workspace | null) => Promise<Thread | null>;
  removeThread: (token: string, id: string) => Promise<void>;
  send: (
    token: string,
    text: string,
    opts?: { threadId?: string; workspace?: { name: string; path: string } | null },
  ) => boolean;
  cancel: () => void;
  respondTerminal: (
    threadId: string,
    callId: string,
    decision: 'run' | 'decline',
    remember?: 'chat',
  ) => void;
  cancelTerminal: (callId: string) => void;
  connect: (token: string) => void;
  disconnect: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  threads: [],
  activeThreadId: null,
  ws: null,
  wsState: 'idle',
  isStreaming: false,
  loadedThreadIds: new Set<string>(),
  autoRunChats: new Set<string>(),

  loadThreads: async (token) => {
    const res = await listThreads(token);
    if (!res.success || !res.data) return;
    useWorkspaceStore.getState().mergeRemote(
      res.data.flatMap((thread) => (thread.workspace ? [thread.workspace] : [])),
    );
    const threads: Thread[] = res.data.map((t) => ({
      id: t.id,
      title: t.title,
      workspaceId: t.workspaceId ?? null,
      workspaceName: t.workspaceName ?? t.workspace?.name ?? null,
      workspacePath: t.workspacePath ?? t.workspace?.path ?? null,
      lastMessageAt: t.lastMessageAt,
      messageCount: t.messageCount ?? t._count?.messages ?? 0,
      messages: [],
    }));
    set({ threads, activeThreadId: threads[0]?.id ?? null });
  },

  selectThread: (id: string | null) => set({ activeThreadId: id }),

  loadMessages: async (token, threadId) => {
    const { loadedThreadIds, isStreaming, activeThreadId } = get();
    if (loadedThreadIds.has(threadId)) return;
    // Don't overwrite in-flight streaming messages for the active thread.
    if (isStreaming && activeThreadId === threadId) return;

    const res = await getThread(token, threadId);
    if (!res.success || !res.data) return;

    const fetched: ChatMessage[] = res.data.messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      createdAt: m.createdAt,
    }));

    set((s) => {
      // Preserve any optimistic/streaming messages that arrived during the fetch.
      const currentThread = s.threads.find((t) => t.id === threadId);
      const liveMessages = (currentThread?.messages ?? []).filter(
        (m) => m.id.startsWith('local-') || m.streaming,
      );
      return {
        loadedThreadIds: new Set([...s.loadedThreadIds, threadId]),
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: [...fetched, ...liveMessages],
                messageCount: res.data!.pagination.totalMessages,
              }
            : t,
        ),
      };
    });
  },

  newThread: async (token, workspace = null) => {
    const res = await apiCreateThread(token, {
      workspaceId: workspace?.id ?? null,
      workspace: workspace ? { id: workspace.id, path: workspace.path, name: workspace.name } : null,
    });
    if (!res.success || !res.data) return null;
    if (res.data.workspace) {
      useWorkspaceStore.getState().mergeRemote([res.data.workspace]);
    }
    const t: Thread = {
      id: res.data.id,
      title: res.data.title,
      workspaceId: res.data.workspaceId,
      workspaceName: res.data.workspaceName ?? res.data.workspace?.name ?? null,
      workspacePath: res.data.workspacePath ?? res.data.workspace?.path ?? null,
      lastMessageAt: res.data.lastMessageAt,
      messageCount: 0,
      messages: [],
    };
    // Mark newly created threads as already loaded so the ChatLayout useEffect
    // doesn't trigger a loadMessages fetch while the first message is in-flight.
    // On the next session (app restart) loadedThreadIds resets and history loads normally.
    set((s) => ({
      threads: [t, ...s.threads],
      activeThreadId: t.id,
      loadedThreadIds: new Set([...s.loadedThreadIds, t.id]),
    }));
    return t;
  },

  removeThread: async (token, id) => {
    await apiDeleteThread(token, id);
    set((s) => {
      const threads = s.threads.filter((t) => t.id !== id);
      const activeThreadId =
        s.activeThreadId === id ? (threads[0]?.id ?? null) : s.activeThreadId;
      return { threads, activeThreadId };
    });
  },

  connect: (token) => {
    coalesceSet = set;
    get().ws?.close();
    const ws = new DesktopWsClient({
      token,
      onEvent: (event) => applyEvent(set, get, event),
      onStateChange: (wsState) => set({ wsState }),
      onInterrupted: () => {
        // Socket dropped mid-run — the backend's output sink is gone, so the
        // turn can never complete. Finalize it instead of spinning forever.
        if (!get().isStreaming) return;
        const tid = get().activeThreadId;
        if (tid) flushDeltas(tid); // commit any buffered text before finalizing
        set((s) => ({
          isStreaming: false,
          threads: tid
            ? s.threads.map((t) => (t.id === tid ? interruptLastAssistant(t) : t))
            : s.threads,
        }));
      },
    });
    ws.connect();
    set({ ws });
  },

  disconnect: () => {
    get().ws?.close();
    set({ ws: null, wsState: 'closed', loadedThreadIds: new Set<string>() });
  },

  send: (_token, text, opts) => {
    const { ws, activeThreadId } = get();
    const threadId = opts?.threadId ?? activeThreadId;
    if (!threadId) return false;

    const requestId = crypto.randomUUID();
    if (!ws) {
      appendSystemMessage(set, threadId, 'Engine connection is not ready yet. Please try again.');
      return false;
    }

    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      threadId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    const sent = ws.send({
      type: 'chat.start',
      requestId,
      threadId,
      message: text,
      ...(opts?.workspace ? { workspace: opts.workspace } : {}),
    });

    if (!sent) {
      appendSystemMessage(set, threadId, 'Engine socket is not connected. Wait for “Engine connected” and try again.');
      return false;
    }

    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: [...t.messages, userMsg], lastMessageAt: userMsg.createdAt }
          : t,
      ),
      isStreaming: true,
    }));
    return true;
  },

  cancel: () => {
    const { ws, activeThreadId } = get();
    if (!ws || !activeThreadId) return;
    ws.send({ type: 'cancel', threadId: activeThreadId });
    set({ isStreaming: false });
  },

  respondTerminal: (threadId, callId, decision, remember) => {
    if (remember) {
      set((s) => ({ autoRunChats: new Set([...s.autoRunChats, threadId]) }));
    }
    if (decision === 'run') {
      void runTerminalLocally(set, get, threadId, callId);
    } else {
      applyBlock(set, threadId, callId, (b) => ({ ...b, status: 'declined' }));
      get().ws?.sendTerminalResult(threadId, {
        callId,
        status: 'declined',
        message:
          "The user declined to run this command. Do not retry it; ask what they'd prefer, explain what it would have done, or offer auto-run.",
      });
    }
  },

  cancelTerminal: (callId) => {
    void killLocalCommand(callId);
  },
}));

type SetFn = (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void;
type GetFn = () => ChatState;

function applyBlock(
  set: SetFn,
  threadId: string,
  callId: string,
  updater: (b: TerminalBlock) => TerminalBlock,
) {
  set((s) => ({
    threads: s.threads.map((t) => (t.id === threadId ? updateTerminalBlock(t, callId, updater) : t)),
  }));
}

/** Run a gated command on the user's machine via Tauri, streaming into the
 *  timeline's terminal item, then report the result back to the backend. */
async function runTerminalLocally(set: SetFn, get: GetFn, threadId: string, callId: string) {
  const block = get()
    .threads.find((t) => t.id === threadId)
    ?.messages.flatMap((m) => m.timeline ?? [])
    .find((it): it is Extract<TimelineItem, { kind: 'terminal' }> => it.kind === 'terminal' && it.block.callId === callId)
    ?.block;
  if (!block) return;

  applyBlock(set, threadId, callId, (b) => ({ ...b, status: 'running', output: '' }));

  try {
    const res = await runLocalCommand(callId, block.command, block.cwd || null, undefined, (data) => {
      applyBlock(set, threadId, callId, (b) => ({ ...b, output: capOutput(b.output + data) }));
    });
    applyBlock(set, threadId, callId, (b) => {
      // If live chunks never arrived (e.g. fast command), fall back to the
      // captured stdout/stderr from the final result so the panel isn't empty.
      const streamed = b.output.trim();
      const captured = [res.stdout, res.stderr].filter(Boolean).join('');
      const base = streamed ? b.output : captured;
      return {
        ...b,
        status: 'done',
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        output: res.cancelled ? `${base}\n⊘ terminated by user` : base,
      };
    });
    get().ws?.sendTerminalResult(threadId, {
      callId,
      status: 'completed',
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.durationMs,
      timedOut: res.timedOut,
      ...(res.cancelled
        ? { message: 'The user terminated this command before it finished.' }
        : res.timedOut
          ? { message: `Command timed out after ${res.durationMs}ms.` }
          : {}),
    });
  } catch (e) {
    applyBlock(set, threadId, callId, (b) => ({ ...b, status: 'done', exitCode: -1 }));
    get().ws?.sendTerminalResult(threadId, {
      callId,
      status: 'completed',
      exitCode: -1,
      stderr: String(e),
      message: `Local execution failed: ${String(e)}`,
    });
  }
}

/** Apply one (possibly coalesced) chunk of streamed reply text to a thread's
 *  active assistant message. Factored out so both the rAF flush and any direct
 *  caller share the exact same timeline logic. */
function applyTextDelta(t: Thread, delta: string): Thread {
  return updateLastAssistant(t, (m) => {
    let tl = m.timeline ?? [];
    // On the first user-facing text: if no tool/terminal ever ran, the
    // preceding thoughts were just narrating this very reply → drop them.
    if (!m.hasContent) {
      const hasWork = tl.some((it) => it.kind === 'tool' || it.kind === 'terminal');
      tl = hasWork ? commitThoughts(tl) : tl.filter((it) => it.kind !== 'thought');
    }
    return {
      ...m,
      content: m.content + delta,
      hasContent: true,
      timeline: appendText(tl, delta),
    };
  });
}

// ── Text-delta coalescing ─────────────────────────────────────────────────────
// Tokens arrive far faster than a screen can paint (often <5ms apart) while a
// full React render + markdown re-parse costs more. Rendering one-per-token caps
// visible throughput below the model's real speed — text appears to crawl even
// though the wire is fast. We buffer deltas in a plain ref and flush at most once
// per animation frame (~16ms), so React sees one update per frame regardless of
// token rate. This is the ref-buffer + requestAnimationFrame pattern used by
// production AI chat UIs.
let coalesceSet: SetFn | null = null;
const pendingDeltas = new Map<string, string>();
let deltaRaf: number | null = null;

function bufferDelta(threadId: string, delta: string) {
  pendingDeltas.set(threadId, (pendingDeltas.get(threadId) ?? '') + delta);
  if (deltaRaf !== null) return;
  deltaRaf = requestAnimationFrame(() => {
    deltaRaf = null;
    flushDeltas();
  });
}

/** Commit buffered text. With no argument, flushes every thread; with a
 *  threadId, flushes just that one (used to preserve ordering right before a
 *  structural event for the same thread is applied). */
function flushDeltas(threadId?: string) {
  if (!coalesceSet || pendingDeltas.size === 0) return;
  const entries: Array<[string, string]> = [];
  if (threadId !== undefined) {
    const d = pendingDeltas.get(threadId);
    if (d === undefined) return;
    pendingDeltas.delete(threadId);
    entries.push([threadId, d]);
  } else {
    for (const e of pendingDeltas.entries()) entries.push(e);
    pendingDeltas.clear();
  }
  coalesceSet((s) => ({
    threads: s.threads.map((t) => {
      const d = entries.find(([id]) => id === t.id)?.[1];
      return d !== undefined ? applyTextDelta(t, d) : t;
    }),
  }));
}

function applyEvent(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  event: StatusEvent,
) {
  coalesceSet = set;

  // Text deltas are buffered and flushed on the next animation frame.
  if (event.kind === 'message.delta') {
    bufferDelta(event.threadId, event.delta);
    return;
  }
  // Every other (structural) event must observe all reply text streamed so far,
  // in order — flush this thread's pending deltas synchronously before applying.
  flushDeltas(event.threadId);

  const { threads } = get();
  const thread = threads.find((t) => t.id === event.threadId);
  if (!thread) return;

  const next = (updater: (t: Thread) => Thread) => {
    set((s) => ({
      threads: s.threads.map((t) => (t.id === event.threadId ? updater(t) : t)),
    }));
  };

  switch (event.kind) {
    case 'message.started': {
      const msg: ChatMessage = {
        id: event.messageId,
        threadId: event.threadId,
        role: 'assistant',
        content: '',
        createdAt: event.at,
        streaming: true,
        timeline: [],
        hasContent: false,
      };
      next((t) => ({ ...t, messages: [...t.messages, msg] }));
      break;
    }
    case 'message.completed': {
      next((t) => ({
        ...t,
        messages: t.messages.map((m) => {
          if (m.id !== event.messageId) return m;
          let tl = finalizeTimeline(m.timeline ?? []);
          // Safety: if no text segment ever streamed, seed the answer from the
          // final content so the reply isn't lost.
          if (event.content && !tl.some((it) => it.kind === 'text')) {
            tl = [...tl, { kind: 'text', id: tlId('tx'), text: event.content }];
          }
          return {
            ...m,
            content: event.content,
            streaming: false,
            hasContent: true,
            timeline: tl,
            workMs: Math.max(0, Date.parse(event.at) - Date.parse(m.createdAt)),
          };
        }),
        lastMessageAt: event.at,
      }));
      break;
    }
    case 'plan': {
      // Plan snapshots don't drive UI; the timeline covers the flow.
      break;
    }
    case 'thinking': {
      next((t) =>
        updateLastAssistant(t, (m) =>
          // Once the reply is streaming, thinking is redundant with visible text.
          m.hasContent ? m : { ...m, timeline: pushThought(m.timeline ?? [], event.message) },
        ),
      );
      break;
    }
    case 'tool.start': {
      // De-dupe: runCommand is represented by its terminal card, not a tool row.
      const realToolId = resolveToolId(event.toolName, event.args);
      if (realToolId === 'runCommand') break;
      const item: TimelineItem = {
        kind: 'tool',
        id: event.toolCallId,
        toolName: realToolId,
        family: event.family,
        verb: event.verb ?? `Calling ${realToolId}…`,
        ...(typeof event.summary === 'string' ? { arg: event.summary } : {}),
        status: 'running',
        shimmer: true,
      };
      next((t) =>
        updateLastAssistant(t, (m) => ({
          ...m,
          timeline: [...commitThoughts(m.timeline ?? []), item],
        })),
      );
      break;
    }
    case 'tool.progress': {
      next((t) =>
        updateLastAssistant(t, (m) => ({
          ...m,
          timeline: (m.timeline ?? []).map((it) =>
            it.kind === 'tool' && it.id === event.toolCallId ? { ...it, arg: event.message } : it,
          ),
        })),
      );
      break;
    }
    case 'tool.done': {
      next((t) =>
        updateLastAssistant(t, (m) => ({
          ...m,
          timeline: (m.timeline ?? []).map((it) =>
            it.kind === 'tool' && it.id === event.toolCallId
              ? {
                  ...it,
                  status: 'done' as const,
                  shimmer: false,
                  verb: event.past ?? it.verb,
                  arg: event.summary,
                  durationMs: event.durationMs ?? it.durationMs,
                  ...(event.outputPreview ? { detail: event.outputPreview } : {}),
                }
              : it,
          ),
        })),
      );
      break;
    }
    case 'tool.error': {
      next((t) =>
        updateLastAssistant(t, (m) => ({
          ...m,
          timeline: (m.timeline ?? []).map((it) =>
            it.kind === 'tool' && it.id === event.toolCallId
              ? { ...it, status: 'error' as const, shimmer: false, arg: event.error.message }
              : it,
          ),
        })),
      );
      break;
    }
    case 'terminal.request': {
      const item: TimelineItem = {
        kind: 'terminal',
        id: event.callId,
        block: {
          callId: event.callId,
          command: event.command,
          cwd: event.cwd,
          net: event.net,
          status: 'awaiting',
          output: '',
        },
      };
      next((t) =>
        updateLastAssistant(t, (m) => ({
          ...m,
          timeline: [...commitThoughts(m.timeline ?? []), item],
        })),
      );
      // Auto-run when the user opted into "don't ask again" for this chat —
      // but never auto-run network commands; those always re-prompt.
      if (get().autoRunChats.has(event.threadId) && !event.net) {
        void runTerminalLocally(set, get, event.threadId, event.callId);
      }
      break;
    }
    case 'approval.required': {
      const approval: ApprovalRequest = {
        id: event.approvalId,
        action: event.action,
        reason: event.reason,
        payload: event.payload,
        status: 'pending',
        ...(event.approvers ? { approvers: event.approvers } : {}),
      };
      next((t) => attachApproval(t, approval));
      break;
    }
    case 'approval.resolved': {
      next((t) => resolveApproval(t, event.approvalId, event.decision, event.resolvedBy));
      break;
    }
    case 'run.completed':
    case 'run.cancelled': {
      // Stop any lingering shimmer on the active assistant message.
      next((t) => finalizeLastAssistant(t, event.at));
      set({ isStreaming: false });
      break;
    }
    case 'run.failed': {
      next((t) => {
        const withSystem: Thread = {
          ...t,
          messages: [
            ...t.messages,
            {
              id: `system-${event.runId}`,
              threadId: event.threadId,
              role: 'system',
              content: event.error.message,
              createdAt: event.at,
            },
          ],
        };
        // Finalize the assistant message that was streaming before the failure.
        return finalizeLastAssistant(withSystem, event.at, 'system');
      });
      set({ isStreaming: false });
      break;
    }
    default:
      break;
  }
}

function appendSystemMessage(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  threadId: string,
  content: string,
) {
  const createdAt = new Date().toISOString();
  set((s) => ({
    threads: s.threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            messages: [
              ...t.messages,
              {
                id: `system-${Date.now()}`,
                threadId,
                role: 'system',
                content,
                createdAt,
              },
            ],
          }
        : t,
    ),
    isStreaming: false,
  }));
}

function updateLastAssistant(thread: Thread, updater: (m: ChatMessage) => ChatMessage): Thread {
  const lastIdx = thread.messages.length - 1;
  const last = thread.messages[lastIdx];
  if (!last || last.role !== 'assistant') return thread;
  return {
    ...thread,
    messages: thread.messages.map((m, i) => (i === lastIdx ? updater(m) : m)),
  };
}

/** Connection dropped mid-run: finalize the active assistant message and, if it
 *  has nothing to show, leave a clear note so the turn isn't a blank spinner. */
function interruptLastAssistant(thread: Thread): Thread {
  const idx = thread.messages.length - 1;
  const m = thread.messages[idx];
  if (!m || m.role !== 'assistant' || !m.streaming) return thread;
  let tl = finalizeTimeline(m.timeline ?? []);
  const hasText = tl.some((it) => it.kind === 'text') || m.content.length > 0;
  if (!hasText) {
    tl = [
      ...tl,
      { kind: 'text', id: tlId('tx'), text: '⚠ Connection interrupted — the response didn’t finish. Please send your message again.' },
    ];
  }
  return {
    ...thread,
    messages: thread.messages.map((x, i) => (i === idx ? { ...m, streaming: false, timeline: tl } : x)),
  };
}

/** End-of-run cleanup for the active assistant message: stop all shimmers,
 *  settle dangling states, stamp workMs, mark not-streaming. Idempotent. */
function finalizeLastAssistant(thread: Thread, at: string, skipTrailingRole?: 'system'): Thread {
  let idx = thread.messages.length - 1;
  if (skipTrailingRole && thread.messages[idx]?.role === skipTrailingRole) idx -= 1;
  const m = thread.messages[idx];
  if (!m || m.role !== 'assistant') return thread;

  const finalized: ChatMessage = {
    ...m,
    streaming: false,
    timeline: finalizeTimeline(m.timeline ?? []),
    workMs: m.workMs ?? Math.max(0, Date.parse(at) - Date.parse(m.createdAt)),
  };
  return { ...thread, messages: thread.messages.map((x, i) => (i === idx ? finalized : x)) };
}

const TERMINAL_OUTPUT_CAP = 60_000;
function capOutput(s: string): string {
  return s.length > TERMINAL_OUTPUT_CAP ? s.slice(s.length - TERMINAL_OUTPUT_CAP) : s;
}

function updateTerminalBlock(
  thread: Thread,
  callId: string,
  updater: (b: TerminalBlock) => TerminalBlock,
): Thread {
  const hit = (m: ChatMessage) =>
    (m.timeline ?? []).some((it) => it.kind === 'terminal' && it.block.callId === callId);
  return {
    ...thread,
    messages: thread.messages.map((m) =>
      hit(m)
        ? {
            ...m,
            timeline: (m.timeline ?? []).map((it) =>
              it.kind === 'terminal' && it.block.callId === callId
                ? { ...it, block: updater(it.block) }
                : it,
            ),
          }
        : m,
    ),
  };
}

// ── Timeline builders ───────────────────────────────────────────────────────

let tlSeq = 0;
function tlId(prefix: string): string {
  tlSeq += 1;
  return `${prefix}-${tlSeq}`;
}

/** Stop any actively-shimmering thought (it's now historical). */
function commitThoughts(tl: TimelineItem[]): TimelineItem[] {
  return tl.map((it) => (it.kind === 'thought' && it.shimmer ? { ...it, shimmer: false } : it));
}

/**
 * Run is over: stop EVERY shimmer and resolve dangling states so nothing keeps
 * spinning — thoughts commit, still-"running" tool rows settle (errors kept as
 * errors, otherwise marked done), awaiting terminals are dismissed.
 */
function finalizeTimeline(tl: TimelineItem[]): TimelineItem[] {
  return tl.map((it) => {
    if (it.kind === 'thought') return it.shimmer ? { ...it, shimmer: false } : it;
    if (it.kind === 'tool') {
      if (!it.shimmer && it.status !== 'running') return it;
      return { ...it, shimmer: false, status: it.status === 'error' ? 'error' : 'done' };
    }
    if (it.kind === 'terminal' && it.block.status === 'awaiting') {
      return { ...it, block: { ...it.block, status: 'declined' } };
    }
    return it;
  });
}

/** Update/extend the active thought, or push a new shimmering one. */
function pushThought(tl: TimelineItem[], text: string): TimelineItem[] {
  const last = tl[tl.length - 1];
  if (last && last.kind === 'thought' && last.shimmer) {
    return tl.map((it, i) => (i === tl.length - 1 ? { ...(it as Extract<TimelineItem, { kind: 'thought' }>), text } : it));
  }
  return [...commitThoughts(tl), { kind: 'thought', id: tlId('th'), text, shimmer: true }];
}

/** Extend the open text segment, or open a new one (closing prior shimmer). */
function appendText(tl: TimelineItem[], delta: string): TimelineItem[] {
  const last = tl[tl.length - 1];
  if (last && last.kind === 'text') {
    return tl.map((it, i) => (i === tl.length - 1 ? { ...(it as Extract<TimelineItem, { kind: 'text' }>), text: (it as Extract<TimelineItem, { kind: 'text' }>).text + delta } : it));
  }
  return [...commitThoughts(tl), { kind: 'text', id: tlId('tx'), text: delta }];
}

/** Resolve the real tool behind a (possibly call_tool-wrapped) tool event. */
function resolveToolId(toolName: string, args?: Record<string, unknown>): string {
  if (toolName === 'call_tool' && args && typeof args.toolId === 'string') return args.toolId;
  return toolName;
}

function attachApproval(thread: Thread, approval: ApprovalRequest): Thread {
  const last = thread.messages[thread.messages.length - 1];
  if (!last || last.role !== 'assistant') return thread;
  return {
    ...thread,
    messages: thread.messages.map((m, i) =>
      i === thread.messages.length - 1 ? { ...m, approval } : m,
    ),
  };
}

function resolveApproval(
  thread: Thread,
  id: string,
  decision: 'approved' | 'rejected',
  resolvedBy: string,
): Thread {
  return {
    ...thread,
    messages: thread.messages.map((m) =>
      m.approval?.id === id
        ? { ...m, approval: { ...m.approval, status: decision, resolvedBy } }
        : m,
    ),
  };
}
