import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pluginId: 'google-workspace',
  getInventory: vi.fn(),
  invoke: vi.fn(),
  navigate: vi.fn(),
  openUrl: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => ({ ...config, useParams: () => ({ pluginId: h.pluginId }) }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => h.navigate,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: h.openUrl }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('lucide-react', () => {
  const Icon = () => null
  return { ArrowLeft: Icon, Brain: Icon, Building2: Icon, CalendarDays: Icon, Check: Icon, ChevronRight: Icon, Cpu: Icon, ExternalLink: Icon, FileSearch: Icon, Globe: Icon, KeyRound: Icon, Lock: Icon, MessageSquare: Icon, Plus: Icon, RefreshCw: Icon, RotateCw: Icon, ScanSearch: Icon, Search: Icon, Share2: Icon, ShieldCheck: Icon, SquareTerminal: Icon, Trash2: Icon, User: Icon, Users: Icon }
})
vi.mock('@/components/ui/button', () => ({ Button: ({ children, asChild: _asChild, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => <button {...props}>{children}</button> }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))
vi.mock('@/lib/divo-tools', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/divo-tools')>(),
  getDivoToolsInventory: h.getInventory,
  getDivoToolManageSnapshot: vi.fn(),
  setDivoGlobalToolAction: vi.fn(),
  setDivoDepartmentRoleToolAction: vi.fn(),
  setDivoDepartmentMemberToolAction: vi.fn(),
}))
vi.mock('@/lib/plugins', () => ({
  getPlugin: (id: string) => ({
    'google-workspace': { id, name: 'Google Workspace', description: 'Google tools', icon: () => <svg aria-label="Google provider logo" />, accentClassName: '', iconClassName: '' },
    canva: { id, name: 'Canva', description: 'Canva tools', icon: () => <svg aria-label="Canva provider logo" />, accentClassName: '', iconClassName: '' },
    zoho: { id, name: 'Zoho', description: 'Zoho tools', icon: () => <svg aria-label="Zoho provider logo" />, accentClassName: '', iconClassName: '' },
    'lark-personal': { id, name: 'Lark Personal', description: 'Lark tools', icon: () => <svg aria-label="Lark provider logo" />, accentClassName: '', iconClassName: '' },
  })[id] ?? null,
  googleWorkspaceServices: [],
}))
vi.mock('@/constants/routes', () => ({ route: { plugins: { index: '/plugins' }, settings: { divo: '/settings/divo' } } }))
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }))

import { PluginDetailRoute } from '../$pluginId'

const baseTool = {
  tool: { toolId: 'googleDrive', name: 'Google Drive', description: 'Files', category: 'files', domain: 'google', hitlRequired: false },
  origins: [{ kind: 'global', allowedActions: ['read'] }],
  managementScopes: [],
  readiness: 'ready',
}

const connectedSession = { configured: true, backendUrl: 'https://divo.example.com', email: 'ada@example.com', name: 'Ada' }

const googleStatus = {
  success: true,
  data: {
    connected: true,
    connections: [{ connectionId: 'google-1', label: 'Work Gmail', accountEmail: 'ada@example.com', accountName: 'Ada', ownerType: 'company', access: 'admin', scopes: ['https://www.googleapis.com/auth/gmail.modify'], connectedAt: '2026-07-01T00:00:00.000Z', lastUsedAt: '2026-07-12T00:00:00.000Z' }],
  },
}

const zohoStatus = {
  success: true,
  data: {
    connected: true,
    canManage: true,
    connections: [{ connectionId: 'zoho-1', label: 'Zoho Finance', accountEmail: 'finance@example.com', accountName: 'Finance', ownerType: 'company', access: 'admin', scopes: ['ZohoCRM.modules.ALL'], connectedAt: '2026-07-01T00:00:00.000Z', lastUsedAt: '2026-07-12T00:00:00.000Z' }],
    legacyConnection: null,
  },
}

const canvaStatus = {
  success: true,
  data: {
    connected: true,
    connections: [{ connectionId: 'canva-1', label: 'Brand Design Team', accountEmail: null, accountName: null, ownerType: 'company', access: 'admin', scopes: ['design:content:read'], connectedAt: '2026-07-01T00:00:00.000Z', lastUsedAt: '2026-07-12T00:00:00.000Z' }],
  },
}

