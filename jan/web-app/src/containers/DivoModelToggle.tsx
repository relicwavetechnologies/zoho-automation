import { Check, ChevronDown } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DIVO_MODELS, useDivoModel } from '@/hooks/useDivoModel'
import { cn } from '@/lib/utils'

/**
 * Input-bar model picker for Divo. Renders nothing unless the signed-in member
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label="Model"
          className={cn(
            'h-7 gap-1 px-2 text-xs font-normal text-muted-foreground',
            'hover:bg-accent/60 hover:text-foreground data-[state=open]:text-foreground'
          )}
        >
          {DIVO_MODELS[selectedModel].label}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {allowedModels.map((model) => (
          <DropdownMenuItem
            key={model}
            onSelect={() => void setModel(model)}
            className="items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm">{DIVO_MODELS[model].label}</p>
              <p className="text-xs text-muted-foreground">
                {DIVO_MODELS[model].hint}
              </p>
            </div>
            {model === selectedModel ? (
              <Check className="mt-0.5 size-4 shrink-0" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
