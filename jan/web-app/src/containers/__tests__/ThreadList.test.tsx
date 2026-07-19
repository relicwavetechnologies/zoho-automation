import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import ThreadList from '../ThreadList'
import { useAppState } from '@/hooks/useAppState'
import { useChatSessions } from '@/stores/chat-session-store'
import { usePiApproval } from '@/hooks/usePiApproval'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, title }: any) => (
    <a className={className} title={title}>
      {children}
    </a>
  ),
  useParams: ({ select }: any = {}) =>
    select ? select({ threadId: undefined }) : { threadId: undefined },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      deleteThread: vi.fn(),
      renameThread: vi.fn(),
      updateThread: vi.fn(),
    }),
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: (selector: any) =>
    selector({
      getMessages: () => [],
      setMessages: vi.fn(),
    }),
}))

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({
    folders: [],
    getFolderById: vi.fn(),
  }),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: any) => <div>{children}</div>,
  SidebarMenuAction: ({ children }: any) => <button>{children}</button>,
  useSidebar: () => ({ isMobile: false }),
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
  }
})

vi.mock('@/containers/dialogs', () => ({
  RenameThreadDialog: () => null,
  DeleteThreadDialog: () => null,
}))

const longUrl = 'https://example.com/' + 'a'.repeat(300)

const makeThread = (overrides: Partial<Thread> = {}): Thread =>
  ({
    id: 't1',
    title: longUrl,
    updated: 0,
    metadata: {},
    ...overrides,
  }) as Thread

const flushEffects = () => act(() => Promise.resolve())

const resetRuntimeStores = () => {
  useAppState.setState({
    busyThreads: {},
    streamingContents: {},
    loadingModels: {},
    cancelToolCalls: {},
    piThreadRunStates: {},
  })
  useChatSessions.setState({ sessions: {} })
  usePiApproval.setState({ queues: {} })
}

beforeEach(resetRuntimeStores)

describe('ThreadList — long-URL overflow guard (#7959)', () => {
  it('truncates non-project thread titles and exposes full text via title attribute', async () => {
    render(<ThreadList threads={[makeThread()]} />)
    await flushEffects()

    const titleSpans = screen
      .getAllByText(longUrl)
      .filter((el) => el.tagName === 'SPAN')
    expect(titleSpans.length).toBeGreaterThan(0)

    const titleEl = titleSpans[0]
    expect(titleEl).toHaveClass('block', 'truncate')
    expect(titleEl).toHaveAttribute('title', longUrl)
  })

  it('applies overflow guard on the project-view thread link wrapper', async () => {
    render(
      <ThreadList
        threads={[makeThread()]}
        currentProjectId="project-1"
      />
    )
    await flushEffects()

    const link = screen.getByText(longUrl).closest('a')
    expect(link).not.toBeNull()
    expect(link).toHaveClass('max-w-full', 'overflow-hidden')
  })

  it('falls back to the new-thread label when the title is empty and still truncates', async () => {
    render(<ThreadList threads={[makeThread({ title: '' })]} />)
    await flushEffects()

    const titleEl = screen
      .getAllByText('common:newThread')
      .find((el) => el.tagName === 'SPAN')
    expect(titleEl).toBeDefined()
    expect(titleEl).toHaveClass('block', 'truncate')
    expect(titleEl).toHaveAttribute('title', 'common:newThread')
  })
})

describe('ThreadList — Teach conversations', () => {
  it('shows a Teach badge only for a thread created by Teach mode', async () => {
    render(
      <ThreadList
        threads={[
          makeThread({
            id: 'teach-thread',
            metadata: {
              divoTeachProfile: {
                kind: 'teach',
                teachSessionId: 'teach-session-1',
                departmentId: 'department-1',
              },
            },
          }),
          makeThread({ id: 'normal-thread', title: 'A normal chat' }),
        ]}
      />
    )
    await flushEffects()

    expect(screen.getByTitle('Teach conversation')).toHaveTextContent('Teach')
    expect(screen.getAllByText('Teach')).toHaveLength(1)
  })
})

describe('ThreadList — reserved thread-state slot placement', () => {
  const titleSpan = () =>
    screen.getAllByText(longUrl).find((el) => el.tagName === 'SPAN')!

  const runVariant = (currentProjectId?: string) => {
    it(
      `renders a stable slot immediately before the title and keeps title ` +
        `layout unchanged across state changes (${
          currentProjectId ? 'project' : 'standard'
        } row)`,
      async () => {
        render(
          <ThreadList
            threads={[makeThread()]}
            currentProjectId={currentProjectId}
          />
        )
        await flushEffects()

        // Idle: a reserved-but-empty slot precedes the title.
        const idleSlot = titleSpan().previousElementSibling
        expect(idleSlot).not.toBeNull()
        expect(idleSlot).toHaveAttribute('data-thread-state', 'idle')
        expect(idleSlot).toHaveClass('h-4', 'w-3', 'shrink-0')
        expect(idleSlot).toHaveAttribute('aria-hidden', 'true')

        // Capture title geometry-bearing attributes before any state change.
        const titleClassBefore = titleSpan().className
        const titleAttrBefore = titleSpan().getAttribute('title')

        // Drive the thread to a visible state; the slot mutates in place.
        act(() => {
          useAppState.setState({ busyThreads: { t1: true } })
        })

        const activeSlot = titleSpan().previousElementSibling
        expect(activeSlot).toHaveAttribute('data-thread-state', 'running')
        expect(activeSlot).toHaveClass('h-4', 'w-3', 'shrink-0')

        // The title itself never changed its layout classes or label.
        expect(titleSpan().className).toBe(titleClassBefore)
        expect(titleSpan().getAttribute('title')).toBe(titleAttrBefore)

        // Back to idle: slot remains reserved (not inserted/removed).
        act(() => resetRuntimeStores())
        const backToIdle = titleSpan().previousElementSibling
        expect(backToIdle).toHaveAttribute('data-thread-state', 'idle')
        expect(titleSpan().className).toBe(titleClassBefore)
      }
    )
  }

  runVariant(undefined)
  runVariant('project-1')
})
