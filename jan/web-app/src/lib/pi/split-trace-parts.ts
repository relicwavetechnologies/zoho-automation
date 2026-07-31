/**
 * Splits assistant message parts into a Pi-style trace timeline vs final answer.
 *
 * Rule: the last non-empty `text` part with no reasoning/tool parts after it is
 * the final answer; everything else (reasoning, tools, earlier text) is trace.
 */

export type PiTraceStep =
  | {
      kind: 'thought'
      partIndex: number
      text: string
      state?: string
    }
  | {
      kind: 'narration'
      partIndex: number
      text: string
    }
  | {
      kind: 'tool'
      partIndex: number
      part: Record<string, unknown>
    }

export type SplitPiMessageParts = {
  traceSteps: PiTraceStep[]
  answerPartIndices: number[]
}

type MessagePart = {
  type: string
  text?: string
  state?: string
}

function isCotPartType(type: string): boolean {
  return type === 'reasoning' || type.startsWith('tool-')
}

function isNonEmptyText(part: MessagePart): boolean {
  return part.type === 'text' && Boolean(part.text?.trim())
}

/**
 * Index of the deliverable answer text — last text block not followed by
 * reasoning or tool parts.
 */
export function findFinalAnswerTextIndex(parts: MessagePart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isNonEmptyText(parts[i])) continue
    const hasWorkAfter = parts
      .slice(i + 1)
      .some((p) => isCotPartType(p.type))
    if (!hasWorkAfter) return i
  }
  return -1
}

export function splitPiMessageParts(
  parts: readonly unknown[]
): SplitPiMessageParts {
  const typed = parts as MessagePart[]
  const finalTextIndex = findFinalAnswerTextIndex(typed)
  const traceSteps: PiTraceStep[] = []
  const answerPartIndices: number[] = []

  for (let i = 0; i < typed.length; i++) {
    const part = typed[i]

    if (i === finalTextIndex) {
      answerPartIndices.push(i)
      continue
    }

    if (part.type === 'file') {
      const hasTraceContent = typed.some(
        (p) => p.type === 'reasoning' || p.type.startsWith('tool-')
      )
      if (!hasTraceContent) {
        answerPartIndices.push(i)
      }
      continue
    }

    if (part.type === 'reasoning') {
      if (part.text?.trim() || part.state === 'streaming') {
        traceSteps.push({
          kind: 'thought',
          partIndex: i,
          text: part.text ?? '',
          state: part.state,
        })
      }
      continue
    }

    if (isNonEmptyText(part)) {
      traceSteps.push({
        kind: 'narration',
        partIndex: i,
        text: part.text!,
      })
      continue
    }

    if (part.type.startsWith('tool-') && 'state' in part) {
      traceSteps.push({
        kind: 'tool',
        partIndex: i,
        part: part as Record<string, unknown>,
      })
    }
  }

  // Plain text-only messages (no trace activity): render text as the answer.
  if (
    finalTextIndex < 0 &&
    traceSteps.length === 0 &&
    answerPartIndices.length === 0
  ) {
    for (let i = 0; i < typed.length; i++) {
      const part = typed[i]
      if (part.type === 'text' && part.text?.trim()) {
        answerPartIndices.push(i)
      } else if (part.type === 'file') {
        answerPartIndices.push(i)
      }
    }
  }

  return { traceSteps, answerPartIndices }
}
