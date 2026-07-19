import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useThreads } from '@/hooks/useThreads'
import { NavChats } from '../NavChats'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/ThreadList', () => ({
  default: ({ threads }: { threads: Thread[] }) => (
    <div>
      {threads.map((thread) => (
        <span key={thread.id}>{thread.title}</span>
      ))}
    </div>
  ),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))

describe('NavChats', () => {
  beforeEach(() => {
    act(() => {
      useThreads.setState({
        threads: {},
        currentThreadId: undefined,
        searchIndex: null,
      })
    })
  })

  it('shows a newly inserted non-project thread in the sidebar', () => {
    act(() => {
      useThreads.getState().setThreads([
        {
          id: 'persisted-thread-id',
          title: 'hi',
          updated: 1,
        } as Thread,
      ])
    })

    render(<NavChats />)

    expect(screen.getByRole('heading', { name: 'common:chats' })).toBeInTheDocument()
    expect(screen.getByText('hi')).toBeInTheDocument()
  })

  // The label is the sticky element, so the overflow action has to be a child of
  // it. Hoisting it back out to the group would leave it behind when the header
  // pins to the top of the scroller.
  it('nests the overflow action inside the sticky group label', () => {
    act(() => {
      useThreads.getState().setThreads([
        { id: 'a', title: 'first', updated: 2 } as Thread,
        { id: 'b', title: 'second', updated: 1 } as Thread,
      ])
    })

    render(<NavChats />)

    const heading = screen.getByRole('heading', { name: /common:chats/ })
    expect(within(heading).getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  const teachThread = (id: string, title: string, updated: number) =>
    ({
      id,
      title,
      updated,
      metadata: {
        divoTeachProfile: {
          kind: 'teach',
          teachSessionId: `session-${id}`,
          departmentId: 'dept-1',
        },
      },
    }) as unknown as Thread

  it('splits Teach sessions into their own group', () => {
    act(() => {
      useThreads.getState().setThreads([
        { id: 'a', title: 'ordinary chat', updated: 3 } as Thread,
        teachThread('t1', 'teach one', 2),
        { id: 'b', title: 'another chat', updated: 1 } as Thread,
      ])
    })

    render(<NavChats />)

    const teachGroup = screen
      .getByRole('heading', { name: 'common:teachSessions' })
      .closest('section')!
    const chatsGroup = screen
      .getByRole('heading', { name: /common:chats/ })
      .closest('section')!

    expect(within(teachGroup).getByText('teach one')).toBeInTheDocument()
    expect(within(teachGroup).queryByText('ordinary chat')).not.toBeInTheDocument()
    expect(within(chatsGroup).getByText('ordinary chat')).toBeInTheDocument()
    expect(within(chatsGroup).getByText('another chat')).toBeInTheDocument()
    expect(within(chatsGroup).queryByText('teach one')).not.toBeInTheDocument()

    // Chats is the main list; Teach is the smaller collection below it.
    expect(
      chatsGroup.compareDocumentPosition(teachGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('omits the Teach group entirely when there are no Teach sessions', () => {
    act(() => {
      useThreads
        .getState()
        .setThreads([{ id: 'a', title: 'ordinary chat', updated: 1 } as Thread])
    })

    render(<NavChats />)

    expect(
      screen.queryByRole('heading', { name: 'common:teachSessions' })
    ).not.toBeInTheDocument()
  })
})
