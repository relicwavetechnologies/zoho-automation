import { describe, expect, it } from 'vitest'

import type { PiRawEvent } from '../types'
import {
  parsePiTeachClarificationEvent,
  validatePiTeachClarificationResponse,
} from '../teach-clarification'

const descriptor = () => ({
  version: 1,
  reason: 'The trigger is unclear.',
  questions: [
    {
      id: 'trigger',
      question: 'When should Divo run this?',
      selection: 'single',
      options: [
        { id: 'new-email', label: 'When a new email arrives' },
        { id: 'manual', label: 'Only when I ask' },
      ],
      allowCustom: true,
    },
  ],
  runCorrelation: {
    version: 1,
    threadId: 'thread-1',
    runId: 'run-1',
    profile: 'teach',
    teachSessionId: 'teach-1',
    departmentId: 'department-1',
  },
})

const event = (prefill: unknown): PiRawEvent =>
  ({
    type: 'extension_ui_request',
    method: 'editor',
    title: 'divo_teach_clarification_v1',
    id: 'request-1',
    thread_id: 'thread-1',
    run_id: 'run-1',
    prefill: JSON.stringify(prefill),
  }) as PiRawEvent

describe('Teach clarification protocol', () => {
  it('accepts a bounded correlated Teach request', () => {
    const parsed = parsePiTeachClarificationEvent(event(descriptor()))
    expect(parsed.kind).toBe('teach-clarification')
    if (parsed.kind !== 'teach-clarification') return
    expect(parsed.request.descriptor.questions[0].allowCustom).toBe(true)
    expect(
      validatePiTeachClarificationResponse(parsed.request, {
        version: 1,
        decision: 'answer',
        answers: [
          { questionId: 'trigger', selectedOptionIds: ['new-email'] },
        ],
      })
    ).toMatchObject({ decision: 'answer' })
  })

  it('rejects requests outside Teach and unknown answers', () => {
    expect(
      parsePiTeachClarificationEvent(
        event({
          ...descriptor(),
          runCorrelation: {
            ...descriptor().runCorrelation,
            profile: undefined,
          },
        })
      )
    ).toMatchObject({ kind: 'invalid' })

    const parsed = parsePiTeachClarificationEvent(event(descriptor()))
    if (parsed.kind !== 'teach-clarification') throw new Error('expected request')
    expect(() =>
      validatePiTeachClarificationResponse(parsed.request, {
        version: 1,
        decision: 'answer',
        answers: [
          { questionId: 'trigger', selectedOptionIds: ['invented'] },
        ],
      })
    ).toThrow(/invalid option/i)
  })
})
