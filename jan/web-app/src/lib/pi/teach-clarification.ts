import type { PiRawEvent } from './types'

export const PI_TEACH_CLARIFICATION_REQUEST_TITLE =
  'divo_teach_clarification_v1'
export const PI_TEACH_CLARIFICATION_MAX_QUESTIONS = 3
export const PI_TEACH_CLARIFICATION_MAX_OPTIONS = 5
export const PI_TEACH_CLARIFICATION_MAX_CUSTOM_LENGTH = 1_000

type SelectionMode = 'single' | 'multiple'

export type PiTeachClarificationOption = {
  id: string
  label: string
  description?: string
}

export type PiTeachClarificationQuestion = {
  id: string
  question: string
  whyItMatters?: string
  selection: SelectionMode
  options: PiTeachClarificationOption[]
  allowCustom: boolean
}

export type PiTeachClarificationDescriptor = {
  version: 1
  reason: string
  questions: PiTeachClarificationQuestion[]
  runCorrelation: {
    version: 1
    threadId: string
    runId: string
    profile?: 'teach'
    teachSessionId?: string
    departmentId?: string
  }
}

export type PiTeachClarificationAnswer = {
  questionId: string
  selectedOptionIds: string[]
  customText?: string
}

export type PiTeachClarificationResponse = {
  version: 1
  decision: 'answer' | 'cancel'
  answers: PiTeachClarificationAnswer[]
}

export type PiTeachClarificationRequest = {
  protocol: 'teach-clarification'
  requestId: string
  threadId: string
  runId: string
  descriptor: PiTeachClarificationDescriptor
  status: 'pending' | 'submitting' | 'error'
  error?: string
}

export type PiTeachClarificationParseResult =
  | { kind: 'not-teach-clarification' }
  | {
      kind: 'invalid'
      requestId?: string
      threadId?: string
      runId?: string
      reason: string
    }
  | { kind: 'teach-clarification'; request: PiTeachClarificationRequest }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedString(value: unknown, field: string, max: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  const result = value.trim()
  if (result.length > max) throw new Error(`${field} is too long`)
  return result
}

function parseDescriptor(prefill: string): PiTeachClarificationDescriptor {
  if (prefill.length > 24_000) {
    throw new Error('Teach clarification request is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(prefill)
  } catch {
    throw new Error('Teach clarification request is not valid JSON')
  }
  const descriptor = record(parsed)
  if (!descriptor || descriptor.version !== 1) {
    throw new Error('unsupported Teach clarification protocol version')
  }
  const correlation = record(descriptor.runCorrelation)
  if (!correlation || correlation.version !== 1) {
    throw new Error('Teach clarification is missing run correlation')
  }
  const runCorrelation: PiTeachClarificationDescriptor['runCorrelation'] = {
    version: 1,
    threadId: boundedString(
      correlation.threadId,
      'runCorrelation.threadId',
      200
    ),
    runId: boundedString(correlation.runId, 'runCorrelation.runId', 200),
    ...(correlation.profile === 'teach' ? { profile: 'teach' as const } : {}),
    ...(typeof correlation.teachSessionId === 'string'
      ? {
          teachSessionId: boundedString(
            correlation.teachSessionId,
            'runCorrelation.teachSessionId',
            200
          ),
        }
      : {}),
    ...(typeof correlation.departmentId === 'string'
      ? {
          departmentId: boundedString(
            correlation.departmentId,
            'runCorrelation.departmentId',
            200
          ),
        }
      : {}),
  }
  if (runCorrelation.profile !== 'teach') {
    throw new Error('clarification request is not owned by a Teach run')
  }
  if (
    !Array.isArray(descriptor.questions) ||
    descriptor.questions.length < 1 ||
    descriptor.questions.length > PI_TEACH_CLARIFICATION_MAX_QUESTIONS
  ) {
    throw new Error('Teach clarification must contain one to three questions')
  }
  const questionIds = new Set<string>()
  const questions = descriptor.questions.map((value, questionIndex) => {
    const question = record(value)
    if (!question) throw new Error(`questions[${questionIndex}] must be an object`)
    const id = boundedString(question.id, `questions[${questionIndex}].id`, 120)
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id)) {
      throw new Error(`questions[${questionIndex}].id must be a stable lowercase key`)
    }
    if (questionIds.has(id)) throw new Error('Teach question ids must be unique')
    questionIds.add(id)
    if (question.selection !== 'single' && question.selection !== 'multiple') {
      throw new Error(`questions[${questionIndex}].selection is invalid`)
    }
    if (
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > PI_TEACH_CLARIFICATION_MAX_OPTIONS
    ) {
      throw new Error(`questions[${questionIndex}] must contain two to five options`)
    }
    const optionIds = new Set<string>()
    const options = question.options.map((optionValue, optionIndex) => {
      const option = record(optionValue)
      if (!option) throw new Error(`questions[${questionIndex}].options[${optionIndex}] must be an object`)
      const optionId = boundedString(
        option.id,
        `questions[${questionIndex}].options[${optionIndex}].id`,
        120
      )
      if (optionIds.has(optionId)) throw new Error('Teach option ids must be unique')
      optionIds.add(optionId)
      return {
        id: optionId,
        label: boundedString(
          option.label,
          `questions[${questionIndex}].options[${optionIndex}].label`,
          240
        ),
        ...(typeof option.description === 'string' && option.description.trim()
          ? {
              description: boundedString(
                option.description,
                `questions[${questionIndex}].options[${optionIndex}].description`,
                500
              ),
            }
          : {}),
      }
    })
    return {
      id,
      question: boundedString(
        question.question,
        `questions[${questionIndex}].question`,
        500
      ),
      ...(typeof question.whyItMatters === 'string' &&
      question.whyItMatters.trim()
        ? {
            whyItMatters: boundedString(
              question.whyItMatters,
              `questions[${questionIndex}].whyItMatters`,
              500
            ),
          }
        : {}),
      selection: question.selection as SelectionMode,
      options,
      allowCustom: question.allowCustom !== false,
    }
  })
  return {
    version: 1,
    reason: boundedString(descriptor.reason, 'reason', 1_000),
    questions,
    runCorrelation,
  }
}

