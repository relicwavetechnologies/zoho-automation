/**
 * A question Divo is waiting on, and the answer being assembled for it.
 *
 * The shapes mirror `advance-backend/src/domain/decision/decision.ts` — the two
 * trees do not share types, so this is the browser's half, kept to what a
 * renderer needs. Everything with a rule in it (what a complete answer is, what
 * one choice does to another) lives here rather than in the card, so the card is
 * a layout and this is the part worth asserting.
 *
 * The rules are stated twice on purpose, once per tree, and they are checked
 * twice for the same reason: the server cannot trust a browser's arithmetic,
 * and a browser that waits for the server to tell it a radio button replaced
 * its neighbour is a browser that feels broken.
 */

export type DecisionOption = {
  value: string
  label: string
  /** `danger` is the option that stops the work. */
  tone?: 'default' | 'primary' | 'danger'
  /** Choosing this ends the whole decision, whatever comes after it. */
  settles?: 'approved' | 'rejected'
}

export type DecisionQuestion =
  | {
      id: string
      ask: string
      pick: 'one' | 'many'
      options: DecisionOption[]
      /** May they write their own answer instead of picking one? */
      allowText?: boolean
      optional?: boolean
    }
  | { id: string; ask: string; text: { placeholder?: string }; optional?: boolean }

export type DecisionResponse = { questionId: string; chose: string[]; said?: string }
export type DecisionAnswer = { responses: DecisionResponse[] }

export type Decision = {
  id: string
  title: string
  detail?: string
  /** Who is asking — a requester's name, a department, "Divo". */
  source: string
  questions: DecisionQuestion[]
  requestedAt: string
  expiresAt: string | null
  /**
   * The web thread this was asked in, or null when it was asked elsewhere.
   *
   * The chat shows a question only when it names the thread being read. Without
   * that, every open request replaced the composer of every thread — a manager
   * with one approval from a colleague's Lark run could not type anywhere.
   */
  threadId: string | null
}

export const EMPTY: DecisionAnswer = { responses: [] }

export function responseFor(answer: DecisionAnswer, questionId: string): DecisionResponse | undefined {
  return answer.responses.find((response) => response.questionId === questionId)
}

/**
 * One more choice, replacing or joining what is already there.
 *
 * A single-choice question replaces; a multi-choice one toggles. Both are the
 * same call, because the difference belongs to the question rather than to the
 * six places a click is handled.
 *
 * Choosing anything clears typed words on the same question: somebody who picks
 * from the list has stopped writing their own, and leaving both would send an
 * answer that says two things.
 */
export function choose(
  answer: DecisionAnswer,
  question: Extract<DecisionQuestion, { pick: 'one' | 'many' }>,
  value: string,
): DecisionAnswer {
  const existing = responseFor(answer, question.id)
  const already = existing?.chose ?? []
  const chose = question.pick === 'one'
    ? (already.includes(value) ? [] : [value])
    : already.includes(value)
      ? already.filter((entry) => entry !== value)
      : [...already, value]
  return put(answer, { questionId: question.id, chose })
}

/**
 * What they typed, which stands in for a choice rather than joining one.
 *
 * Writing your own answer is a statement that the listed options did not fit,
 * so it clears them — the same rule the backend applies when it decides whether
 * an answer is complete.
 */
export function write(answer: DecisionAnswer, questionId: string, said: string): DecisionAnswer {
  return put(answer, said.trim() ? { questionId, chose: [], said } : { questionId, chose: [] })
}

function put(answer: DecisionAnswer, response: DecisionResponse): DecisionAnswer {
  const existing = responseFor(answer, response.questionId)
  return {
    responses: existing
      ? answer.responses.map((entry) => (entry.questionId === response.questionId ? response : entry))
      : [...answer.responses, response],
  }
}

/** Has anything been said about this question at all? */
export function said(answer: DecisionAnswer, questionId: string): boolean {
  const response = responseFor(answer, questionId)
  if (!response) return false
  return response.chose.length > 0 || (response.said?.trim() ?? '') !== ''
}

/**
 * Has one of the choices already ended the decision?
 *
 * A Reject on the first of three questions is an answer, not an abandoned form.
 * Without this the card would refuse to send until every page after the stop
 * had been filled in — pages the stop had just made irrelevant.
 */
export function settlesEarly(questions: DecisionQuestion[], answer: DecisionAnswer): boolean {
  return answer.responses.some((response) => {
    const question = questions.find((entry) => entry.id === response.questionId)
    if (!question || 'text' in question) return false
    return response.chose.some(
      (value) => question.options.find((option) => option.value === value)?.settles !== undefined,
    )
  })
}

/** Is there enough here to send? */
export function complete(questions: DecisionQuestion[], answer: DecisionAnswer): boolean {
  if (settlesEarly(questions, answer)) return true
  return questions.every((question) => question.optional || said(answer, question.id))
}

/** Which question the pager is on: the first one nothing has been said about. */
export function currentIndex(questions: DecisionQuestion[], answer: DecisionAnswer): number {
  const next = questions.findIndex((question) => !said(answer, question.id))
  return next === -1 ? Math.max(0, questions.length - 1) : next
}

/**
 * Which of these decisions the thread should put in front of the reader.
 *
 * The oldest, not the newest. Two open questions are answered in the order they
 * were asked, and a card that jumped to whichever arrived last would leave the
 * first one buried under it — which is how a queue turns into a stack.
 */
export function firstOpen(decisions: readonly Decision[], threadId?: string): Decision | null {
  /* A thread shows only what it raised. Anything else — an approval from
     somebody's Lark run, a request made on another thread — is somebody
     waiting on you, not this conversation waiting on you, and it belongs on
     the Approvals page rather than in front of a text box you were using. */
  const mine = threadId === undefined
    ? decisions
    : decisions.filter((decision) => decision.threadId === threadId)
  return [...mine].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0] ?? null
}

/** "in 51 min", "Expired", or nothing when the request has no deadline. */
export function expiryLabel(expiresAt: string | null, now = Date.now()): { text: string; expired: boolean } | null {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime() - now
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return { text: 'Expired', expired: true }
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return { text: `in ${mins} min`, expired: false }
  const hours = Math.round(mins / 60)
  if (hours < 24) return { text: `in ${hours} hour${hours === 1 ? '' : 's'}`, expired: false }
  const days = Math.round(hours / 24)
  return { text: `in ${days} day${days === 1 ? '' : 's'}`, expired: false }
}

/** "9 minutes ago" from an ISO timestamp. */
export function ago(iso: string, now = Date.now()): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
