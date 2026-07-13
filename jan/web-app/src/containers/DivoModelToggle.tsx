import { useEffect } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DIVO_MODELS, useDivoModel } from '@/hooks/useDivoModel'
import { cn } from '@/lib/utils'

/**
 * Input-bar model switch for Divo. Renders nothing unless the signed-in member
 * is allowed more than one model by the admin — so a single-model member sees
 * no control at all. The proxy backend remains authoritative on each request.
 */
export function DivoModelToggle({ disabled }: { disabled?: boolean }) {
  const allowedModels = useDivoModel((state) => state.allowedModels)
  const selectedModel = useDivoModel((state) => state.selectedModel)
  const loaded = useDivoModel((state) => state.loaded)
  const setModel = useDivoModel((state) => state.setModel)
  const refreshOptions = useDivoModel((state) => state.refreshOptions)

  useEffect(() => {
    if (!loaded) void refreshOptions()
  }, [loaded, refreshOptions])

  if (allowedModels.length < 2) return null

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border bg-secondary/40 p-0.5',
        disabled && 'pointer-events-none opacity-50'
      )}
      role="group"
      aria-label="Model"
    >
      {allowedModels.map((model) => {
        const active = model === selectedModel
        return (
          <Tooltip key={model}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => void setModel(model)}
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {DIVO_MODELS[model].label}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{DIVO_MODELS[model].hint}</p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