export function parsePiTeachClarificationEvent(
  event: PiRawEvent
): PiTeachClarificationParseResult {
  if (
    event.type !== 'extension_ui_request' ||
    event.method !== 'editor' ||
    event.title !== PI_TEACH_CLARIFICATION_REQUEST_TITLE
  ) {
    return { kind: 'not-teach-clarification' }
  }
  const requestId =
    typeof event.id === 'string' && event.id.trim() ? event.id.trim() : undefined
  const threadId =
    typeof event.thread_id === 'string' && event.thread_id.trim()
      ? event.thread_id.trim()
      : undefined
  const runId =
    typeof event.run_id === 'string' && event.run_id.trim()
      ? event.run_id.trim()
      : undefined
  if (!requestId || !threadId || !runId) {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: 'Teach clarification is missing its request, thread, or run identifier',
    }
  }
  if (typeof event.prefill !== 'string') {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: 'Teach clarification is missing its structured request',
    }
  }
  try {
    const descriptor = parseDescriptor(event.prefill)
    if (
      descriptor.runCorrelation.threadId !== threadId ||
      descriptor.runCorrelation.runId !== runId
    ) {
      throw new Error('Teach clarification run correlation does not match its event owner')
    }
    return {
      kind: 'teach-clarification',
      request: {
        protocol: 'teach-clarification',
        requestId,
        threadId,
        runId,
        descriptor,
        status: 'pending',
      },
    }
  } catch (error) {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function validatePiTeachClarificationResponse(
  request: PiTeachClarificationRequest,
  response: PiTeachClarificationResponse
): PiTeachClarificationResponse {
  if (response.version !== 1) throw new Error('unsupported Teach clarification response')
  if (response.decision === 'cancel') {
    return { version: 1, decision: 'cancel', answers: [] }
  }
  if (response.decision !== 'answer' || !Array.isArray(response.answers)) {
    throw new Error('Teach clarification response is invalid')
  }
  const answerMap = new Map(response.answers.map((answer) => [answer.questionId, answer]))
  const answers = request.descriptor.questions.map((question) => {
    const answer = answerMap.get(question.id)
    if (!answer) throw new Error(`Teach clarification answer is missing for ${question.id}`)
    const validIds = new Set(question.options.map((option) => option.id))
    if (
      !Array.isArray(answer.selectedOptionIds) ||
      new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length ||
      answer.selectedOptionIds.some((id) => !validIds.has(id))
    ) {
      throw new Error(`Teach clarification answer contains an invalid option for ${question.id}`)
    }
    if (question.selection === 'single' && answer.selectedOptionIds.length > 1) {
      throw new Error(`${question.id} accepts only one option`)
    }
    const customText = answer.customText?.trim()
    if (customText && (!question.allowCustom || customText.length > PI_TEACH_CLARIFICATION_MAX_CUSTOM_LENGTH)) {
      throw new Error(`${question.id} contains an invalid custom answer`)
    }
    if (answer.selectedOptionIds.length === 0 && !customText) {
      throw new Error(`Teach clarification answer is empty for ${question.id}`)
    }
    return {
      questionId: question.id,
      selectedOptionIds: answer.selectedOptionIds,
      ...(customText ? { customText } : {}),
    }
  })
  if (answerMap.size !== answers.length) {
    throw new Error('Teach clarification response contains an unknown question')
  }
  return { version: 1, decision: 'answer', answers }
}

export function isPiTeachClarificationRequest(
  request: unknown
): request is PiTeachClarificationRequest {
  return record(request)?.protocol === 'teach-clarification'
}
