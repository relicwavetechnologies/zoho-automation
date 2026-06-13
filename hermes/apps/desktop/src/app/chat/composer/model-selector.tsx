import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { HermesGateway } from '@/hermes'
import { Brain, ChevronDown } from '@/lib/icons'
import { formatModelStatusLabel, visibleReasoningPill } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'
import { $currentFastMode, $currentModel, $currentReasoningEffort } from '@/store/session'

import { useModelControls } from '../../session/hooks/use-model-controls'
import { ModelMenuPanel } from '../../shell/model-menu-panel'

const THINKING_PILL_TONE_CLASS = {
  high: 'border-[color-mix(in_srgb,var(--ui-thinking-high)_48%,transparent)] bg-[color-mix(in_srgb,var(--ui-thinking-high)_18%,transparent)] text-[#f0d09a]',
  max: 'border-[color-mix(in_srgb,var(--ui-thinking-max)_48%,transparent)] bg-[color-mix(in_srgb,var(--ui-thinking-max)_18%,transparent)] text-[#e7b7be]'
} as const

/**
 * In-composer model + thinking-mode selector. Mirrors the status-bar model
 * summary (label = model + reasoning effort, dropdown = ModelMenuPanel which
 * carries both model selection and the reasoning/thinking submenu), but lives
 * inline in the composer footer like the reference composer.
 *
 * Self-contained: reads model state from the global stores and builds its own
 * gateway request wrapper + model controls, so it needs nothing drilled in from
 * the desktop controller.
 */
export function ComposerModelSelector({
  disabled,
  gateway,
  sessionId
}: {
  disabled?: boolean
  gateway: HermesGateway | null
  sessionId: string | null
}) {
  const queryClient = useQueryClient()
  const currentModel = useStore($currentModel)
  const currentReasoningEffort = useStore($currentReasoningEffort)
  const currentFastMode = useStore($currentFastMode)

  const requestGateway = useCallback(
    <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (!gateway) {
        return Promise.reject(new Error('Hermes gateway unavailable'))
      }

      return gateway.request<T>(method, params)
    },
    [gateway]
  )

  const { selectModel } = useModelControls({
    activeSessionId: sessionId,
    queryClient,
    requestGateway
  })

  const label = formatModelStatusLabel(currentModel, {
    fastMode: currentFastMode,
    reasoningEffort: currentReasoningEffort
  })

  const reasoningPill = visibleReasoningPill(currentReasoningEffort)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Model and thinking mode"
          className={cn(
            'h-(--composer-control-size) max-w-[14rem] shrink-0 gap-1.5 rounded-full px-2 text-xs',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
            'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
          )}
          disabled={disabled}
          title="Switch model or thinking mode"
          type="button"
          variant="ghost"
        >
          {reasoningPill ? (
            <span
              className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[0.6875rem] font-medium leading-none',
                THINKING_PILL_TONE_CLASS[reasoningPill.tone]
              )}
            >
              <Brain className="size-3" stroke={1.65} />
              {reasoningPill.label}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{label || 'Model'}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-0" side="top" sideOffset={8}>
        <ModelMenuPanel gateway={gateway ?? undefined} onSelectModel={selectModel} requestGateway={requestGateway} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
