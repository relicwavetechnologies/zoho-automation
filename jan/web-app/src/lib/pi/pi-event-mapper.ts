import type { UIMessageChunk } from 'ai'
import type { PiRawEvent, PiStreamState } from './types'

function contentIndexOf(event: Record<string, unknown>): number {
  const idx = event.contentIndex
  return typeof idx === 'number' && Number.isFinite(idx) ? idx : 0
}

function closeReasoning(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState,
  id: string
) {
  if (!state.reasoningOpen.has(id)) return
  controller.enqueue({ type: 'reasoning-end', id })
  state.reasoningOpen.delete(id)
  if (state.currentReasoningId === id) {
    state.currentReasoningId = null
  }
}

function closeText(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState,
  id: string
) {
  if (!state.textOpen.has(id)) return
  controller.enqueue({ type: 'text-end', id })
  state.textOpen.delete(id)
  if (state.currentTextId === id) {
    state.currentTextId = null
  }
}

function closeAllOpenBlocks(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState
) {
  for (const id of [...state.reasoningOpen]) {
    closeReasoning(controller, state, id)
  }
  for (const id of [...state.textOpen]) {
    closeText(controller, state, id)
  }
}

/**
 * Close any append-only trace blocks before a local stop closes the stream.
 *
 * AI SDK keeps the partial message it has received when its AbortSignal fires.
 * Ending the open text/reasoning parts makes that partial structurally complete
 * so it can be saved as interrupted history rather than treated as a stream
 * error or an unfinished UI placeholder.
 */
export function closePiUiMessageBlocks(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState
): void {
  closeAllOpenBlocks(controller, state)
}

function openReasoningBlock(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState
): string {
  if (state.currentReasoningId) {
    return state.currentReasoningId
  }
  state.thinkingSeq += 1
  const id = `pi-r-${state.thinkingSeq}`
  controller.enqueue({ type: 'reasoning-start', id })
  state.reasoningOpen.add(id)
  state.currentReasoningId = id
  return id
}

function openTextBlock(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState
): string {
  if (state.currentTextId) {
    return state.currentTextId
  }
  state.textSeq += 1
  const id = `pi-t-${state.textSeq}`
  controller.enqueue({ type: 'text-start', id })
  state.textOpen.add(id)
  state.currentTextId = id
  return id
}

function toolRecord(event: Record<string, unknown>) {
  const toolCall = event.toolCall
  if (!toolCall || typeof toolCall !== 'object') return null
  const rec = toolCall as Record<string, unknown>
  const id = typeof rec.id === 'string' ? rec.id : undefined
  const name = typeof rec.name === 'string' ? rec.name : undefined
  if (!id || !name) return null
  return { id, name, arguments: rec.arguments ?? {} }
}

function enqueueToolInput(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  toolCallId: string,
  toolName: string,
  input: unknown,
  state: PiStreamState
) {
  if (state.toolSeen.has(toolCallId)) return
  state.toolSeen.add(toolCallId)
  controller.enqueue({
    type: 'tool-input-start',
    toolCallId,
    toolName,
    providerExecuted: true,
  })
  controller.enqueue({
    type: 'tool-input-available',
    toolCallId,
    toolName,
    input,
    providerExecuted: true,
  })
}

