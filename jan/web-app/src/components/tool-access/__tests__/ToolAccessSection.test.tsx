import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type React from 'react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getInventory: vi.fn(),
  getSnapshot: vi.fn(),
  setGlobal: vi.fn(),
  setDepartmentMember: vi.fn(),
  onUpdated: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => h.navigate,
}))
vi.mock('lucide-react', () => ({ ArrowRight: () => null, Brain: () => null, MessageSquare: () => null, RefreshCw: () => null, Search: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }))
vi.mock('@/components/ui/input', () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }))
vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, disabled }: { checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void }) => <button disabled={disabled} onClick={() => onCheckedChange(!checked)}>{checked ? 'on' : 'off'}</button>,
}))
vi.mock('@/constants/routes', () => ({ route: { plugins: { detail: '/plugins/$pluginId' } } }))
vi.mock('@/lib/divo-tools', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/divo-tools')>(),
  getDivoToolsInventory: h.getInventory,
  getDivoToolManageSnapshot: h.getSnapshot,
  setDivoGlobalToolAction: h.setGlobal,
  setDivoDepartmentRoleToolAction: vi.fn(),
  setDivoDepartmentMemberToolAction: h.setDepartmentMember,
}))
vi.mock('@/lib/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }))

import { ToolAccessSection } from '../ToolAccessSection'
import { PluginsRoute } from '@/routes/plugins/index'
import type { DivoToolInventoryItem, GlobalToolManageSnapshot, DepartmentToolManageSnapshot } from '@/lib/divo-tools'

const item: DivoToolInventoryItem = {
  tool: { toolId: 'googleDrive', name: 'Google Drive', description: 'Company files', category: 'files', domain: 'google', hitlRequired: false },
  origins: [{ kind: 'global', allowedActions: ['read'] }],
  managementScopes: [
    { kind: 'global', label: 'Global' },
    { kind: 'department', department: { id: 'operations', name: 'Operations' } },
  ],
  readiness: 'ready',
}

const globalSnapshot: GlobalToolManageSnapshot = {
  tool: item.tool,
  scope: { kind: 'global', label: 'Global' },
  supportedActions: ['read'],
  roles: [{ role: 'MEMBER', actions: [{ actionGroup: 'read', effectiveAllowed: false, storedAllowed: false, storedProvenance: 'override', clampReason: null }] }],
}

const reopenedGlobalSnapshot: GlobalToolManageSnapshot = {
  ...globalSnapshot,
  roles: [{ role: 'SUPER_ADMIN', actions: [{ actionGroup: 'read', effectiveAllowed: true, storedAllowed: true, storedProvenance: 'default', clampReason: null }] }],
}

const clampedGlobalSnapshot: GlobalToolManageSnapshot = {
  ...globalSnapshot,
  roles: [{ role: 'MEMBER', actions: [{ actionGroup: 'read', effectiveAllowed: false, storedAllowed: true, storedProvenance: 'override', clampReason: 'company_tool_disabled' }] }],
}

const departmentSnapshot: DepartmentToolManageSnapshot = {
  tool: item.tool,
  scope: { kind: 'department', department: { id: 'operations', name: 'Operations' } },
  supportedActions: ['read', 'create'], roles: [],
  members: [{ userId: 'member-1', name: 'Ada', email: 'ada@example.com', roleId: 'role-ops' }],
  roleActions: [], memberOverrides: [],
  memberActionStates: [
    { userId: 'member-1', actionGroup: 'read', configuredAllowed: true, configuredProvenance: 'member_override', effectiveAllowed: true, effectiveBlockReason: null, storedOverride: true, provenance: 'override' },
    { userId: 'member-1', actionGroup: 'create', configuredAllowed: false, configuredProvenance: 'member_override', effectiveAllowed: false, effectiveBlockReason: null, storedOverride: false, provenance: 'override' },
  ],
  roleActionStates: [],
  companyCeiling: [],
}

const clampedDepartmentSnapshot: DepartmentToolManageSnapshot = {
  ...departmentSnapshot,
  roles: [{ id: 'role-ops', name: 'Operator', slug: 'OPERATOR' }],
  roleActions: [{ roleId: 'role-ops', actionGroup: 'read', allowed: true }],
  roleActionStates: [
    { roleId: 'role-ops', actionGroup: 'read', configuredAllowed: true, configuredProvenance: 'department_role', companyPolicyStatus: 'company_tool_blocks_all_current_members' },
    { roleId: 'role-ops', actionGroup: 'create', configuredAllowed: false, configuredProvenance: 'default', companyPolicyStatus: 'company_tool_blocks_all_current_members' },
  ],
  memberActionStates: [
    { userId: 'member-1', actionGroup: 'read', configuredAllowed: true, configuredProvenance: 'member_override', effectiveAllowed: false, effectiveBlockReason: 'company_tool_disabled', storedOverride: true, provenance: 'override' },
    { userId: 'member-1', actionGroup: 'create', configuredAllowed: false, configuredProvenance: 'default', effectiveAllowed: false, effectiveBlockReason: 'company_tool_disabled', storedOverride: null, provenance: 'inherited' },
  ],
}

const actionDeniedDepartmentSnapshot: DepartmentToolManageSnapshot = {
  ...departmentSnapshot,
  memberActionStates: [
    { userId: 'member-1', actionGroup: 'read', configuredAllowed: true, configuredProvenance: 'member_override', effectiveAllowed: false, effectiveBlockReason: 'company_action_disabled', storedOverride: true, provenance: 'override' },
    departmentSnapshot.memberActionStates[1]!,
  ],
}

const unassignedRoleSnapshot: DepartmentToolManageSnapshot = {
  ...departmentSnapshot,
  members: [],
  memberActionStates: [],
  roles: [{ id: 'role-new', name: 'Future operators', slug: 'FUTURE_OPERATORS' }],
  roleActionStates: [
    { roleId: 'role-new', actionGroup: 'read', configuredAllowed: true, configuredProvenance: 'department_role', companyPolicyStatus: 'no_active_members' },
    { roleId: 'role-new', actionGroup: 'create', configuredAllowed: false, configuredProvenance: 'default', companyPolicyStatus: 'no_active_members' },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

async function renderAtGlobalScope() {
  h.getSnapshot.mockImplementation((_toolId: string, scope: { kind: string }) => Promise.resolve(scope.kind === 'global' ? globalSnapshot : departmentSnapshot))
  render(<ToolAccessSection items={[item]} onUpdated={h.onUpdated} />)
  await screen.findByText('Company role access')
}

async function switchToDepartment() {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'department:operations' } })
  await screen.findByText('Operations role access')
}

