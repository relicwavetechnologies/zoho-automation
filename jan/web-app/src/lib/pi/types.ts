/** Raw Pi stdout event with Jan-injected thread_id (Pi field names preserved). */
export type PiRawEvent = Record<string, unknown> & {
  thread_id: string
  type: string
}

export type PiStreamState = {
  step: number
  thinkingSeq: number
  textSeq: number
  currentReasoningId: string | null
  currentTextId: string | null
  reasoningOpen: Set<string>
  textOpen: Set<string>
  toolSeen: Set<string>
}

export function createPiStreamState(): PiStreamState {
  return {
    step: 0,
    thinkingSeq: 0,
    textSeq: 0,
    currentReasoningId: null,
    currentTextId: null,
    reasoningOpen: new Set(),
    textOpen: new Set(),
    toolSeen: new Set(),
  }
}
