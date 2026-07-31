import { describe, expect, it } from 'vitest'
import {
  findFinalAnswerTextIndex,
  splitPiMessageParts,
} from '../split-trace-parts'

describe('splitPiMessageParts', () => {
  it('keeps interim text in trace and final text as answer', () => {
    const parts = [
      { type: 'reasoning', text: 'plan the research' },
      { type: 'tool-bash', state: 'output-available', toolCallId: '1' },
      { type: 'reasoning', text: 'gather more data' },
      { type: 'text', text: 'still fetching articles...' },
      { type: 'tool-bash', state: 'output-available', toolCallId: '2' },
      { type: 'reasoning', text: 'compile summary' },
      { type: 'text', text: '# Final Report\n\nTable here' },
    ]

    expect(findFinalAnswerTextIndex(parts)).toBe(6)

    const { traceSteps, answerPartIndices } = splitPiMessageParts(parts)
    expect(answerPartIndices).toEqual([6])
    expect(traceSteps.map((s) => s.kind)).toEqual([
      'thought',
      'tool',
      'thought',
      'narration',
      'tool',
      'thought',
    ])
    expect(traceSteps[3]).toMatchObject({
      kind: 'narration',
      text: 'still fetching articles...',
    })
  })

  it('treats lone text after reasoning as final answer', () => {
    const parts = [
      { type: 'reasoning', text: 'brief thought' },
      { type: 'text', text: 'Yeah, brutally awkward...' },
    ]

    const { traceSteps, answerPartIndices } = splitPiMessageParts(parts)
    expect(traceSteps).toHaveLength(1)
    expect(traceSteps[0]).toMatchObject({ kind: 'thought' })
    expect(answerPartIndices).toEqual([1])
  })

  it('keeps interim text in trace while agent is still working', () => {
    const parts = [
      { type: 'reasoning', text: 'try navigate' },
      { type: 'text', text: 'Let me try navigating directly to do the search.' },
      { type: 'tool-browser_navigate', state: 'output-error', toolCallId: '1' },
      { type: 'reasoning', text: 'that failed, trying bash', state: 'streaming' },
    ]

    expect(findFinalAnswerTextIndex(parts)).toBe(-1)

    const { traceSteps, answerPartIndices } = splitPiMessageParts(parts)
    expect(answerPartIndices).toEqual([])
    expect(traceSteps.map((s) => s.kind)).toEqual([
      'thought',
      'narration',
      'tool',
      'thought',
    ])
  })

  it('puts text-only messages entirely in the answer', () => {
    const parts = [{ type: 'text', text: 'hello' }]
    const { traceSteps, answerPartIndices } = splitPiMessageParts(parts)
    expect(traceSteps).toHaveLength(0)
    expect(answerPartIndices).toEqual([0])
  })
})
