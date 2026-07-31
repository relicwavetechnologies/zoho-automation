import {
  Brain,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import {
  memoryReviewTargetKey,
  PI_MEMORY_REVIEW_MAX_REVISION_LENGTH,
  type PiMemoryReviewRequest,
  type PiMemoryReviewResponse,
} from '@/lib/pi/memory-review'

type MemoryReviewCardProps = {
  request: PiMemoryReviewRequest
  position: number
  total: number
  onMove: (direction: -1 | 1) => void
  onSubmit: (response: PiMemoryReviewResponse) => void
}

export function MemoryReviewCard({
  request,
  position,
  total,
  onMove,
  onSubmit,
}: MemoryReviewCardProps) {
  const { descriptor } = request
  const [selectedIds, setSelectedIds] = useState(() =>
    descriptor.bullets.map((bullet) => bullet.id)
  )
  const [selectedTargetKey, setSelectedTargetKey] = useState(() =>
    memoryReviewTargetKey(descriptor.allowedTargets[0])
  )
  const [revision, setRevision] = useState('')
  const submitting = request.status === 'submitting'
  const selectedTarget = useMemo(
    () =>
      descriptor.allowedTargets.find(
        (target) => memoryReviewTargetKey(target) === selectedTargetKey
      ),
    [descriptor.allowedTargets, selectedTargetKey]
  )
  const targetValue = selectedTarget
    ? {
        scope: selectedTarget.scope,
        ...(selectedTarget.departmentId
          ? { departmentId: selectedTarget.departmentId }
          : {}),
      }
    : null

  const response = (
    decision: PiMemoryReviewResponse['decision']
  ): PiMemoryReviewResponse => ({
    version: 1,
    proposalId: descriptor.proposalId,
    decision,
    selectedTarget: decision === 'cancel' ? null : targetValue,
    selectedBulletIds: decision === 'cancel' ? [] : selectedIds,
    ...(decision === 'revise' ? { revision: revision.trim() } : {}),
  })

  return (
    <Card
      className="overflow-hidden rounded-3xl border-input bg-card shadow-none"
      data-testid="memory-review-card"
    >
      <CardHeader className="flex-row items-start justify-between gap-4 p-4 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Brain className="size-5" />
          </div>
          <div className="min-w-0">
            <CardDescription className="mb-1 flex items-center gap-1.5 text-xs">
              <ShieldCheck className="size-3.5" />
              Share memory · Review required
            </CardDescription>
            <CardTitle className="text-base font-medium leading-6 tracking-normal">
              Remember this conversation
            </CardTitle>
            <CardDescription className="mt-1 leading-5">
              Review the durable facts Divo will save and where they will be
              available.
            </CardDescription>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {position + 1} / {total}
          </span>
          <ButtonGroup>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={total < 2 || submitting}
              aria-label="Previous pending review"
              onClick={() => onMove(-1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={total < 2 || submitting}
              aria-label="Next pending review"
              onClick={() => onMove(1)}
            >
              <ChevronRight />
            </Button>
          </ButtonGroup>
        </div>
      </CardHeader>

      <Separator />

      <CardContent className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Available to
          <select
            aria-label="Memory target"
            className="h-10 rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            value={selectedTargetKey}
            disabled={submitting}
            onChange={(event) => setSelectedTargetKey(event.target.value)}
          >
            {descriptor.allowedTargets.map((target) => (
              <option key={memoryReviewTargetKey(target)} value={memoryReviewTargetKey(target)}>
                {target.label}
              </option>
            ))}
          </select>
          <span className="text-xs font-normal leading-5 text-muted-foreground">
            These choices come from your current backend permissions and will
            be checked again before saving.
          </span>
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Facts to remember</p>
            <span className="text-xs tabular-nums text-muted-foreground">
              {selectedIds.length} of {descriptor.bullets.length} selected
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto rounded-xl border border-border/70 bg-background">
            {descriptor.bullets.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No durable facts were proposed. Ask Divo for a different
                proposal below.
              </p>
            ) : (
              descriptor.bullets.map((bullet, index) => {
                const selected = selectedIds.includes(bullet.id)
                return (
                  <div key={bullet.id}>
                    {index > 0 ? <Separator /> : null}
                    <div
                      className={
                        selected
                          ? 'flex items-start gap-3 p-3'
                          : 'flex items-start gap-3 bg-muted/30 p-3 opacity-60'
                      }
                    >
                      <span className="mt-0.5 text-sm text-muted-foreground">•</span>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5">
                        {bullet.text}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={submitting}
                        aria-label={
                          selected
                            ? `Remove memory: ${bullet.text}`
                            : `Restore memory: ${bullet.text}`
                        }
                        onClick={() =>
                          setSelectedIds((current) =>
                            selected
                              ? current.filter((id) => id !== bullet.id)
                              : [...current, bullet.id]
                          )
                        }
                      >
                        {selected ? <X /> : <RefreshCw />}
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Propose something different
          <Textarea
            aria-label="Memory revision"
            className="max-h-32 min-h-20 resize-y rounded-xl"
            maxLength={PI_MEMORY_REVIEW_MAX_REVISION_LENGTH}
            placeholder="Tell Divo what to remember instead"
            value={revision}
            disabled={submitting}
            onChange={(event) => setRevision(event.target.value)}
          />
        </label>

        {request.status === 'error' ? (
          <p className="text-sm text-destructive" role="alert">
            Your choice was not delivered. Divo remains paused. {request.error}
          </p>
        ) : null}
      </CardContent>

      <Separator />

      <CardFooter className="flex flex-col-reverse gap-2 p-3 sm:flex-row sm:items-center sm:justify-end">
        <Button
          variant="ghost"
          disabled={submitting}
          onClick={() => onSubmit(response('cancel'))}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={submitting || !revision.trim()}
          onClick={() => onSubmit(response('revise'))}
        >
          <RefreshCw data-icon="inline-start" />
          Propose a different memory
        </Button>
        <Button
          disabled={submitting || selectedIds.length === 0 || !selectedTarget}
          onClick={() => onSubmit(response('approve'))}
        >
          {submitting ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Brain data-icon="inline-start" />
          )}
          Remember {selectedIds.length}{' '}
          {selectedIds.length === 1 ? 'fact' : 'facts'}
        </Button>
      </CardFooter>
    </Card>
  )
}
