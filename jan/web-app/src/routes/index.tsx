/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { cn } from '@/lib/utils'

import { route } from '@/constants/routes'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}
import { useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DivoWorkspaceSelector from '@/containers/DivoWorkspaceSelector'
import {
  FinanceQuickStarts,
  type FinanceQuickStartRequest,
} from '@/components/finance-quick-starts/FinanceQuickStarts'
import { AutomateMode } from '@/components/automate/AutomateMode'
import { TeachMode } from '@/components/teach/TeachMode'
import { Button } from '@/components/ui/button'
import { GraduationCap, MessageCircle, Workflow } from 'lucide-react'

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const { setCurrentThreadId } = useThreads()
  const [quickStartRequest, setQuickStartRequest] =
    useState<FinanceQuickStartRequest | null>(null)
  const [mode, setMode] = useState<'ask' | 'automate' | 'teach'>('ask')
  useTools()

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  return (
    <div className="flex h-full flex-col">
      <HeaderPage>
        <div className="flex w-full items-center justify-between gap-3 pr-4">
          <DivoWorkspaceSelector />
          <div className="relative z-30 flex items-center rounded-full border bg-muted/50 p-0.5" aria-label="Workspace mode">
            <Button
              type="button"
              size="sm"
              variant={mode === 'ask' ? 'secondary' : 'ghost'}
              className={cn('h-7 px-3 shadow-none', mode === 'ask' && 'bg-background shadow-xs')}
              onClick={() => setMode('ask')}
              aria-pressed={mode === 'ask'}
            >
              <MessageCircle /> Ask
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'automate' ? 'secondary' : 'ghost'}
              className={cn('h-7 px-3 shadow-none', mode === 'automate' && 'bg-background shadow-xs text-primary')}
              onClick={() => setMode('automate')}
              aria-pressed={mode === 'automate'}
              data-testid="automate-mode-toggle"
            >
              <Workflow /> Automate
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'teach' ? 'secondary' : 'ghost'}
              className={cn('h-7 px-3 shadow-none', mode === 'teach' && 'bg-background shadow-xs text-violet-500')}
              onClick={() => setMode('teach')}
              aria-pressed={mode === 'teach'}
              data-testid="teach-mode-toggle"
            >
              <GraduationCap /> Teach
            </Button>
          </div>
        </div>
      </HeaderPage>
      {mode === 'automate' ? (
        <div className="min-h-0 flex-1 border-t" data-testid="automate-mode">
          <AutomateMode />
        </div>
      ) : mode === 'teach' ? (
        <div className="min-h-0 flex-1 border-t">
          <TeachMode />
        </div>
      ) : (
        <div
          className={cn(
            'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3 py-8'
          )}
        >
          <div
            className={cn(
              'mx-auto w-full md:w-4/5 xl:w-4/6 -mt-10',
            )}
          >
            <div className={cn('text-center mb-4')}>
              <h1
                className={cn(
                  'text-2xl mt-2 font-studio font-medium',
                )}
              >
                {t('chat:description')}
              </h1>
            </div>
            <div className="flex-1 shrink-0">
              <ChatInput
                showSpeedToken={false}
                model={threadModel}
                initialMessage={true}
                quickStartRequest={quickStartRequest}
              />
            </div>
            <FinanceQuickStarts onSubmit={setQuickStartRequest} />
          </div>
        </div>
      )}
    </div>
  )
}
