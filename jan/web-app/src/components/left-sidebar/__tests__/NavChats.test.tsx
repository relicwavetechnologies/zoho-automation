import { act, render, screen } from '@testing-library/react'
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
})
