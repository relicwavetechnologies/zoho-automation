import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import SettingsMenu from '../SettingsMenu'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('SettingsMenu', () => {
  it('shows only Divo-supported settings sections', () => {
    render(<SettingsMenu />)

    expect(screen.getByText('common:general')).toBeInTheDocument()
    expect(screen.getByText('common:appearance')).toBeInTheDocument()
    expect(screen.getByText('common:hardware')).toBeInTheDocument()
    expect(screen.getByText('Divo Dex')).toBeInTheDocument()
  })

  it('hides legacy Jan, local-model, and provider navigation', () => {
    render(<SettingsMenu />)

    expect(screen.queryByText('common:assistants')).not.toBeInTheDocument()
    expect(screen.queryByText('common:attachments')).not.toBeInTheDocument()
    expect(screen.queryByText('common:local_api_server')).not.toBeInTheDocument()
    expect(screen.queryByText('common:https_proxy')).not.toBeInTheDocument()
    expect(screen.queryByText('common:keyboardShortcuts')).not.toBeInTheDocument()
    expect(screen.queryByText('common:privacy')).not.toBeInTheDocument()
    expect(screen.queryByText('common:mcp-servers')).not.toBeInTheDocument()
    expect(screen.queryByText('common:claude_code')).not.toBeInTheDocument()
    expect(screen.queryByText('common:modelProviders')).not.toBeInTheDocument()
  })
})
