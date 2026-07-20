import { generateText } from 'ai'
import { invoke } from '@tauri-apps/api/core'
import { ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { PI_PROVIDER_ID } from './pi/constants'

const MAX_TITLE_WORDS = 10
const MAX_PROMPT_LENGTH = 1500

function buildSummarizePrompt(transcript: string): string {
  const truncated =
    transcript.length > MAX_PROMPT_LENGTH
      ? transcript.slice(0, MAX_PROMPT_LENGTH) + '...'
      : transcript
  return `Summarize the following conversation into a concise title of at most ${MAX_TITLE_WORDS} words. Capture the overall topic, not just the latest turn. Output the title only, no quotes, no explanation.\n\nConversation:\n${truncated}`
}

/**
 * Clean a model-generated title: strip reasoning tags, special characters,
 * quotes, and enforce a word limit. Returns null if the result is unusable.
 */
export function cleanTitle(raw: string): string | null {
  let text = raw.trim()

  // Strip complete reasoning blocks like <think>...</think> (any tag name)
  text = text.replace(/<(think|thinking|reasoning|analysis)[^>]*>[\s\S]*?<\/\1>/gi, '').trim()

  // If a reasoning opener remains without a close, the output is all reasoning — unusable
  if (/<(think|thinking|reasoning|analysis)[^>]*>/i.test(text)) return null

  // If only a closing tag is present, take what's after the last one
  const lastClose = text.match(/<\/(?:think|thinking|reasoning|analysis)>\s*([\s\S]*)$/i)
  if (lastClose) {
    text = lastClose[1].trim()
  }

  // Remove leftover XML-like tags
  text = text.replace(/<[^>]+>/g, '').trim()

  // Collapse whitespace and newlines into single spaces
  text = text.replace(/\s+/g, ' ').trim()

  // Remove surrounding quotes
  text = text.replace(/^["']+|["']+$/g, '').trim()

  // Keep only letters, numbers, and spaces (unicode-aware)
  text = text.replace(/[^\p{L}\p{N}\s]/gu, '').trim()

  // Enforce word limit
  const words = text.split(/\s+/).slice(0, MAX_TITLE_WORDS)
  text = words.join(' ')

  if (!text || text.length < 2) return null

  return text
}

/**
 * Generate a summarized thread title from the conversation so far.
 *
 * Divo/Pi cannot use Jan's provider factory: its model credentials and policy
 * live exclusively behind the backend proxy. A Divo thread is identified by
 * its thread id, so title generation must never depend on the persisted Jan
 * provider picker (which can be stale while the fixed Pi runtime is active).
 * Calls without a thread id preserve the legacy local-provider behavior.
 * Returns null on failure or if the signal is aborted.
 */
export async function generateThreadTitle(
  transcript: string,
  abortSignal: AbortSignal,
  threadId?: string
): Promise<string | null> {
  try {
    if (abortSignal.aborted) return null

    if (threadId) {
      const rawTitle = await invoke<string>('divo_generate_thread_title', {
        threadId,
        thread_id: threadId,
        transcript,
      })
      const cleanedTitle = cleanTitle(rawTitle)
      if (!cleanedTitle) {
        console.warn('[ThreadTitle] Divo title response was unusable', {
          responseLength: rawTitle.length,
        })
      }
      return abortSignal.aborted ? null : cleanedTitle
    }

    const { selectedModel, selectedProvider, getProviderByName } =
      useModelProvider.getState()
    if (!selectedModel || !selectedProvider) {
      console.warn('[ThreadTitle] No model/provider selected')
      return null
    }

    if (selectedProvider === PI_PROVIDER_ID) {
      console.warn('[ThreadTitle] Missing thread id for Divo title generation')
      return null
    }

    // MLX models often emit reasoning that can't be reliably suppressed; fall back to default title.
    if (selectedProvider === 'mlx') return null

    const provider = getProviderByName(selectedProvider)
    if (!provider) {
      console.warn('[ThreadTitle] Provider not found:', selectedProvider)
      return null
    }

    console.log('[ThreadTitle] Creating model:', selectedModel.id, 'provider:', selectedProvider)
    const params: Record<string, unknown> =
      selectedProvider === 'llamacpp'
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}
    const model = await ModelFactory.createModel(
      selectedModel.id,
      provider,
      params
    )

    console.log('[ThreadTitle] Calling generateText...')
    const { text } = await generateText({
      model,
      messages: [{ role: 'user', content: buildSummarizePrompt(transcript) }],
      maxOutputTokens: 128,
      abortSignal,
    })

    console.log('[ThreadTitle] Raw response:', JSON.stringify(text))
    const cleaned = cleanTitle(text)
    console.log('[ThreadTitle] Cleaned title:', cleaned)
    return cleaned
  } catch (error) {
    // Silently swallow abort errors — this is expected when the user sends a new message
    if ((error as Error).name === 'AbortError') return null
    console.error('[ThreadTitle] Failed to generate title:', error)
    return null
  }
}
