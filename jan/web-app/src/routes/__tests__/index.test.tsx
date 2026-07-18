/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  search: { threadModel: undefined as any },
  setCurrentThreadId: vi.fn(),
  useTools: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/' }),
  useSearch: () => h.search,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({ setCurrentThreadId: h.setCurrentThreadId }),
}))

vi.mock('@/hooks/useTools', () => ({
  useTools: h.useTools,
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ model, initialMessage }: any) => (
    <div data-testid="chat-input" data-initial={String(initialMessage)}>
      {model ? model.id : 'no-model'}
    </div>
  ),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => <div data-testid="header-page">{children}</div>,
}))

vi.mock('@/containers/DivoWorkspaceSelector', () => ({
  default: () => <div data-testid="workspace-selector" />,
}))

vi.mock('@/components/finance-quick-starts/FinanceQuickStarts', () => ({
  FinanceQuickStarts: () => <div data-testid="finance-quick-starts" />,
}))

vi.mock('@/components/teach/TeachMode', () => ({
  TeachMode: () => <div data-testid="teach-mode">Teach Divo how you work.</div>,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...c: any[]) => c.filter(Boolean).join(' '),
}))

vi.mock('@/constants/routes', () => ({
  route: { home: '/' },
}))

import { Route } from '../index'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('Index route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.search = { threadModel: undefined }
  })

  it('validateSearch returns threadModel from search params', () => {
    const tm = { id: 'm1', provider: 'p1' }
    const result = (Route as any).validateSearch({ threadModel: tm })
    expect(result.threadModel).toEqual(tm)
  })

  it('validateSearch handles missing threadModel', () => {
    const result = (Route as any).validateSearch({})
    expect(result.threadModel).toBeUndefined()
  })

  it('renders the Divo chat UI when no local or remote model is configured', () => {
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-selector')).toBeInTheDocument()
    expect(screen.getByText('chat:description')).toBeInTheDocument()
  })

  it('passes threadModel from search into ChatInput without exposing the model selector', () => {
    h.search = { threadModel: { id: 'gpt-x', provider: 'openai' } }
    renderComponent()
    expect(screen.getByTestId('workspace-selector')).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveTextContent('gpt-x')
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-initial', 'true')
  })

  it('calls setCurrentThreadId(undefined) and useTools on mount', () => {
    renderComponent()
    expect(h.setCurrentThreadId).toHaveBeenCalledWith(undefined)
    expect(h.useTools).toHaveBeenCalled()
  })

  it('opens the mock workflow learning experience from Automate mode', async () => {
    const user = userEvent.setup()
    renderComponent()

    await user.click(screen.getByTestId('automate-mode-toggle'))

    expect(screen.getByTestId('automate-mode')).toBeInTheDocument()
    expect(screen.getByText('Show Divo how your work gets done.')).toBeInTheDocument()
    expect(screen.getByTestId('start-workflow-recording')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()
  })

  it('opens the manager teaching experience from Teach mode', async () => {
    const user = userEvent.setup()
    renderComponent()

    await user.click(screen.getByTestId('teach-mode-toggle'))

    expect(screen.getByTestId('teach-mode')).toHaveTextContent('Teach Divo how you work.')
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()
  })
})
