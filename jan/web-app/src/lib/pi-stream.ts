import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UIMessageChunk } from 'ai'
import { consumePiApprovalEvent, usePiApproval } from '@/hooks/usePiApproval'
import {
  PI_TRACE_TIMELINE_METADATA_KEY,
  createPiStreamState,
  mapPiEventToUiChunks,
  type PiRawEvent,
} from './pi'

export type { PiRawEvent } from './pi'

async function ensurePiStarted(threadId: string): Promise<void> {
  await invoke('pi_start', {
    workspacePath: null,
    workspace_path: null,
    threadId,
    thread_id: threadId,
  })
}

export function createPiMessageStream(options: {
  threadId: string
  message: string
  abortSignal: AbortSignal | undefined
  isStale: () => boolean
  onTerminal?: () => void
  /** Called for every raw pi-event (including those without UI mapping). */
  onPiEvent?: (event: PiRawEvent) => void
}): ReadableStream<UIMessageChunk> {
  const { threadId, message, abortSignal, isStale, onTerminal, onPiEvent } =
    options
  const messageId = crypto.randomUUID()

  let unlisten: UnlistenFn | undefined
  let finished = false

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      controller.enqueue({
        type: 'start',
        messageId,
        messageMetadata: { [PI_TRACE_TIMELINE_METADATA_KEY]: true },
      })

      const state = createPiStreamState()

      const denyThenAbort = async () => {
        await usePiApproval.getState().denyThread(threadId)
        try {
          await invoke('pi_abort')
          usePiApproval.getState().discardThreadAfterAbort(threadId)
        } catch {
          // If abort itself fails, retain any failed denial in the UI. This is
          // the only state where we cannot prove the Pi request was cancelled.
        }
      }

      const finishStream = (reason: 'stop' | 'error' = 'stop') => {
        if (finished) return
        finished = true
        void usePiApproval.getState().denyThread(threadId)
        onTerminal?.()
        if (reason === 'stop') {
          controller.enqueue({ type: 'finish', finishReason: 'stop' })
        }
        controller.close()
        void unlisten?.()
      }

      const onAbort = () => {
        void denyThenAbort()
        if (!isStale()) {
          controller.enqueue({
            type: 'error',
            errorText: 'Request aborted',
          })
        }
        finishStream('error')
      }

      if (abortSignal?.aborted) {
        onAbort()
        return
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true })

      try {
        await ensurePiStarted(threadId)

        unlisten = await listen<PiRawEvent>('pi-event', (event) => {
          if (isStale()) return
          const payload = event.payload
          if (payload.thread_id && payload.thread_id !== threadId) return

          void consumePiApprovalEvent(payload)
          onPiEvent?.(payload)
          mapPiEventToUiChunks(payload, controller, state, finishStream)
        })

        await invoke('pi_prompt', { threadId, thread_id: threadId, message })
      } catch (error) {
        if (!isStale()) {
          controller.enqueue({
            type: 'error',
            errorText:
              error instanceof Error ? error.message : String(error),
          })
        }
        finishStream('error')
      }
    },
    async cancel() {
      await usePiApproval.getState().denyThread(threadId)
      try {
        await invoke('pi_abort')
        usePiApproval.getState().discardThreadAfterAbort(threadId)
      } catch {
        // Retain a failed denial if Rust could not confirm cancellation.
      }
      void unlisten?.()
    },
  })
}
