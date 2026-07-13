import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UIMessageChunk } from 'ai'
import { consumePiApprovalEvent, usePiApproval } from '@/hooks/usePiApproval'
import { DIVO_MODEL_PROVIDER, useDivoModel } from '@/hooks/useDivoModel'
import {
  PI_TRACE_TIMELINE_METADATA_KEY,
  closePiUiMessageBlocks,
  createPiStreamState,
  mapPiEventToUiChunks,
  type PiRawEvent,
} from './pi'

export type { PiRawEvent } from './pi'

// Approval dialogs must outlive the stream that happened to create them. A
// tool can wait on an editor after the stream is replaced or otherwise marked
// stale; tying this listener to that stream leaves Pi blocked without a card.
let approvalEventListener: Promise<void> | undefined

async function ensureApprovalEventListener(): Promise<void> {
  if (approvalEventListener) return approvalEventListener

  approvalEventListener = listen<PiRawEvent>('pi-event', (event) => {
    void consumePiApprovalEvent(event.payload).catch((error) => {
      console.error('[Pi approval] Failed to consume UI request', error)
    })
  })
    .then(() => undefined)
    .catch((error) => {
      approvalEventListener = undefined
      throw error
    })

  return approvalEventListener
}

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
  onTerminal?: (runId: string) => void
  /** Owner-tagged runtime admission transitions, for thread-level state. */
  onRunStateChange?: (
    runId: string,
    state: 'capacity_waiting' | 'active'
  ) => void
  /** Called for every raw pi-event (including those without UI mapping). */
  onPiEvent?: (event: PiRawEvent) => void
}): ReadableStream<UIMessageChunk> {
  const {
    threadId,
    message,
    abortSignal,
    isStale,
    onTerminal,
    onRunStateChange,
    onPiEvent,
  } = options
  const messageId = crypto.randomUUID()
  // Rust treats this caller-generated id as part of the active-run owner.
  // Keep one identity for this whole stream, including every cancellation path.
  const runId = crypto.randomUUID()

  let unlisten: UnlistenFn | undefined
  let finished = false
  let abortReconciliation: Promise<void> | undefined
  let abortInProgress = false
  let locallyCancelled = false
  let deferredFinishReason: 'stop' | 'error' | undefined
  let reconcileAbort: (() => Promise<void>) | undefined
  let finishCancelledStream: (() => void) | undefined

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      controller.enqueue({
        type: 'start',
        messageId,
        messageMetadata: { [PI_TRACE_TIMELINE_METADATA_KEY]: true },
      })

      const state = createPiStreamState()

      const denyThenAbort = async () => {
        await usePiApproval.getState().denyThread(threadId, runId)
        try {
          await invoke('pi_abort', { threadId, thread_id: threadId, runId, run_id: runId })
          usePiApproval.getState().discardThreadAfterAbort(threadId, runId)
        } catch {
          // If abort itself fails, retain any failed denial in the UI. This is
          // the only state where we cannot prove the Pi request was cancelled.
        }
      }

      function finishCurrentStream(reason: 'stop' | 'error' = 'stop') {
        if (finished) return
        if (abortInProgress) {
          // Rust still owns this run. A matching agent_end received during an
          // abort must not clear the composer before scoped cancellation has
          // settled.
          if (reason === 'error' || !deferredFinishReason) {
            deferredFinishReason = reason
          }
          return
        }
        finished = true
        onTerminal?.(runId)
        try {
          if (reason === 'stop') {
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
          }
          controller.close()
        } catch {
          // ReadableStream.cancel closes its controller before this source's
          // async cancellation hook settles. Terminal state still must be
          // reconciled, even though no more UI chunks can be written.
        }
        void unlisten?.()
      }

      function reconcileCurrentAbort() {
        if (abortReconciliation) return abortReconciliation
        abortInProgress = true
        abortReconciliation = denyThenAbort().finally(() => {
          abortInProgress = false
          const reason = deferredFinishReason ?? 'stop'
          deferredFinishReason = undefined
          finishCurrentStream(reason)
        })
        return abortReconciliation
      }

      reconcileAbort = reconcileCurrentAbort
      finishCancelledStream = () => finishCurrentStream('error')

      const onAbort = () => {
        locallyCancelled = true
        // Do not turn an explicit user stop into a generic stream error. The
        // AI SDK marks this request as `isAbort` and hands its partial message
        // to onFinish, where the route persists meaningful interrupted output.
        try {
          closePiUiMessageBlocks(controller, state)
        } catch {
          // ReadableStream.cancel may already have closed the controller. The
          // terminal reconciliation below still releases the scoped Pi run.
        }
        void reconcileCurrentAbort()
        finishCurrentStream('stop')
      }

      const startupWasCancelledOrStale = () => {
        if (locallyCancelled || abortSignal?.aborted) return true
        if (!isStale()) return false

        finishCurrentStream('stop')
        return true
      }

      if (abortSignal?.aborted) {
        onAbort()
        return
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true })

      try {
        await ensureApprovalEventListener()
        if (startupWasCancelledOrStale()) return

        await ensurePiStarted(threadId)
        if (startupWasCancelledOrStale()) return

        unlisten = await listen<PiRawEvent>('pi-event', (event) => {
          if (finished || isStale()) return
          const payload = event.payload
          if (payload.thread_id !== threadId || payload.run_id !== runId) return

          if (payload.type === 'pi_runtime_waiting') {
            onRunStateChange?.(runId, 'capacity_waiting')
          } else if (payload.type === 'prompt_accepted') {
            onRunStateChange?.(runId, 'active')
          }
          onPiEvent?.(payload)
          mapPiEventToUiChunks(payload, controller, state, finishCurrentStream)
        })
        if (startupWasCancelledOrStale()) {
          void unlisten?.()
          return
        }

        // Keep this check adjacent to the prompt invocation: cancellation can
        // arrive while any of the startup boundaries above are pending.
        if (startupWasCancelledOrStale()) return
        const { selectedModel } = useDivoModel.getState()
        await invoke('pi_prompt', {
          threadId,
          thread_id: threadId,
          runId,
          run_id: runId,
          message,
          // The backend remains the authority for allowed models. Sending the
          // selected model with this owned prompt lets Rust set it on a newly
          // spawned runtime before the first request, rather than broadcasting
          // to an empty runtime pool during pi_start.
          provider: DIVO_MODEL_PROVIDER,
          modelId: selectedModel,
          model_id: selectedModel,
        })
      } catch (error) {
        if (!startupWasCancelledOrStale()) {
          controller.enqueue({
            type: 'error',
            errorText:
              error instanceof Error ? error.message : String(error),
          })
        }
        finishCurrentStream('error')
      }
    },
    async cancel() {
      locallyCancelled = true
      if (reconcileAbort) {
        await reconcileAbort()
      } else {
        // A cancellation can race asynchronous stream initialization. There is
        // no prompt to abort in that case, but the transport still needs its
        // terminal notification to release the busy marker.
        if (finishCancelledStream) finishCancelledStream()
        else onTerminal?.(runId)
      }
    },
  })
}
