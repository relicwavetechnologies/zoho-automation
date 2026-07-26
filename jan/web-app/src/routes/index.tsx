/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
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
import { useEffect } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { useWorkspaceMode } from '@/hooks/useWorkspaceMode'
import DivoWorkspaceSelector from '@/containers/DivoWorkspaceSelector'
import { TeachMode } from '@/components/teach/TeachMode'
import { HomeGreeting } from '@/components/home/HomeGreeting'
import { ConsistencyHeatmap } from '@/components/home/ConsistencyHeatmap'
import { Button } from '@/components/ui/button'
import { GraduationCap, MessageCircle } from 'lucide-react'

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
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const { setCurrentThreadId } = useThreads()
  // App-wide so the background Teach indicator can bring the manager back to
  // a recording or upload that is still running.
  const mode = useWorkspaceMode((state) => state.mode)
  const setMode = useWorkspaceMode((state) => state.setMode)
  useTools()

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  return (
    <div
      className="flex h-svh min-h-0 flex-col overflow-hidden"
      data-testid="home-route-shell"
    >
      <HeaderPage>
        <div className="flex w-full items-center justify-between gap-3 pr-4">
          <DivoWorkspaceSelector />
          <div className="flex items-center gap-2">
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
        </div>
      </HeaderPage>
      {mode === 'teach' ? (
        <div className="min-h-0 flex-1 border-t">
          <TeachMode />
        </div>
      ) : (
        <div className="h-full overflow-y-auto px-6">
          {/* Centres the block in the viewport, biased slightly above true
              centre by the heavier bottom padding. Grows into a normal scrolling
              column once the recents list makes it taller than the screen. */}
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center pt-12 pb-28">
            <HomeGreeting />

            <div className="mx-auto mt-10 w-full max-w-2xl">
              <ChatInput model={threadModel} initialMessage={true} />
            </div>

            <ConsistencyHeatmap />
          </div>
        </div>
      )}
    </div>
  )
}
