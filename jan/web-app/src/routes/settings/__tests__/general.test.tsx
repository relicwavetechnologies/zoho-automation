import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
}))

vi.mock('@/constants/routes', () => ({
  route: { settings: { general: '/settings/general' } },
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}))

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <nav>Settings menu</nav>,
}))

vi.mock('@/containers/Card', () => ({
  Card: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <section aria-label={String(title)}>{children}</section>
  ),
  CardItem: ({ title, actions }: { title: React.ReactNode; actions: React.ReactNode }) => (
    <div><span>{title}</span>{actions}</div>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { Route as GeneralRoute } from '../general'

describe('General Settings Route', () => {
  it('renders only the application version', () => {
    const Component = GeneralRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getByText('settings:general.appVersion')).toBeInTheDocument()
    expect(screen.getByText(`v${VERSION}`)).toBeInTheDocument()
    expect(screen.queryByText('settings:general.autoUpdateCheck')).not.toBeInTheDocument()
    expect(screen.queryByText('common:language')).not.toBeInTheDocument()
    expect(screen.queryByText('common:dataFolder')).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
  })
})