const connectedLarkStatus = { installed: true, configured: true, connected: true, accountLabel: 'Ada at Acme', statusText: 'Connected to Acme Lark.', cliPath: '/app/lark-cli', homePath: '/app/lark-home', usesConfiguredApp: true, version: '1.2.3' }

function commandCalls(command: string) {
  return h.invoke.mock.calls.filter(([calledCommand]) => calledCommand === command)
}

describe('PluginDetailRoute inventory-gated presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.pluginId = 'google-workspace'
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve({ configured: false })
      if (command === 'divo_lark_local_status') return Promise.resolve({ bundled: false, configured: false, authenticated: false, accountLabel: null, cliVersion: null, binaryPath: null, homeDir: null, usesConfiguredApp: false })
      return Promise.resolve({ success: true })
    })
  })

  it('shows loading while the authorised inventory is pending', () => {
    h.getInventory.mockReturnValue(new Promise(() => {}))
    render(<PluginDetailRoute />)
    expect(screen.getByText('Loading tool details')).toBeInTheDocument()
  })

  it('rejects a detail URL absent from the authorised inventory', async () => {
    h.getInventory.mockResolvedValue({ tools: [] })
    render(<PluginDetailRoute />)
    expect(await screen.findByText('Tool unavailable')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Tools' })).toHaveAttribute('href', '/plugins')
  })

  it('retains an inventory error with an in-place retry', async () => {
    h.getInventory.mockRejectedValueOnce(new Error('inventory offline')).mockResolvedValueOnce({ tools: [] })
    render(<PluginDetailRoute />)
    expect(await screen.findByText('Could not load tools')).toBeInTheDocument()
    expect(screen.getByText('Error: inventory offline')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Tool unavailable')).toBeInTheDocument()
    expect(h.getInventory).toHaveBeenCalledTimes(2)
  })

  it('loads one connected Google session/status and does not refetch after its state settles', async () => {
    h.getInventory.mockResolvedValue({ tools: [baseTool] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_google_status') return Promise.resolve(googleStatus)
      return Promise.resolve({ success: true })
    })
    const view = render(<PluginDetailRoute />)

    expect((await screen.findAllByText('Work Gmail')).length).toBeGreaterThan(0)
    expect(screen.getByText('Gmail read/write')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tool access' })).toBeInTheDocument()
    view.rerender(<PluginDetailRoute />)
    await waitFor(() => {
      expect(commandCalls('divo_get_session_status')).toHaveLength(1)
      expect(commandCalls('divo_google_status')).toHaveLength(1)
    })
  })

  it('reconnects and disconnects only the selected Google connection', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)
    h.getInventory.mockResolvedValue({ tools: [baseTool] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_google_status') return Promise.resolve(googleStatus)
      if (command === 'divo_google_authorize_url') return Promise.resolve('https://accounts.google.com/reconnect')
      if (command === 'divo_google_disconnect_connection') return Promise.resolve({ success: true })
      return Promise.resolve({ success: true })
    })
    render(<PluginDetailRoute />)

    const reconnectButton = await screen.findByRole('button', { name: 'Reconnect Work Gmail' })
    fireEvent.click(reconnectButton)
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith(
      'https://accounts.google.com/reconnect',
      '_blank',
      'noopener,noreferrer',
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Work Gmail' }))
    expect(screen.getByRole('heading', { name: 'Disconnect Google Workspace?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect connection' }))
    await waitFor(() => expect(commandCalls('divo_google_disconnect_connection')).toEqual([
      ['divo_google_disconnect_connection', { connectionId: 'google-1', connection_id: 'google-1' }],
    ]))
  })

  it('uses the same managed connection flow for Canva', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)
    h.pluginId = 'canva'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'canvaDesign', name: 'Canva Design', description: 'Designs' } }] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_canva_status') return Promise.resolve(canvaStatus)
      if (command === 'divo_canva_authorize_url') return Promise.resolve('https://mcp.canva.com/authorize')
      if (command === 'divo_canva_disconnect_connection') return Promise.resolve({ success: true })
      return Promise.resolve({ success: true })
    })
    render(<PluginDetailRoute />)

    expect((await screen.findAllByText('Brand Design Team')).length).toBeGreaterThan(0)
    expect(screen.getByText('design:content:read')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Brand Design Team' }))
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith(
      'https://mcp.canva.com/authorize',
      '_blank',
      'noopener,noreferrer',
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Brand Design Team' }))
    expect(screen.getByRole('heading', { name: 'Disconnect Canva?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect connection' }))
    await waitFor(() => expect(commandCalls('divo_canva_disconnect_connection')).toEqual([
      ['divo_canva_disconnect_connection', { connectionId: 'canva-1', connection_id: 'canva-1' }],
    ]))
  })

  it('surfaces Google auth remediation without retrying status in a loop', async () => {
    h.getInventory.mockResolvedValue({ tools: [baseTool] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_google_status') return Promise.reject(new Error('invalid or expired token'))
      return Promise.resolve({ success: true })
    })
    render(<PluginDetailRoute />)

    expect(await screen.findByText('Connect Divo to manage Google Workspace')).toBeInTheDocument()
    expect(screen.getByText('Divo session expired. Reconnect Divo to continue.')).toBeInTheDocument()
    expect(commandCalls('divo_get_session_status')).toHaveLength(1)
    expect(commandCalls('divo_google_status')).toHaveLength(1)
  })

  it('shows an ordinary Google error and only retries when requested', async () => {
    h.getInventory.mockResolvedValue({ tools: [baseTool] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_google_status') return Promise.reject(new Error('Google service unavailable'))
      return Promise.resolve({ success: true })
    })
    render(<PluginDetailRoute />)

    expect(await screen.findByText('Could not load Google connections')).toBeInTheDocument()
    expect(screen.getByText('Error: Google service unavailable')).toBeInTheDocument()
    expect(commandCalls('divo_get_session_status')).toHaveLength(1)
    expect(commandCalls('divo_google_status')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(commandCalls('divo_get_session_status')).toHaveLength(2)
      expect(commandCalls('divo_google_status')).toHaveLength(2)
    })
  })

  it('loads one connected Zoho status and keeps provider requests bounded', async () => {
    h.pluginId = 'zoho'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'zohoCrm', name: 'Zoho CRM' } }] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_zoho_status') return Promise.resolve(zohoStatus)
      return Promise.resolve({ success: true })
    })
    const view = render(<PluginDetailRoute />)

    expect((await screen.findAllByText('Zoho Finance')).length).toBeGreaterThan(0)
    expect(screen.getByText('ZohoCRM.modules.ALL')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tool access' })).toBeInTheDocument()
    view.rerender(<PluginDetailRoute />)
    await waitFor(() => {
      expect(commandCalls('divo_get_session_status')).toHaveLength(1)
      expect(commandCalls('divo_zoho_status')).toHaveLength(1)
    })
  })

  it('reconnects and disconnects only the selected Zoho connection', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)
    h.pluginId = 'zoho'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'zohoCrm', name: 'Zoho CRM' } }] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_zoho_status') return Promise.resolve(zohoStatus)
      if (command === 'divo_zoho_authorize_url') return Promise.resolve('https://accounts.zoho.com/reconnect')
      if (command === 'divo_zoho_disconnect_connection') return Promise.resolve({ success: true })
      return Promise.resolve({ success: true })
    })
    render(<PluginDetailRoute />)

    const reconnectButton = await screen.findByRole('button', { name: 'Reconnect Zoho Finance' })
    fireEvent.click(reconnectButton)
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith(
      'https://accounts.zoho.com/reconnect',
      '_blank',
      'noopener,noreferrer',
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Zoho Finance' }))
    expect(screen.getByRole('heading', { name: 'Disconnect Zoho?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect connection' }))
    await waitFor(() => expect(commandCalls('divo_zoho_disconnect_connection')).toEqual([
      ['divo_zoho_disconnect_connection', { connectionId: 'zoho-1', connection_id: 'zoho-1' }],
    ]))
  })

  it('shows Zoho error remediation and only retries when requested', async () => {
    h.pluginId = 'zoho'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'zohoCrm', name: 'Zoho CRM' } }] })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'divo_get_session_status') return Promise.resolve(connectedSession)
      if (command === 'divo_zoho_status') return Promise.reject(new Error('Zoho unavailable'))
      return Promise.resolve({ success: true })
    })
    render(<PluginDetailRoute />)

    expect(await screen.findByText('Could not load Zoho')).toBeInTheDocument()
    expect(commandCalls('divo_get_session_status')).toHaveLength(1)
    expect(commandCalls('divo_zoho_status')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(commandCalls('divo_get_session_status')).toHaveLength(2)
      expect(commandCalls('divo_zoho_status')).toHaveLength(2)
    })
  })

  it('loads one connected Lark status and does not refetch after its state settles', async () => {
    h.pluginId = 'lark-personal'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'larkTask', name: 'Lark Tasks' } }] })
    h.invoke.mockImplementation((command: string) => command === 'divo_lark_local_status' ? Promise.resolve(connectedLarkStatus) : Promise.resolve({ success: true }))
    const view = render(<PluginDetailRoute />)

    expect(await screen.findByText('Ada at Acme')).toBeInTheDocument()
    expect(screen.getByText('Connected to Acme Lark.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tool access' })).toBeInTheDocument()
    view.rerender(<PluginDetailRoute />)
    await waitFor(() => expect(commandCalls('divo_lark_local_status')).toHaveLength(1))
  })

  it('shows Lark bundling remediation with one bounded status request', async () => {
    h.pluginId = 'lark-personal'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'larkTask', name: 'Lark Tasks' } }] })
    h.invoke.mockImplementation((command: string) => command === 'divo_lark_local_status' ? Promise.resolve({ ...connectedLarkStatus, installed: false, configured: false, connected: false }) : Promise.resolve({ success: true }))
    render(<PluginDetailRoute />)

    expect(await screen.findByText('Lark CLI is not bundled yet')).toBeInTheDocument()
    expect(commandCalls('divo_lark_local_status')).toHaveLength(1)
  })

  it('keeps a rejected Lark status distinct and only retries when requested', async () => {
    h.pluginId = 'lark-personal'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'larkTask', name: 'Lark Tasks' } }] })
    let statusAttempt = 0
    h.invoke.mockImplementation((command: string) => {
      if (command !== 'divo_lark_local_status') return Promise.resolve({ success: true })
      statusAttempt++
      return statusAttempt === 1 ? Promise.reject(new Error('Lark status unavailable')) : Promise.resolve(connectedLarkStatus)
    })
    render(<PluginDetailRoute />)

    expect(await screen.findByText('Could not read Lark status')).toBeInTheDocument()
    expect(screen.getByText('Error: Lark status unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Lark CLI is not bundled yet')).not.toBeInTheDocument()
    expect(screen.getAllByText('Unknown')).toHaveLength(3)
    expect(commandCalls('divo_lark_local_status')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Ada at Acme')).toBeInTheDocument()
    expect(commandCalls('divo_lark_local_status')).toHaveLength(2)
  })

  it('renders an authorised fallback tool as a standalone access page', async () => {
    h.pluginId = 'tool-customTool'
    h.getInventory.mockResolvedValue({ tools: [{ ...baseTool, tool: { ...baseTool.tool, toolId: 'customTool', name: 'Custom Tool' } }] })
    render(<PluginDetailRoute />)

    expect(await screen.findByRole('heading', { name: 'Custom Tool', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tool access' })).toBeInTheDocument()
    expect(screen.getByText('Origin · Global · read')).toBeInTheDocument()
    expect(screen.getByText('Actions · read')).toBeInTheDocument()
    const back = screen.getByRole('button', { name: 'Back to Tools' })
    back.click()
    expect(h.navigate).toHaveBeenCalledWith({ to: '/plugins' })
    expect(screen.queryByText('Plugin not found')).not.toBeInTheDocument()
  })
})
