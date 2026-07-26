import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { route } from '@/constants/routes'

/**
 * HeaderPage is where the "open sidebar" control lives, and the sidebar is the
 * app's only navigation. A page inside the app shell that renders its own
 * full-height layout instead of HeaderPage therefore strands anyone who
 * collapses the sidebar while on it: no nav, and no way to bring it back short
 * of restarting the app. The Tools pages shipped exactly that way.
 *
 * The three routes below open in their own windows via LogsLayout, which has no
 * sidebar to reopen. Everything else goes through AppLayout and needs the
 * titlebar.
 */

const ROUTES_DIR = join(__dirname, '..')

const OWN_WINDOW_ROUTES = new Set([
  `${route.appLogs}.tsx`.slice(1),
  `${route.systemMonitor}.tsx`.slice(1),
  `${route.localApiServerlogs}.tsx`.slice(1),
])

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [full] : []
  })
}

describe('routes inside the app shell', () => {
  const pages = routeFiles(ROUTES_DIR)
    .map(file => relative(ROUTES_DIR, file))
    // __root.tsx is the shell itself, not a page within it.
    .filter(file => file !== '__root.tsx' && !OWN_WINDOW_ROUTES.has(file))

  it('finds the route files to check', () => {
    expect(pages).toContain('plugins/index.tsx')
    expect(pages).toContain(join('plugins', '$pluginId.tsx'))
    expect(pages.length).toBeGreaterThan(15)
  })

  it.each(pages)('%s renders HeaderPage, so the sidebar can always be reopened', page => {
    const source = readFileSync(join(ROUTES_DIR, page), 'utf8')
    expect(source).toMatch(/from '@\/containers\/HeaderPage'/)
    expect(source).toMatch(/<HeaderPage[\s/>]/)
  })
})
