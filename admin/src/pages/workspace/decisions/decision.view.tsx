/**
 * The decision card — one question at a time, where the composer usually is.
 *
 * Divo asking something used to end the turn and send the reader somewhere
 * else: a card in Lark, or a page called Approvals. Both are still true and
 * both are still there, but neither is where the person was standing. This is,
 * and swapping the composer for it says the thing a banner never could —
 * *nothing else is going to happen until you answer this*.
 *
 * One question at a time rather than a scrolling form. A decision is an
 * interruption, and an interruption that takes a page of reading has become a
 * second task. The pills say how many are left, so short is not a surprise.
 *
 * Every rule about what a choice does — replace or toggle, clear the typed
 * words, is there enough to send — is in `decision.ts` and asserted there. This
 * file is layout.
 */
import { useState } from 'react'
import { ArrowUp, Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  choose,
  complete,
  currentIndex,
  EMPTY,
  expiryLabel,
  responseFor,
  said,
  write,
  type Decision,
  type DecisionAnswer,
  type DecisionQuestion,
} from './decision'

export function DecisionCard({
  decision, sending, onSend, onDismiss, now,
}: {
  decision: Decision
  sending?: boolean
  /**
   * Absent when this person may not answer.
   *
   * Their own request, seen from the list of things they asked for, is the
   * case: the card still shows what was asked and when it lapses, and draws no
   * control at all rather than offering an Approve that the server would refuse.
   */
  onSend?: (answer: DecisionAnswer) => void
  /** Put it aside for now. It stays open, and stays on the Approvals page. */
  onDismiss?: () => void
  /** Injected by tests that pin a clock; the app never passes it. */
  now?: number
}) {
  const [answer, setAnswer] = useState<DecisionAnswer>(EMPTY)
  /* Where the reader is, not where the answer is: they can page back over
     something already answered, which `currentIndex` alone would skip past. */
  const [at, setAt] = useState<number | null>(null)
  const index = at ?? currentIndex(decision.questions, answer)
  const question = decision.questions[Math.min(index, decision.questions.length - 1)]
  const last = index >= decision.questions.length - 1
  const ready = complete(decision.questions, answer)
  const expiry = expiryLabel(decision.expiresAt, now)

  if (!question) return null

  /* A single choice moves the reader on by itself. Asking somebody to pick an
     option and then press a second button to confirm the pick is one press too
     many on the shape most of these questions have — one question, two options. */
  const pick = (value: string): void => {
    if ('text' in question || !onSend) return
    const next = choose(answer, question, value)
    setAnswer(next)
    if (question.pick !== 'one' || !next.responses.some((r) => r.questionId === question.id && r.chose.length)) return
    if (complete(decision.questions, next)) {
      onSend(next)
      return
    }
    window.setTimeout(() => setAt(Math.min(index + 1, decision.questions.length - 1)), 260)
  }

  return (
    <div
      className="overflow-hidden rounded-card bg-surface shadow-card"
      style={{ animation: 'bui-fade-up 300ms var(--bui-ease-out-strong) both' }}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium leading-tight text-ink">{decision.title}</p>
            <p className="mt-1 truncate text-[11.5px] leading-tight text-ink-3">
              {decision.source}
              {expiry ? ` · ${expiry.expired ? 'Expired' : `Expires ${expiry.text}`}` : ''}
            </p>
          </div>
          {onDismiss ? (
            <button
              type="button"
              aria-label="Answer later"
              onClick={onDismiss}
              className="grid size-6 shrink-0 place-items-center rounded-chip text-ink-3
                         transition-colors hover:bg-fill hover:text-ink"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        {decision.detail ? (
          <p className="mt-2 whitespace-pre-line text-[12px] leading-snug text-ink-2">{decision.detail}</p>
        ) : null}

        <div key={question.id} style={{ animation: 'bui-fade-up 280ms var(--bui-ease-out-strong) both' }}>
          <p className="mt-3 text-[13px] font-medium leading-snug text-ink">{question.ask}</p>
          <Choices
            question={question}
            answer={answer}
            onPick={pick}
            onWrite={(text) => setAnswer(write(answer, question.id, text))}
          />
        </div>
      </div>

      {/* The pager and the send control share a footer, because they are the
          same decision seen two ways: how much is left, and whether it can go. */}
      <div className="flex items-center justify-between border-t border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <Step
            label="Previous"
            disabled={index === 0 || sending}
            onClick={() => setAt(Math.max(0, index - 1))}
          >
            <ChevronLeft size={14} />
          </Step>
          <div className="flex items-center gap-1">
            {decision.questions.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                aria-label={`Question ${i + 1}`}
                aria-current={i === index ? 'step' : undefined}
                disabled={sending}
                onClick={() => setAt(i)}
                className="rounded-full transition-all duration-300"
                style={i === index
                  ? { width: 9, height: 9, border: '2.5px solid var(--bui-ink)' }
                  : said(answer, entry.id)
                    ? { width: 7, height: 7, background: 'var(--bui-ink-3)' }
                    : { width: 7, height: 7, border: '1.5px solid var(--bui-ink-3)' }}
              />
            ))}
          </div>
          <Step
            label="Next"
            disabled={last || sending}
            onClick={() => setAt(Math.min(decision.questions.length - 1, index + 1))}
          >
            <ChevronRight size={14} />
          </Step>
        </div>

        {onSend ? (
        <button
          type="button"
          aria-label={ready ? 'Send answer' : 'Next question'}
          disabled={sending || (!ready && last)}
          onClick={() => (ready ? onSend(answer) : setAt(Math.min(decision.questions.length - 1, index + 1)))}
          className="grid size-7 place-items-center rounded-control transition-[background-color,color,transform]
                     duration-200 enabled:active:scale-[0.96] disabled:cursor-default"
          style={{
            background: ready ? 'var(--bui-ink)' : 'var(--bui-field)',
            color: ready ? 'var(--bui-surface)' : 'var(--bui-ink-3)',
            boxShadow: ready ? 'inset 0 1px 0 rgb(255 255 255 / 0.14)' : 'var(--bui-shadow-btn)',
          }}
        >
          {sending ? <Check size={14} /> : ready ? <ArrowUp size={14} /> : <ChevronRight size={14} />}
        </button>
        ) : (
          <span className="text-[11.5px] leading-none text-ink-3">Waiting on somebody else</span>
        )}
      </div>
    </div>
  )
}