function RemountableSectionHarness() {
  const [mounted, setMounted] = useState(true)
  return <>
    <button onClick={() => setMounted(false)}>Leave detail page</button>
    <button onClick={() => setMounted(true)}>Reopen detail page</button>
    {mounted ? <ToolAccessSection items={[item]} onUpdated={h.onUpdated} /> : null}
  </>
}

describe('ToolAccessSection lifecycle and presentation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not replace the selected department snapshot with a stale global mutation success', async () => {
    const mutation = deferred<GlobalToolManageSnapshot>()
    h.setGlobal.mockReturnValueOnce(mutation.promise)
    await renderAtGlobalScope()
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    await switchToDepartment()

    await act(async () => mutation.resolve(globalSnapshot))

    await waitFor(() => expect(screen.getByText('Operations role access')).toBeInTheDocument())
    expect(screen.queryByText('Company role access')).not.toBeInTheDocument()
  })

  it('does not refresh a stale global scope after its mutation is rejected', async () => {
    const mutation = deferred<GlobalToolManageSnapshot>()
    h.setGlobal.mockReturnValueOnce(mutation.promise)
    await renderAtGlobalScope()
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    await switchToDepartment()

    await act(async () => mutation.reject(new Error('forbidden')))

    await waitFor(() => expect(screen.getByText('Operations role access')).toBeInTheDocument())
    expect(screen.queryByText('Could not load this scope')).not.toBeInTheDocument()
    expect(h.getSnapshot).toHaveBeenCalledTimes(2)
  })

  it('refreshes the current server snapshot after a rejected mutation', async () => {
    h.getSnapshot
      .mockResolvedValueOnce(globalSnapshot)
      .mockResolvedValueOnce(reopenedGlobalSnapshot)
    h.setGlobal.mockRejectedValueOnce(new Error('forbidden'))
    render(<ToolAccessSection items={[item]} onUpdated={h.onUpdated} />)
    await screen.findByText('MEMBER')

    fireEvent.click(screen.getByRole('button', { name: 'read' }))

    expect(await screen.findByText('Access changed or this update was rejected. Tool access was refreshed.')).toBeInTheDocument()
    expect(await screen.findByText('SUPER_ADMIN')).toBeInTheDocument()
    expect(h.getSnapshot).toHaveBeenCalledTimes(2)
    expect(h.onUpdated).toHaveBeenCalledTimes(1)
  })

  it('does not let a pre-close mutation affect a reopened matching Global scope', async () => {
    const mutation = deferred<GlobalToolManageSnapshot>()
    h.setGlobal.mockReturnValueOnce(mutation.promise)
    h.getSnapshot
      .mockResolvedValueOnce(globalSnapshot)
      .mockResolvedValueOnce(reopenedGlobalSnapshot)
    render(<RemountableSectionHarness />)
    await screen.findByText('MEMBER')
    fireEvent.click(screen.getByRole('button', { name: 'read' }))

    fireEvent.click(screen.getByRole('button', { name: 'Leave detail page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen detail page' }))
    await screen.findByText('SUPER_ADMIN')

    await act(async () => mutation.resolve(globalSnapshot))

    expect(screen.getByText('SUPER_ADMIN')).toBeInTheDocument()
    expect(screen.queryByText('MEMBER')).not.toBeInTheDocument()
  })

  it('does not let a Global mutation affect Global after switching through another scope', async () => {
    const mutation = deferred<GlobalToolManageSnapshot>()
    h.setGlobal.mockReturnValueOnce(mutation.promise)
    h.getSnapshot
      .mockResolvedValueOnce(globalSnapshot)
      .mockResolvedValueOnce(departmentSnapshot)
      .mockResolvedValueOnce(reopenedGlobalSnapshot)
    render(<ToolAccessSection items={[item]} onUpdated={h.onUpdated} />)
    await screen.findByText('MEMBER')
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    await switchToDepartment()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'global' } })
    await screen.findByText('SUPER_ADMIN')

    await act(async () => mutation.resolve(globalSnapshot))

    expect(screen.getByText('SUPER_ADMIN')).toBeInTheDocument()
    expect(screen.queryByText('MEMBER')).not.toBeInTheDocument()
  })

  it('renders server-returned inherited and explicit member access provenance', async () => {
    h.getSnapshot.mockResolvedValueOnce(departmentSnapshot)
    render(<ToolAccessSection items={[{ ...item, managementScopes: [item.managementScopes[1]!] }]} onUpdated={h.onUpdated} />)

    await screen.findByText('Ada')
    expect(screen.getAllByText('Explicit member exception')).toHaveLength(2)
    expect(screen.getByText('Configured access: Allow')).toBeInTheDocument()
    expect(screen.getByText('Configured access: Deny')).toBeInTheDocument()
    const memberCard = screen.getByText('Ada').parentElement
    expect(memberCard?.querySelectorAll('button')[0]).toHaveTextContent('on')
    expect(memberCard?.querySelectorAll('button')[1]).toHaveTextContent('off')
  })

  it('locks global action switches when the backend marks the company tool disabled', async () => {
    h.getSnapshot.mockResolvedValueOnce(clampedGlobalSnapshot)
    render(<ToolAccessSection items={[item]} onUpdated={h.onUpdated} />)

    await screen.findByText('Disabled by company tool policy')
    expect(screen.getByText('Stored action rule: Allow (override) — resumes when the company tool is enabled')).toBeInTheDocument()
    expect(screen.getByText('Effective access: Denied')).toBeInTheDocument()
    const action = screen.getByText('MEMBER').parentElement?.querySelector('button')
    expect(action).toBeDisabled()
    fireEvent.click(action!)
    expect(h.setGlobal).not.toHaveBeenCalled()
  })

  it('keeps department configuration editable while a company tool gate blocks effective access', async () => {
    h.getSnapshot.mockResolvedValueOnce(clampedDepartmentSnapshot)
    h.setDepartmentMember.mockResolvedValueOnce(clampedDepartmentSnapshot)
    render(<ToolAccessSection items={[{ ...item, managementScopes: [item.managementScopes[1]!] }]} onUpdated={h.onUpdated} />)

    await screen.findByText('Ada')
    const memberCard = screen.getByText('Ada').parentElement
    expect(memberCard).toHaveTextContent('Effective access: Denied')
    expect(memberCard).toHaveTextContent('Configured access: Allow')
    expect(screen.getByText('Configured role policy: Allow (role rule)')).toBeInTheDocument()
    expect(screen.getAllByText('Company tool policy blocks all current role members.')).toHaveLength(2)
    expect(screen.getByText('Operator').parentElement?.querySelectorAll('button')[0]).not.toBeDisabled()
    expect(screen.getAllByText('Blocked by company tool policy')).toHaveLength(2)
    const actions = memberCard?.querySelectorAll('button')
    expect(actions?.[0]).toHaveTextContent('on')
    expect(actions?.[0]).not.toBeDisabled()
    await act(async () => fireEvent.click(actions![0]!))
    expect(h.setDepartmentMember).toHaveBeenCalledWith('googleDrive', 'operations', 'member-1', 'read', false)
  })

  it('shows configured allow while a company action ceiling denies effective access', async () => {
    h.getSnapshot.mockResolvedValueOnce(actionDeniedDepartmentSnapshot)
    h.setDepartmentMember.mockResolvedValueOnce(actionDeniedDepartmentSnapshot)
    render(<ToolAccessSection items={[{ ...item, managementScopes: [item.managementScopes[1]!] }]} onUpdated={h.onUpdated} />)

    await screen.findByText('Ada')
    const memberCard = screen.getByText('Ada').parentElement
    expect(memberCard).toHaveTextContent('Configured access: Allow')
    expect(memberCard).toHaveTextContent('Effective access: Denied')
    expect(memberCard).toHaveTextContent('Blocked by company action policy')
    const action = memberCard?.querySelector('button')
    expect(action).toHaveTextContent('on')
    expect(action).not.toBeDisabled()
    await act(async () => fireEvent.click(action!))
    expect(h.setDepartmentMember).toHaveBeenCalledWith('googleDrive', 'operations', 'member-1', 'read', false)
  })

  it('explains that unassigned role configuration applies to future members', async () => {
    h.getSnapshot.mockResolvedValueOnce(unassignedRoleSnapshot)
    render(<ToolAccessSection items={[{ ...item, managementScopes: [item.managementScopes[1]!] }]} onUpdated={h.onUpdated} />)

    await screen.findByText('Future operators')
    expect(screen.getByText('Configured role policy: Allow (role rule)')).toBeInTheDocument()
    expect(screen.getAllByText('No active members in this role; policy applies to future members subject to company policy.')).toHaveLength(2)
    expect(screen.getByText('Future operators').parentElement?.querySelector('button')).not.toBeDisabled()
  })

  it('visibly explains a server-provided fixed policy reason', () => {
    render(<ToolAccessSection items={[{ ...item, origins: [{ kind: 'local', reason: 'Terminal commands require user approval.' }], managementScopes: [], readiness: 'not_applicable' }]} />)
    expect(screen.getByText('Origin · Local · Terminal commands require user approval.')).toBeInTheDocument()
  })

  it('renders a concise live-derived card summary and navigates to its detail route', async () => {
    const completeItem: DivoToolInventoryItem = {
      ...item,
      tool: { ...item.tool, hitlRequired: true },
      origins: [
        { kind: 'global', allowedActions: ['read'] },
        { kind: 'department', department: { id: 'operations', name: 'Operations' }, allowedActions: ['create'] },
        { kind: 'local', reason: 'Local approval policy.' },
        { kind: 'system', allowedActions: ['approve'], reason: 'System-owned policy.' },
      ],
      readiness: 'admin_connection_required',
    }
    h.getInventory.mockResolvedValueOnce({ tools: [completeItem] })
    render(<PluginsRoute />)

    const card = await screen.findByRole('button', { name: /Google Workspace/ })
    expect(screen.getByRole('img', { name: 'Gmail' })).toBeInTheDocument()
    expect(card).toHaveAttribute('data-child-count', '1')
    expect(card).toHaveClass('h-80', 'max-h-80', 'sm:h-72', 'sm:max-h-72', 'overflow-hidden')
    expect(card).toHaveTextContent('Access · 4 sources · 3 action groups')
    expect(card).toHaveTextContent('Management · 2 scopes · 1 approval-gated · 1 connection issue')
    expect(card).toHaveTextContent('Open details')
    expect(card).not.toHaveTextContent('Local approval policy.')

    fireEvent.click(card)
    expect(h.navigate).toHaveBeenCalledWith({ to: '/plugins/$pluginId', params: { pluginId: 'google-workspace' } })
  })

  it('keeps a high-child-count provider card fixed and bounds its preview', async () => {
    const childTools = [
      ['larkMessaging', 'Lark Messaging'],
      ['larkContacts', 'Lark Contacts'],
      ['larkTask', 'Lark Tasks'],
      ['larkCalendar', 'Lark Calendar'],
      ['larkDoc', 'Lark Docs'],
      ['larkBase', 'Lark Base'],
      ['larkApproval', 'Lark Approval'],
    ].map(([toolId, name]) => ({ ...item, tool: { ...item.tool, toolId, name } }))
    h.getInventory.mockResolvedValueOnce({ tools: childTools })
    render(<PluginsRoute />)

    const card = await screen.findByRole('button', { name: /Lark/ })
    expect(card).toHaveAttribute('data-child-count', '7')
    expect(card).toHaveClass('h-80', 'max-h-80', 'sm:h-72', 'sm:max-h-72', 'overflow-hidden')
    expect(card).toHaveTextContent('Lark Messaging · Lark Contacts · Lark Tasks · +4 more')
    expect(card).not.toHaveTextContent('Lark Calendar')
    expect(card).toHaveTextContent('Access · 7 sources · 1 action group')
    expect(card).toHaveTextContent('Management · 14 scopes · 0 approval-gated · 0 connection issues')
    expect(card.querySelectorAll('[data-tool-id]')).toHaveLength(0)
  })

  it('bounds pathological live strings at mobile and desktop widths while protecting the CTA', async () => {
    const longTitle = `Tool${'WithoutBreaks'.repeat(40)}`
    const longDescription = `Purpose${'UnbrokenServerContent'.repeat(40)}`
    h.getInventory.mockResolvedValueOnce({
      tools: [{ ...item, tool: { ...item.tool, toolId: 'pathologicalTool', name: longTitle, description: longDescription } }],
    })
    render(<PluginsRoute />)

    const card = await screen.findByRole('button', { name: /Open details/ })
    expect(card).toHaveClass('h-80', 'max-h-80', 'sm:h-72', 'sm:max-h-72', 'overflow-hidden')
    expect(card.querySelector('[data-card-content]')).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden')
    expect(card.querySelector('[data-card-title]')).toHaveClass('line-clamp-2', 'break-all')
    expect(card.querySelector('[data-card-purpose]')).toHaveClass('line-clamp-2', 'break-all')
    expect(card.querySelector('[data-card-preview]')).toHaveClass('line-clamp-2', 'break-all')
    expect(card.querySelectorAll('[data-card-summary] > span')).toHaveLength(2)
    expect(card.querySelector('[data-card-summary] > span')).toHaveClass('line-clamp-1', 'break-all')
    expect(card.querySelector('[data-card-action]')).toHaveClass('shrink-0')
    expect(card.querySelector('[data-card-action]')).toHaveTextContent('Open details')

    fireEvent.click(card)
    expect(h.navigate).toHaveBeenCalledWith({ to: '/plugins/$pluginId', params: { pluginId: 'tool-pathologicalTool' } })
  })

  it('does not let an older inventory response replace a newer refresh', async () => {
    const stale = deferred<{ tools: DivoToolInventoryItem[] }>()
    const fresh = deferred<{ tools: DivoToolInventoryItem[] }>()
    h.getInventory
      .mockResolvedValueOnce({ tools: [{ ...item, tool: { ...item.tool, toolId: 'googleDrive', name: 'Initial inventory' } }] })
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)
    render(<PluginsRoute />)
    await waitFor(() => expect(h.getInventory).toHaveBeenCalledTimes(1))
    await screen.findByText('Google Workspace')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(h.getInventory).toHaveBeenCalledTimes(3))
    await act(async () => fresh.resolve({ tools: [{ ...item, tool: { ...item.tool, toolId: 'zohoCrm', name: 'Fresh inventory' } }] }))
    await screen.findByText('Zoho')
    expect(screen.getByRole('img', { name: 'Zoho' })).toBeInTheDocument()

    await act(async () => stale.resolve({ tools: [{ ...item, tool: { ...item.tool, toolId: 'larkTask', name: 'Stale inventory' } }] }))
    expect(screen.getByText('Zoho')).toBeInTheDocument()
    expect(screen.queryByText('Lark')).not.toBeInTheDocument()
  })
})
