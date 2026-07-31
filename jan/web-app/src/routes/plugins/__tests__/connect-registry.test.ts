import { describe, expect, it, vi } from 'vitest'

// The route module is imported for its registry only. These mocks stand in for
// the host bindings it touches at module scope; nothing here is rendered.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => ({ ...config, useParams: () => ({ pluginId: '' }) }),
  Link: () => null,
  useNavigate: () => vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const { cloudProviders } = await import('../$pluginId')
const { getPlugin, PERSONAL_CONNECTABLE_PLUGIN_IDS } = await import('@/lib/plugins')

/**
 * The detail page draws the connect flow only when `cloudProviders` and the
 * `divoPlugins` catalogue both know the id — a provider missing from either one
 * falls through to the read-only access page, which is how Airtable shipped
 * with no way to connect. These assert the two registries agree.
 */
describe('connect flow registries', () => {
  const providerIds = Object.keys(cloudProviders)

  it('lists every connectable provider in the plugin catalogue', () => {
    const missing = providerIds.filter(pluginId => !getPlugin(pluginId))
    expect(missing).toEqual([])
  })

  it('keys each provider by its own pluginId', () => {
    const mismatched = providerIds.filter(pluginId => cloudProviders[pluginId as keyof typeof cloudProviders].pluginId !== pluginId)
    expect(mismatched).toEqual([])
  })

  it('offers a personally connectable group only where a connect flow exists', () => {
    const unreachable = PERSONAL_CONNECTABLE_PLUGIN_IDS.filter(pluginId => !providerIds.includes(pluginId))
    expect(unreachable).toEqual([])
  })

  it('reaches Airtable through both registries', () => {
    expect(cloudProviders.airtable.commands.authorize).toBe('divo_airtable_authorize_url')
    expect(getPlugin('airtable')?.name).toBe('Airtable')
  })
})
