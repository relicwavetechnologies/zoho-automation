import type { PiTeachProfile } from '@/lib/pi-stream'
import type { TeachSession } from '@/lib/divo-teach'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { DIVO_THREAD_MODEL } from '@/lib/pi'
import { ulid } from 'ulidx'

export const DIVO_TEACH_PROFILE_METADATA_KEY = 'divoTeachProfile' as const
export const DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY =
  'divoTeachPendingMessage' as const

export type DivoTeachPendingMessage = {
  teachSessionId: string
  text: string
  createdAt: string
}

export const DIVO_TEACH_INITIAL_MESSAGE =
  'I finished recording this workflow. Analyze the teaching evidence, ask me any important clarifying questions, and help Divo learn it.'

const conversationPromises = new Map<string, Promise<Thread>>()

/**
 * Title for a Teach thread with its `Teach:` prefix removed.
 *
 * Teach threads are titled `Teach: <workflow>` at creation, and the sidebar
 * also renders a Teach badge — so the prefix said the same thing twice while
 * eating the width the actual workflow name needed. Stripped at display rather
 * than at creation so threads already in the history read correctly too.
 */
export function teachThreadDisplayTitle(title: string): string {
  const stripped = title.replace(/^\s*teach\s*[:\-–—]\s*/i, '').trim()
  // A title that is *only* the prefix has nothing better to show.
  return stripped || title
}

export function readDivoTeachProfile(
  metadata: Thread['metadata'] | undefined
): PiTeachProfile | undefined {
  const value = metadata?.[DIVO_TEACH_PROFILE_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const profile = value as Record<string, unknown>
  if (
    profile.kind !== 'teach' ||
    typeof profile.teachSessionId !== 'string' ||
    profile.teachSessionId.length === 0 ||
    typeof profile.departmentId !== 'string' ||
    profile.departmentId.length === 0
  ) {
    return undefined
  }

  return {
    kind: 'teach',
    teachSessionId: profile.teachSessionId,
    departmentId: profile.departmentId,
  }
}

export function readDivoTeachPendingMessage(
  metadata: Thread['metadata'] | undefined
): DivoTeachPendingMessage | undefined {
  const value = metadata?.[DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const pending = value as Record<string, unknown>
  if (
    typeof pending.teachSessionId !== 'string' ||
    typeof pending.text !== 'string' ||
    typeof pending.createdAt !== 'string'
  ) {
    return undefined
  }
  return pending as DivoTeachPendingMessage
}

function replaceThreadInMemory(thread: Thread) {
  const current = Object.values(useThreads.getState().threads)
  useThreads.getState().setThreads([
    thread,
    ...current.filter((candidate) => candidate.id !== thread.id),
  ])
}

async function findPersistedTeachThread(
  teachSessionId: string
): Promise<Thread | undefined> {
  const inMemory = Object.values(useThreads.getState().threads).find(
    (thread) =>
      readDivoTeachProfile(thread.metadata)?.teachSessionId === teachSessionId
  )
  if (inMemory) return inMemory

  const persisted = await getServiceHub().threads().fetchThreads()
  const found = persisted.find(
    (thread) =>
      readDivoTeachProfile(thread.metadata)?.teachSessionId === teachSessionId
  )
  if (found) replaceThreadInMemory(found)
  return found
}

/**
 * Create the normal chat that owns interactive Teach reasoning.
 *
 * The pending first turn is stored in the thread metadata rather than only in
 * sessionStorage, so a route change or webview refresh cannot lose the handoff.
 * Backend evidence processing may finish anywhere in the app; opening this
 * thread later starts the clarification/write conversation in the normal UI.
 */
export function ensureDivoTeachConversation(session: TeachSession): Promise<Thread> {
  const active = conversationPromises.get(session.id)
  if (active) return active

  const operation = (async () => {
    const existing = await findPersistedTeachThread(session.id)
    if (existing) {
      if (
        session.status === 'evidence_ready' &&
        !readDivoTeachPendingMessage(existing.metadata)
      ) {
        const messages = await getServiceHub().messages().fetchMessages(existing.id)
        if (messages.length === 0) {
          const updated = {
            ...existing,
            metadata: {
              ...(existing.metadata ?? {}),
              [DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY]: {
                teachSessionId: session.id,
                text: DIVO_TEACH_INITIAL_MESSAGE,
                createdAt: new Date().toISOString(),
              },
            },
          } as Thread
          await getServiceHub().threads().updateThread(updated)
          replaceThreadInMemory(updated)
          return updated
        }
      }
      return existing
    }

    const title = session.originalFileName
      ? `Teach: ${session.originalFileName.replace(/\.[^.]+$/, '')}`
      : 'Teach Divo my workflow'
    const pendingMetadata =
      session.status === 'evidence_ready' || session.status === 'agent_processing'
        ? {
            [DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY]: {
              teachSessionId: session.id,
              text: DIVO_TEACH_INITIAL_MESSAGE,
              createdAt: new Date().toISOString(),
            },
          }
        : {}
    const draft = {
      id: ulid(),
      title,
      model: { ...DIVO_THREAD_MODEL },
      updated: Date.now() / 1000,
      assistants: [],
      metadata: {
        [DIVO_TEACH_PROFILE_METADATA_KEY]: {
          kind: 'teach',
          teachSessionId: session.id,
          departmentId: session.departmentId,
        },
        ...pendingMetadata,
      },
    } as Thread
    const created = await getServiceHub().threads().createThread(draft)
    replaceThreadInMemory(created)
    return created
  })().finally(() => {
    conversationPromises.delete(session.id)
  })

  conversationPromises.set(session.id, operation)
  return operation
}

export async function clearDivoTeachPendingMessage(threadId: string) {
  const thread = useThreads.getState().threads[threadId]
  if (!thread || !readDivoTeachPendingMessage(thread.metadata)) return
  const metadata = { ...(thread.metadata ?? {}) }
  delete metadata[DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY]
  const updated = { ...thread, metadata } as Thread
  await getServiceHub().threads().updateThread(updated)
  replaceThreadInMemory(updated)
}
