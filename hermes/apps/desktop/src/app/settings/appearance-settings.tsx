import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'

import { SegmentedControl } from '@/components/ui/segmented-control'
import { triggerHaptic } from '@/lib/haptics'
import { $toolViewMode, setToolViewMode } from '@/store/tool-view'

import { SettingsContent } from './primitives'

function SectionHead({ title, description, control }: { title: string; description: string; control?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="text-[length:var(--conversation-text-font-size)] font-medium">{title}</div>
        <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {description}
        </div>
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  )
}

export function AppearanceSettings() {
  const toolViewMode = useStore($toolViewMode)

  return (
    <SettingsContent>
      <div className="grid gap-8">
        <p className="max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          Desktop display preferences.
        </p>

        <section>
          <SectionHead
            control={
              <SegmentedControl
                onChange={id => {
                  triggerHaptic('selection')
                  setToolViewMode(id)
                }}
                options={
                  [
                    { id: 'product', label: 'Product' },
                    { id: 'technical', label: 'Technical' }
                  ] as const
                }
                value={toolViewMode}
              />
            }
            description="Product hides raw tool payloads; Technical shows full input/output."
            title="Tool Call Display"
          />
        </section>
      </div>
    </SettingsContent>
  )
}