function handleAssistantMessageEvent(
  ame: Record<string, unknown>,
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState
) {
  const ameType = ame.type
  const contentIndex = contentIndexOf(ame)

  switch (ameType) {
    case 'start':
      controller.enqueue({ type: 'start-step' })
      break

    case 'thinking_start': {
      if (state.currentReasoningId) {
        closeReasoning(controller, state, state.currentReasoningId)
      }
      state.thinkingSeq += 1
      const id = `pi-r-${state.thinkingSeq}`
      controller.enqueue({ type: 'reasoning-start', id })
      state.reasoningOpen.add(id)
      state.currentReasoningId = id
      void contentIndex
      break
    }

    case 'thinking_delta': {
      const id = openReasoningBlock(controller, state)
      const delta = ame.delta
      if (typeof delta === 'string' && delta.length > 0) {
        controller.enqueue({ type: 'reasoning-delta', id, delta })
      }
      break
    }

    case 'thinking_end': {
      const id =
        state.currentReasoningId ?? `pi-r-${state.thinkingSeq || contentIndex}`
      closeReasoning(controller, state, id)
      break
    }

    case 'text_start': {
      if (state.currentReasoningId) {
        closeReasoning(controller, state, state.currentReasoningId)
      }
      if (state.currentTextId) {
        closeText(controller, state, state.currentTextId)
      }
      state.textSeq += 1
      const id = `pi-t-${state.textSeq}`
      controller.enqueue({ type: 'text-start', id })
      state.textOpen.add(id)
      state.currentTextId = id
      break
    }

    case 'text_delta': {
      if (state.currentReasoningId) {
        closeReasoning(controller, state, state.currentReasoningId)
      }
      const id = openTextBlock(controller, state)
      const delta = ame.delta
      if (typeof delta === 'string' && delta.length > 0) {
        controller.enqueue({ type: 'text-delta', id, delta })
      }
      break
    }

    case 'text_end': {
      const id = state.currentTextId ?? `pi-t-${state.textSeq || contentIndex}`
      closeText(controller, state, id)
      break
    }

    case 'toolcall_start': {
      const tool = toolRecord(ame)
      if (!tool) break
      if (!state.toolSeen.has(tool.id)) {
        state.toolSeen.add(tool.id)
        controller.enqueue({
          type: 'tool-input-start',
          toolCallId: tool.id,
          toolName: tool.name,
          providerExecuted: true,
        })
      }
      break
    }

    case 'toolcall_delta': {
      const tool = toolRecord(ame)
      const delta = ame.delta
      if (tool && typeof delta === 'string' && delta.length > 0) {
        if (!state.toolSeen.has(tool.id)) {
          state.toolSeen.add(tool.id)
          controller.enqueue({
            type: 'tool-input-start',
            toolCallId: tool.id,
            toolName: tool.name,
            providerExecuted: true,
          })
        }
        controller.enqueue({
          type: 'tool-input-delta',
          toolCallId: tool.id,
          inputTextDelta: delta,
        })
      }
      break
    }

    case 'toolcall_end': {
      closeAllOpenBlocks(controller, state)
      const tool = toolRecord(ame)
      if (!tool) break
      enqueueToolInput(controller, tool.id, tool.name, tool.arguments, state)
      break
    }

    case 'done': {
      if (ame.reason === 'toolUse') {
        closeAllOpenBlocks(controller, state)
      }
      break
    }

    case 'error': {
      const err = ame.error
      let errorText = 'Divo stream error'
      if (typeof err === 'string') {
        errorText = err
      } else if (err && typeof err === 'object') {
        const msg = (err as Record<string, unknown>).message
        if (typeof msg === 'string') errorText = msg
      }
      controller.enqueue({ type: 'error', errorText })
      break
    }

    default:
      break
  }
}

/**
 * Maps a raw Pi `pi-event` payload to UIMessageChunk writes.
 * Each thinking phase and tool call becomes its own message part (append-only trace).
 */
export function mapPiEventToUiChunks(
  payload: PiRawEvent,
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: PiStreamState,
  finishStream: (reason: 'stop' | 'error') => void
): void {
  switch (payload.type) {
    case 'agent_start':
      controller.enqueue({ type: 'start-step' })
      break

    case 'turn_start':
      closeAllOpenBlocks(controller, state)
      state.step += 1
      controller.enqueue({ type: 'start-step' })
      break

    case 'turn_end':
      closeAllOpenBlocks(controller, state)
      controller.enqueue({ type: 'finish-step' })
      break

    case 'message_update': {
      const ame = payload.assistantMessageEvent
      if (ame && typeof ame === 'object') {
        handleAssistantMessageEvent(
          ame as Record<string, unknown>,
          controller,
          state
        )
      }
      break
    }

    case 'message_start':
    case 'message_end':
    case 'queue_update':
    case 'compaction_start':
    case 'compaction_end':
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'extension_ui_request':
    case 'extension_error':
    case 'prompt_accepted':
      break

    case 'tool_execution_start': {
      const toolCallId =
        typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined
      const toolName =
        typeof payload.toolName === 'string' ? payload.toolName : 'tool'
      if (toolCallId) {
        enqueueToolInput(
          controller,
          toolCallId,
          toolName,
          payload.args ?? {},
          state
        )
      }
      break
    }

    case 'tool_execution_update': {
      const toolCallId =
        typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined
      if (!toolCallId) break
      const partialResult = payload.partialResult
      if (partialResult !== undefined) {
        controller.enqueue({
          type: 'tool-output-available',
          toolCallId,
          output: partialResult,
          preliminary: true,
          providerExecuted: true,
        })
      }
      break
    }

    case 'tool_execution_end': {
      const toolCallId =
        typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined
      if (!toolCallId) break
      const isError = payload.isError === true
      if (isError) {
        const result = payload.result
        controller.enqueue({
          type: 'tool-output-error',
          toolCallId,
          errorText:
            typeof result === 'string'
              ? result
              : JSON.stringify(result ?? 'Tool failed'),
          providerExecuted: true,
        })
      } else {
        controller.enqueue({
          type: 'tool-output-available',
          toolCallId,
          output: payload.result,
          providerExecuted: true,
        })
      }
      break
    }

    case 'agent_end': {
      const willRetry = payload.willRetry === true
      if (willRetry) break
      closeAllOpenBlocks(controller, state)
      finishStream('stop')
      break
    }

    case 'prompt_rejected':
    case 'pi_process_exit': {
      const message =
        typeof payload.message === 'string'
          ? payload.message
          : 'Divo agent error'
      controller.enqueue({ type: 'error', errorText: message })
      finishStream('error')
      break
    }

    default:
      break
  }
}
