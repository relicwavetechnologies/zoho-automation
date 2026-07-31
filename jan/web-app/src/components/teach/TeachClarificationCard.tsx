import {
  Check,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  LoaderCircle,
  Plus,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type {
  PiTeachClarificationQuestion,
  PiTeachClarificationRequest,
  PiTeachClarificationResponse,
} from '@/lib/pi/teach-clarification'
import { cn } from '@/lib/utils'

type TeachClarificationCardProps = {
  request: PiTeachClarificationRequest
  position: number
  total: number
  onMove: (direction: -1 | 1) => void
  onSubmit: (response: PiTeachClarificationResponse) => void
}

type Selections = Record<string, string[]>
type CustomAnswers = Record<string, string>

const isAnswered = (
  question: PiTeachClarificationQuestion,
  selected: Selections,
  custom: CustomAnswers
) =>
  (selected[question.id]?.length ?? 0) > 0 ||
  Boolean(custom[question.id]?.trim())

export function TeachClarificationCard({
  request,
  position,
  total,
  onMove,
  onSubmit,
}: TeachClarificationCardProps) {
  const { descriptor } = request
  const [selected, setSelected] = useState<Selections>({})
  const [customAnswers, setCustomAnswers] = useState<CustomAnswers>({})
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({})
  const submitting = request.status === 'submitting'

  // Answering a question scrolls the next unanswered one into view, so a
  // multi-question card never needs to be taller than a couple of rows.
  const questionRefs = useRef<Record<string, HTMLElement | null>>({})
  const footerRef = useRef<HTMLDivElement | null>(null)

  const answeredCount = useMemo(
    () =>
      descriptor.questions.filter((question) =>
        isAnswered(question, selected, customAnswers)
      ).length,
    [customAnswers, descriptor.questions, selected]
  )
  const complete = answeredCount === descriptor.questions.length

  const advanceFrom = (
    questionId: string,
    nextSelected: Selections,
    nextCustom: CustomAnswers
  ) => {
    const index = descriptor.questions.findIndex((q) => q.id === questionId)
    const next = descriptor.questions
      .slice(index + 1)
      .find((question) => !isAnswered(question, nextSelected, nextCustom))
    const target = next ? questionRefs.current[next.id] : footerRef.current
    // Guarded: jsdom has no scrollIntoView.
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }

  const toggleOption = (
    question: PiTeachClarificationQuestion,
    optionId: string
  ) => {
    const existing = selected[question.id] ?? []
    const nextForQuestion =
      question.selection === 'single'
        ? [optionId]
        : existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId]
    const next = { ...selected, [question.id]: nextForQuestion }
    setSelected(next)
    // Multi-select stays put — the manager may still be picking.
    if (question.selection === 'single') {
      advanceFrom(question.id, next, customAnswers)
    }
  }

  const answerResponse = (): PiTeachClarificationResponse => ({
    version: 1,
    decision: 'answer',
    answers: descriptor.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: selected[question.id] ?? [],
      ...(customAnswers[question.id]?.trim()
        ? { customText: customAnswers[question.id].trim() }
        : {}),
    })),
  })

  const multiQuestion = descriptor.questions.length > 1

  return (
    <Card
      className="gap-0 overflow-hidden rounded-2xl border-violet-500/25 bg-card p-0 shadow-none"
      data-testid="teach-clarification-card"
    >
      <div className="flex items-start justify-between gap-3 px-3.5 pt-3 pb-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-violet-500">
            <GraduationCap className="size-3.5 shrink-0" />
            Teach · Quick check
          </p>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            {descriptor.reason}
          </p>
        </div>
        {total > 1 ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {position + 1}/{total}
            </span>
            <ButtonGroup>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={submitting}
                aria-label="Previous pending question"
                onClick={() => onMove(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={submitting}
                aria-label="Next pending question"
                onClick={() => onMove(1)}
              >
                <ChevronRight />
              </Button>
            </ButtonGroup>
          </div>
        ) : null}
      </div>

      <div className="max-h-[38vh] space-y-4 overflow-y-auto px-3.5 pb-3">
        {descriptor.questions.map((question, questionIndex) => {
          const answered = isAnswered(question, selected, customAnswers)
          return (
            <fieldset
              key={question.id}
              disabled={submitting}
              ref={(node) => {
                questionRefs.current[question.id] = node
              }}
              className="scroll-mt-2"
            >
              <legend className="flex w-full items-center gap-2 text-[13px] font-medium leading-5">
                {multiQuestion ? (
                  <span
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded-full text-[10px] tabular-nums transition-colors',
                      answered
                        ? 'bg-violet-500 text-white'
                        : 'bg-muted text-muted-foreground'
                    )}
                    aria-hidden
                  >
                    {answered ? (
                      <Check className="size-2.5" />
                    ) : (
                      questionIndex + 1
                    )}
                  </span>
                ) : null}
                <span className="min-w-0">{question.question}</span>
              </legend>
              {question.whyItMatters ? (
                <p
                  className={cn(
                    'mt-0.5 text-xs leading-4 text-muted-foreground',
                    multiQuestion && 'pl-6'
                  )}
                >
                  {question.whyItMatters}
                </p>
              ) : null}

              <div className={cn('mt-2 space-y-1', multiQuestion && 'pl-6')}>
                {question.options.map((option) => {
                  const isSelected = selected[question.id]?.includes(option.id)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={isSelected}
                      disabled={submitting}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                        isSelected
                          ? 'border-violet-500/45 bg-violet-500/10'
                          : 'border-transparent bg-muted/40 hover:bg-muted/70'
                      )}
                      onClick={() => toggleOption(question, option.id)}
                    >
                      <span
                        className={cn(
                          'grid size-4 shrink-0 place-items-center border transition-colors',
                          question.selection === 'single'
                            ? 'rounded-full'
                            : 'rounded-[4px]',
                          isSelected
                            ? 'border-violet-500 bg-violet-500 text-white'
                            : 'border-muted-foreground/35'
                        )}
                      >
                        {isSelected ? <Check className="size-2.5" /> : null}
                      </span>
                      <span className="min-w-0 text-[13px] leading-5">
                        <span className="font-medium">{option.label}</span>
                        {option.description ? (
                          <span className="text-muted-foreground">
                            {' — '}
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}

                {/* Collapsed until asked for: an always-visible textarea cost
                    more height than the options themselves. */}
                {question.allowCustom ? (
                  customOpen[question.id] ? (
                    <Input
                      autoFocus
                      aria-label={`Custom answer for ${question.question}`}
                      className="h-8 rounded-lg text-[13px]"
                      maxLength={1_000}
                      placeholder="Something else…"
                      value={customAnswers[question.id] ?? ''}
                      disabled={submitting}
                      onChange={(event) =>
                        setCustomAnswers((currentAnswers) => ({
                          ...currentAnswers,
                          [question.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        advanceFrom(question.id, selected, {
                          ...customAnswers,
                          [question.id]: event.currentTarget.value,
                        })
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={submitting}
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() =>
                        setCustomOpen((current) => ({
                          ...current,
                          [question.id]: true,
                        }))
                      }
                    >
                      <Plus className="size-3" />
                      Something else
                    </button>
                  )
                ) : null}
              </div>
            </fieldset>
          )
        })}

        {request.status === 'error' ? (
          <p className="text-[13px] text-destructive" role="alert">
            Your answers were not delivered. Divo remains paused. {request.error}
          </p>
        ) : null}
      </div>

      <div
        ref={footerRef}
        className="flex items-center justify-end gap-1 border-t border-border/60 px-2.5 py-2"
      >
        {multiQuestion ? (
          <span className="mr-auto pl-1 text-[11px] tabular-nums text-muted-foreground">
            {answeredCount}/{descriptor.questions.length} answered
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={submitting}
          onClick={() =>
            onSubmit({ version: 1, decision: 'cancel', answers: [] })
          }
        >
          Answer later
        </Button>
        <Button
          size="sm"
          disabled={submitting || !complete}
          onClick={() => onSubmit(answerResponse())}
        >
          {submitting ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Check data-icon="inline-start" />
          )}
          Continue teaching
        </Button>
      </div>
    </Card>
  )
}