function Choices({
  question, answer, onPick, onWrite,
}: {
  question: DecisionQuestion
  answer: DecisionAnswer
  onPick: (value: string) => void
  onWrite: (text: string) => void
}) {
  const response = responseFor(answer, question.id)
  const written = response?.said ?? ''

  if ('text' in question) {
    return (
      <input
        value={written}
        onChange={(event) => onWrite(event.target.value)}
        placeholder={question.text.placeholder ?? 'Type your answer…'}
        aria-label={question.ask}
        className="mt-2 w-full rounded-control bg-field px-2.5 py-2 text-[13px] text-ink outline-none
                   placeholder:text-ink-3 focus:shadow-btn"
      />
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {question.options.map((option) => {
        const on = response?.chose.includes(option.value) ?? false
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(option.value)}
            className="-mx-1.5 flex items-center gap-2 rounded-control px-1.5 py-1 text-left
                       transition-colors hover:bg-fill"
          >
            {/* Round for one, square for many — the oldest convention there is
                for "you may pick another", and the only thing telling a reader
                whether this choice replaces their last one. */}
            <span
              className={`grid size-4 shrink-0 place-items-center transition-colors duration-200
                          ${question.pick === 'one' ? 'rounded-full' : 'rounded-[5px]'}`}
              style={on
                ? { background: markColour(option.tone), color: 'var(--bui-surface)' }
                : { boxShadow: 'inset 0 0 0 1.5px var(--bui-line-strong)', color: 'transparent' }}
            >
              {question.pick === 'one'
                ? <span
                    className="size-1.5 rounded-full transition-transform duration-200"
                    style={{ background: 'var(--bui-surface)', transform: on ? 'scale(1)' : 'scale(0)' }}
                  />
                : <Check size={11} strokeWidth={3} />}
            </span>
            <span className={`text-[13px] transition-colors duration-200 ${on ? 'text-ink' : 'text-ink-2'}`}>
              {option.label}
            </span>
          </button>
        )
      })}

      {question.allowText ? (
        <label className="-mx-1.5 flex items-center gap-2 rounded-control px-1.5 py-1
                          transition-colors focus-within:bg-fill hover:bg-fill">
          <span aria-hidden className="size-4 shrink-0" />
          <input
            value={written}
            onChange={(event) => onWrite(event.target.value)}
            placeholder="Something else…"
            aria-label={`${question.ask} — your own answer`}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
      ) : null}
    </div>
  )
}

/** The option that stops the work is the one place this card spends red. */
function markColour(tone: 'default' | 'primary' | 'danger' | undefined): string {
  return tone === 'danger' ? 'var(--bui-red)' : 'var(--bui-ink)'
}

function Step({
  label, disabled, onClick, children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-chip text-ink-3 transition-colors
                 enabled:hover:bg-fill enabled:hover:text-ink-2 disabled:opacity-35"
    >
      {children}
    </button>
  )
}
