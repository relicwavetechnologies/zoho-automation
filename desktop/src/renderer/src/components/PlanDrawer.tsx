import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  LoaderCircle,
  ListChecks,
} from 'lucide-react'
import type { ExecutionPlan, ExecutionPlanTask } from '../types'
import { cn } from '../lib/utils'

function TaskIcon({ task }: { task: ExecutionPlanTask }): JSX.Element {
  switch (task.status) {
    case 'done':
      return <CheckCircle2 size={15} className="text-[hsl(143,61%,54%)]" />
    case 'running':
      return <LoaderCircle size={15} className="animate-spin text-[hsl(43,90%,62%)]" />
    case 'failed':
    case 'blocked':
      return <AlertTriangle size={15} className="text-[hsl(9,88%,64%)]" />
    case 'skipped':
      return <Circle size={15} className="text-[hsl(0,0%,35%)]" />
    default:
      return <Circle size={15} className="text-[hsl(0,0%,62%)]" />
  }
}

export function PlanDrawer({ plan }: { plan: ExecutionPlan }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [criteriaOpen, setCriteriaOpen] = useState(false)

  const completedCount = useMemo(
    () => plan.tasks.filter((task) => task.status === 'done').length,
    [plan.tasks],
  )

  const runningTaskId = plan.tasks.find((task) => task.status === 'running')?.id

  return (
    <div className="relative z-0 mb-[-12px] px-2">
      <div
        className={cn(
          'overflow-hidden rounded-[20px] border shadow-[0_14px_32px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.03)]',
          'border-[hsl(0,0%,16%)] bg-[linear-gradient(180deg,rgba(28,28,29,0.98),rgba(20,20,21,0.98))]',
        )}
      >
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[12px] font-medium tracking-[0.01em] text-[hsl(0,0%,68%)]">
              <ListChecks size={14} className="text-[hsl(0,0%,72%)]" />
              <span>{completedCount} out of {plan.tasks.length} tasks completed</span>
            </div>
            <p className="mt-1 truncate text-[14px] font-medium text-[hsl(0,0%,90%)]">
              {plan.goal}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(0,0%,20%)] bg-[hsl(0,0%,10%)] text-[hsl(0,0%,64%)] hover:text-[hsl(0,0%,84%)]"
            title={collapsed ? 'Expand plan' : 'Collapse plan'}
          >
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>

        {!collapsed && (
          <div className="border-t border-[hsl(0,0%,14%)] px-4 py-3">
            <div className="mb-4 rounded-2xl border border-[hsl(0,0%,14%)] bg-[hsl(0,0%,9%)] px-3 py-3">
              <button
                type="button"
                onClick={() => setCriteriaOpen((value) => !value)}
                className="flex w-full items-center justify-between gap-3 text-left"
                title={criteriaOpen ? 'Hide success criteria' : 'Show success criteria'}
              >
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[hsl(0,0%,48%)]">
                    Success Criteria
                  </div>
                  <div className="mt-1 text-[12px] text-[hsl(0,0%,58%)]">
                    {plan.successCriteria.length} item{plan.successCriteria.length === 1 ? '' : 's'}
                  </div>
                </div>
                {criteriaOpen ? (
                  <ChevronUp size={15} className="shrink-0 text-[hsl(0,0%,56%)]" />
                ) : (
                  <ChevronDown size={15} className="shrink-0 text-[hsl(0,0%,56%)]" />
                )}
              </button>

              {criteriaOpen && (
                <div className="mt-2 space-y-1.5">
                  {plan.successCriteria.map((criterion) => (
                    <div key={criterion} className="text-[12px] leading-5 text-[hsl(0,0%,72%)]">
                      {criterion}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              {plan.tasks.map((task, index) => (
                <div
                  key={task.id}
                  className={cn(
                    'flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors',
                    task.id === runningTaskId ? 'bg-[hsl(43,26%,11%)]' : 'bg-[hsla(0,0%,100%,0.01)]',
                  )}
                >
                  <div className="shrink-0">
                    <TaskIcon task={task} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-[13px] leading-5 text-[hsl(0,0%,90%)]',
                        task.status === 'done' && 'text-[hsl(0,0%,74%)] line-through decoration-[hsl(0,0%,45%)]',
                      )}
                    >
                      <span className="mr-1.5 text-[hsl(0,0%,50%)]">{index + 1}.</span>
                      {task.title}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
